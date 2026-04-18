// SQLite persistence for the backend paper-trading engine.
//
// Reuses the same polymarket.db file as the collector. New tables prefixed
// with `paper_` so they don't clash. WAL mode means the collector and the
// engine can read/write concurrently without locking each other out.

import Database from 'better-sqlite3'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, '..', 'polymarket.db')

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  initSchema(_db)
  return _db
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_engine_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL,
      started_at INTEGER,
      config_json TEXT,
      last_alloc_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_orders (
      id TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      status TEXT NOT NULL,
      posted_at INTEGER NOT NULL,
      posted_best_bid REAL,
      posted_best_ask REAL,
      closed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_paper_orders_status ON paper_orders(status);
    CREATE INDEX IF NOT EXISTS idx_paper_orders_token ON paper_orders(token_id);

    CREATE TABLE IF NOT EXISTS paper_fills (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      question TEXT NOT NULL,
      side TEXT NOT NULL,
      fill_price REAL NOT NULL,
      size REAL NOT NULL,
      hedge_price REAL NOT NULL,
      realised_pnl_usd REAL NOT NULL,
      maker_fee_usd REAL NOT NULL,
      taker_fee_usd REAL NOT NULL,
      filled_at INTEGER NOT NULL,
      hedge_order_id TEXT,
      hedge_status TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_paper_fills_filled_at ON paper_fills(filled_at DESC);

    CREATE TABLE IF NOT EXISTS paper_reward (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_earned_usd REAL NOT NULL,
      last_rate_per_day REAL NOT NULL,
      last_updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_positions (
      condition_id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      token_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      bid_order_id TEXT,
      ask_order_id TEXT,
      bid_price REAL NOT NULL,
      ask_price REAL NOT NULL,
      bid_size REAL NOT NULL,
      ask_size REAL NOT NULL,
      max_spread_dollars REAL NOT NULL,
      daily_pool REAL NOT NULL,
      mid_price REAL,
      best_bid REAL,
      best_ask REAL,
      reward_share_pct REAL NOT NULL,
      expected_rate_per_day REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Hourly total-reward snapshots (one row per hour, keyed by hour_epoch).
    CREATE TABLE IF NOT EXISTS paper_reward_hourly (
      hour_epoch INTEGER PRIMARY KEY,
      snapshot_at INTEGER NOT NULL,
      total_earned_usd REAL NOT NULL,
      rate_per_day REAL NOT NULL
    );

    -- Hourly per-position reward snapshots.
    CREATE TABLE IF NOT EXISTS paper_position_reward_hourly (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hour_epoch INTEGER NOT NULL,
      snapshot_at INTEGER NOT NULL,
      condition_id TEXT NOT NULL,
      question TEXT NOT NULL,
      reward_share_pct REAL NOT NULL,
      expected_rate_per_day REAL NOT NULL,
      earned_this_hour_usd REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pos_reward_hour ON paper_position_reward_hourly(hour_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_pos_reward_cid ON paper_position_reward_hourly(condition_id, hour_epoch DESC);
  `)

  // Seed singleton rows on first run.
  db.prepare(
    `INSERT OR IGNORE INTO paper_engine_state (id, state, started_at, config_json, last_alloc_at, updated_at)
     VALUES (1, 'idle', NULL, NULL, NULL, ?)`,
  ).run(Date.now())
  db.prepare(
    `INSERT OR IGNORE INTO paper_reward (id, total_earned_usd, last_rate_per_day, last_updated_at)
     VALUES (1, 0, 0, ?)`,
  ).run(Date.now())
}

// ── State ─────────────────────────────────────────────────────────────

export interface EngineStateRow {
  state: 'idle' | 'running' | 'stopping'
  startedAt: number | null
  configJson: string | null
  lastAllocAt: number | null
}

export function readEngineState(): EngineStateRow {
  const row = getDb()
    .prepare(`SELECT state, started_at, config_json, last_alloc_at FROM paper_engine_state WHERE id = 1`)
    .get() as { state: string; started_at: number | null; config_json: string | null; last_alloc_at: number | null }
  return {
    state: row.state as EngineStateRow['state'],
    startedAt: row.started_at,
    configJson: row.config_json,
    lastAllocAt: row.last_alloc_at,
  }
}

export function writeEngineState(s: EngineStateRow): void {
  getDb()
    .prepare(
      `UPDATE paper_engine_state
       SET state = ?, started_at = ?, config_json = ?, last_alloc_at = ?, updated_at = ?
       WHERE id = 1`,
    )
    .run(s.state, s.startedAt, s.configJson, s.lastAllocAt, Date.now())
}

// ── Reward ────────────────────────────────────────────────────────────

export interface RewardRow {
  totalEarnedUsd: number
  lastRatePerDay: number
  lastUpdatedAt: number
}

export function readReward(): RewardRow {
  const row = getDb()
    .prepare(`SELECT total_earned_usd, last_rate_per_day, last_updated_at FROM paper_reward WHERE id = 1`)
    .get() as { total_earned_usd: number; last_rate_per_day: number; last_updated_at: number }
  return {
    totalEarnedUsd: row.total_earned_usd,
    lastRatePerDay: row.last_rate_per_day,
    lastUpdatedAt: row.last_updated_at,
  }
}

export function writeReward(r: RewardRow): void {
  getDb()
    .prepare(
      `UPDATE paper_reward SET total_earned_usd = ?, last_rate_per_day = ?, last_updated_at = ? WHERE id = 1`,
    )
    .run(r.totalEarnedUsd, r.lastRatePerDay, r.lastUpdatedAt)
}

export function resetReward(now: number): void {
  writeReward({ totalEarnedUsd: 0, lastRatePerDay: 0, lastUpdatedAt: now })
}

// ── Orders ────────────────────────────────────────────────────────────

export interface OrderRow {
  id: string
  conditionId: string
  tokenId: string
  outcome: string
  side: 'bid' | 'ask'
  price: number
  size: number
  status: 'resting' | 'filled' | 'cancelled'
  postedAt: number
  postedBestBid: number | null
  postedBestAsk: number | null
  closedAt: number | null
}

export function insertOrder(o: OrderRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO paper_orders
       (id, condition_id, token_id, outcome, side, price, size, status, posted_at, posted_best_bid, posted_best_ask, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.id, o.conditionId, o.tokenId, o.outcome, o.side, o.price, o.size, o.status,
      o.postedAt, o.postedBestBid, o.postedBestAsk, o.closedAt,
    )
}

export function updateOrderStatus(id: string, status: OrderRow['status'], closedAt: number): void {
  getDb()
    .prepare(`UPDATE paper_orders SET status = ?, closed_at = ? WHERE id = ?`)
    .run(status, closedAt, id)
}

export function readRecentOrders(limit = 500): OrderRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, condition_id, token_id, outcome, side, price, size, status, posted_at,
              posted_best_bid, posted_best_ask, closed_at
       FROM paper_orders
       ORDER BY posted_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
      id: string; condition_id: string; token_id: string; outcome: string; side: 'bid' | 'ask';
      price: number; size: number; status: 'resting' | 'filled' | 'cancelled'; posted_at: number;
      posted_best_bid: number | null; posted_best_ask: number | null; closed_at: number | null
    }>
  return rows.map((r) => ({
    id: r.id, conditionId: r.condition_id, tokenId: r.token_id, outcome: r.outcome, side: r.side,
    price: r.price, size: r.size, status: r.status, postedAt: r.posted_at,
    postedBestBid: r.posted_best_bid, postedBestAsk: r.posted_best_ask, closedAt: r.closed_at,
  }))
}

export function cancelAllRestingOrders(now: number): void {
  getDb()
    .prepare(`UPDATE paper_orders SET status = 'cancelled', closed_at = ? WHERE status = 'resting'`)
    .run(now)
}

// ── Fills ─────────────────────────────────────────────────────────────

export interface FillRow {
  id: string
  orderId: string
  conditionId: string
  question: string
  side: 'bid' | 'ask'
  fillPrice: number
  size: number
  hedgePrice: number
  realisedPnlUsd: number
  makerFeeUsd: number
  takerFeeUsd: number
  filledAt: number
  hedgeOrderId: string | null
  hedgeStatus: 'pending' | 'done' | 'failed'
}

export function insertFill(f: FillRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO paper_fills
       (id, order_id, condition_id, question, side, fill_price, size, hedge_price,
        realised_pnl_usd, maker_fee_usd, taker_fee_usd, filled_at, hedge_order_id, hedge_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      f.id, f.orderId, f.conditionId, f.question, f.side, f.fillPrice, f.size, f.hedgePrice,
      f.realisedPnlUsd, f.makerFeeUsd, f.takerFeeUsd, f.filledAt, f.hedgeOrderId, f.hedgeStatus,
    )
}

export function updateFillHedge(id: string, hedgeOrderId: string | null, hedgeStatus: FillRow['hedgeStatus']): void {
  getDb()
    .prepare(`UPDATE paper_fills SET hedge_order_id = ?, hedge_status = ? WHERE id = ?`)
    .run(hedgeOrderId, hedgeStatus, id)
}

export function readRecentFills(limit = 200): FillRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, order_id, condition_id, question, side, fill_price, size, hedge_price,
              realised_pnl_usd, maker_fee_usd, taker_fee_usd, filled_at, hedge_order_id, hedge_status
       FROM paper_fills
       ORDER BY filled_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
      id: string; order_id: string; condition_id: string; question: string; side: 'bid' | 'ask';
      fill_price: number; size: number; hedge_price: number;
      realised_pnl_usd: number; maker_fee_usd: number; taker_fee_usd: number;
      filled_at: number; hedge_order_id: string | null; hedge_status: 'pending' | 'done' | 'failed'
    }>
  return rows.map((r) => ({
    id: r.id, orderId: r.order_id, conditionId: r.condition_id, question: r.question, side: r.side,
    fillPrice: r.fill_price, size: r.size, hedgePrice: r.hedge_price,
    realisedPnlUsd: r.realised_pnl_usd, makerFeeUsd: r.maker_fee_usd, takerFeeUsd: r.taker_fee_usd,
    filledAt: r.filled_at, hedgeOrderId: r.hedge_order_id, hedgeStatus: r.hedge_status,
  }))
}

export function clearFills(): void {
  getDb().prepare(`DELETE FROM paper_fills`).run()
}

export function readAllFills(limit = 10_000): FillRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, order_id, condition_id, question, side, fill_price, size, hedge_price,
              realised_pnl_usd, maker_fee_usd, taker_fee_usd, filled_at, hedge_order_id, hedge_status
       FROM paper_fills
       ORDER BY filled_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
      id: string; order_id: string; condition_id: string; question: string; side: 'bid' | 'ask';
      fill_price: number; size: number; hedge_price: number;
      realised_pnl_usd: number; maker_fee_usd: number; taker_fee_usd: number;
      filled_at: number; hedge_order_id: string | null; hedge_status: 'pending' | 'done' | 'failed'
    }>
  return rows.map((r) => ({
    id: r.id, orderId: r.order_id, conditionId: r.condition_id, question: r.question, side: r.side,
    fillPrice: r.fill_price, size: r.size, hedgePrice: r.hedge_price,
    realisedPnlUsd: r.realised_pnl_usd, makerFeeUsd: r.maker_fee_usd, takerFeeUsd: r.taker_fee_usd,
    filledAt: r.filled_at, hedgeOrderId: r.hedge_order_id, hedgeStatus: r.hedge_status,
  }))
}

// ── Positions ─────────────────────────────────────────────────────────

export interface PositionRow {
  conditionId: string
  question: string
  tokenId: string
  outcome: string
  bidOrderId: string | null
  askOrderId: string | null
  bidPrice: number
  askPrice: number
  bidSize: number
  askSize: number
  maxSpreadDollars: number
  dailyPool: number
  midPrice: number | null
  bestBid: number | null
  bestAsk: number | null
  rewardSharePct: number
  expectedRatePerDay: number
  updatedAt: number
}

export function upsertPosition(p: PositionRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO paper_positions
       (condition_id, question, token_id, outcome, bid_order_id, ask_order_id,
        bid_price, ask_price, bid_size, ask_size, max_spread_dollars, daily_pool,
        mid_price, best_bid, best_ask, reward_share_pct, expected_rate_per_day, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.conditionId, p.question, p.tokenId, p.outcome, p.bidOrderId, p.askOrderId,
      p.bidPrice, p.askPrice, p.bidSize, p.askSize, p.maxSpreadDollars, p.dailyPool,
      p.midPrice, p.bestBid, p.bestAsk, p.rewardSharePct, p.expectedRatePerDay, p.updatedAt,
    )
}

export function readPositions(): PositionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT condition_id, question, token_id, outcome, bid_order_id, ask_order_id,
              bid_price, ask_price, bid_size, ask_size, max_spread_dollars, daily_pool,
              mid_price, best_bid, best_ask, reward_share_pct, expected_rate_per_day, updated_at
       FROM paper_positions`,
    )
    .all() as Array<{
      condition_id: string; question: string; token_id: string; outcome: string;
      bid_order_id: string | null; ask_order_id: string | null;
      bid_price: number; ask_price: number; bid_size: number; ask_size: number;
      max_spread_dollars: number; daily_pool: number;
      mid_price: number | null; best_bid: number | null; best_ask: number | null;
      reward_share_pct: number; expected_rate_per_day: number; updated_at: number
    }>
  return rows.map((r) => ({
    conditionId: r.condition_id, question: r.question, tokenId: r.token_id, outcome: r.outcome,
    bidOrderId: r.bid_order_id, askOrderId: r.ask_order_id,
    bidPrice: r.bid_price, askPrice: r.ask_price, bidSize: r.bid_size, askSize: r.ask_size,
    maxSpreadDollars: r.max_spread_dollars, dailyPool: r.daily_pool,
    midPrice: r.mid_price, bestBid: r.best_bid, bestAsk: r.best_ask,
    rewardSharePct: r.reward_share_pct, expectedRatePerDay: r.expected_rate_per_day,
    updatedAt: r.updated_at,
  }))
}

export function deletePosition(conditionId: string): void {
  getDb().prepare(`DELETE FROM paper_positions WHERE condition_id = ?`).run(conditionId)
}

export function clearAllPositions(): void {
  getDb().prepare(`DELETE FROM paper_positions`).run()
}

// ── Hourly reward snapshots ───────────────────────────────────────────

export interface RewardHourlyRow {
  hourEpoch: number
  snapshotAt: number
  totalEarnedUsd: number
  ratePerDay: number
}

export interface PositionRewardHourlyRow {
  hourEpoch: number
  snapshotAt: number
  conditionId: string
  question: string
  rewardSharePct: number
  expectedRatePerDay: number
  earnedThisHourUsd: number
}

export function upsertRewardHourly(r: RewardHourlyRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO paper_reward_hourly
       (hour_epoch, snapshot_at, total_earned_usd, rate_per_day)
       VALUES (?, ?, ?, ?)`,
    )
    .run(r.hourEpoch, r.snapshotAt, r.totalEarnedUsd, r.ratePerDay)
}

export function insertPositionRewardHourly(rows: PositionRewardHourlyRow[]): void {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO paper_position_reward_hourly
     (hour_epoch, snapshot_at, condition_id, question, reward_share_pct, expected_rate_per_day, earned_this_hour_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const tx = db.transaction((rs: PositionRewardHourlyRow[]) => {
    for (const r of rs) stmt.run(r.hourEpoch, r.snapshotAt, r.conditionId, r.question, r.rewardSharePct, r.expectedRatePerDay, r.earnedThisHourUsd)
  })
  tx(rows)
}

export function readRewardHourly(limit = 168): RewardHourlyRow[] {
  const rows = getDb()
    .prepare(
      `SELECT hour_epoch, snapshot_at, total_earned_usd, rate_per_day
       FROM paper_reward_hourly ORDER BY hour_epoch DESC LIMIT ?`,
    )
    .all(limit) as Array<{ hour_epoch: number; snapshot_at: number; total_earned_usd: number; rate_per_day: number }>
  return rows.map((r) => ({
    hourEpoch: r.hour_epoch,
    snapshotAt: r.snapshot_at,
    totalEarnedUsd: r.total_earned_usd,
    ratePerDay: r.rate_per_day,
  }))
}

export function readPositionRewardHourly(conditionId?: string, limit = 168): PositionRewardHourlyRow[] {
  const db = getDb()
  const rows = conditionId
    ? (db
        .prepare(
          `SELECT hour_epoch, snapshot_at, condition_id, question, reward_share_pct, expected_rate_per_day, earned_this_hour_usd
           FROM paper_position_reward_hourly WHERE condition_id = ? ORDER BY hour_epoch DESC LIMIT ?`,
        )
        .all(conditionId, limit) as Array<Record<string, unknown>>)
    : (db
        .prepare(
          `SELECT hour_epoch, snapshot_at, condition_id, question, reward_share_pct, expected_rate_per_day, earned_this_hour_usd
           FROM paper_position_reward_hourly ORDER BY hour_epoch DESC LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>)
  return rows.map((r) => ({
    hourEpoch: r.hour_epoch as number,
    snapshotAt: r.snapshot_at as number,
    conditionId: r.condition_id as string,
    question: r.question as string,
    rewardSharePct: r.reward_share_pct as number,
    expectedRatePerDay: r.expected_rate_per_day as number,
    earnedThisHourUsd: r.earned_this_hour_usd as number,
  }))
}
