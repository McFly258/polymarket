// SQLite schema + helpers for the Polymarket rewards monitor.
// One DB file at the project root (gitignored). Mirrors the funding-rate pattern.

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
    CREATE TABLE IF NOT EXISTS markets (
      condition_id TEXT PRIMARY KEY,
      slug TEXT,
      question TEXT,
      end_date_iso TEXT,
      min_order_size REAL,
      min_tick_size REAL,
      tags TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      token_id TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      FOREIGN KEY(condition_id) REFERENCES markets(condition_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_condition ON tokens(condition_id);

    -- One row per (market, bucket). Captures the rewards config as advertised by
    -- the CLOB at the time of the snapshot — this can change as Polymarket tweaks
    -- pools during the day.
    CREATE TABLE IF NOT EXISTS reward_snapshots (
      condition_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      daily_rate REAL NOT NULL,
      min_size REAL NOT NULL,
      max_spread REAL NOT NULL,
      accepting_orders INTEGER NOT NULL,
      PRIMARY KEY (condition_id, ts)
    );

    CREATE INDEX IF NOT EXISTS idx_reward_ts ON reward_snapshots(ts);

    -- One row per (token, bucket). Stores best bid/ask/mid plus the aggregated
    -- qualifying depth within max_spread — the raw ingredient for monitoring
    -- how competitive a market is.
    CREATE TABLE IF NOT EXISTS book_snapshots (
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      best_bid REAL,
      best_ask REAL,
      mid REAL,
      spread REAL,
      qualifying_bid_size REAL NOT NULL,
      qualifying_ask_size REAL NOT NULL,
      total_bid_size REAL NOT NULL,
      total_ask_size REAL NOT NULL,
      PRIMARY KEY (token_id, ts)
    );

    CREATE INDEX IF NOT EXISTS idx_book_ts ON book_snapshots(ts);
  `)
}

// ── Market + token upserts ──

export interface MarketUpsert {
  conditionId: string
  slug: string
  question: string
  endDateIso: string | null
  minOrderSize: number
  minTickSize: number
  tags: string[]
  seenAt: number
}

export function upsertMarket(m: MarketUpsert) {
  const db = getDb()
  db.prepare(
    `INSERT INTO markets (condition_id, slug, question, end_date_iso, min_order_size, min_tick_size, tags, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(condition_id) DO UPDATE SET
       slug = excluded.slug,
       question = excluded.question,
       end_date_iso = excluded.end_date_iso,
       min_order_size = excluded.min_order_size,
       min_tick_size = excluded.min_tick_size,
       tags = excluded.tags,
       last_seen = excluded.last_seen`,
  ).run(m.conditionId, m.slug, m.question, m.endDateIso, m.minOrderSize, m.minTickSize, JSON.stringify(m.tags), m.seenAt, m.seenAt)
}

export function upsertToken(tokenId: string, conditionId: string, outcome: string) {
  const db = getDb()
  db.prepare(
    `INSERT INTO tokens (token_id, condition_id, outcome) VALUES (?, ?, ?)
     ON CONFLICT(token_id) DO UPDATE SET outcome = excluded.outcome, condition_id = excluded.condition_id`,
  ).run(tokenId, conditionId, outcome)
}

// ── Snapshot inserts (transactional batch) ──

export interface RewardSnapshotRow {
  conditionId: string
  ts: number
  dailyRate: number
  minSize: number
  maxSpread: number
  acceptingOrders: boolean
}

export interface BookSnapshotRow {
  tokenId: string
  ts: number
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  spread: number | null
  qualifyingBidSize: number
  qualifyingAskSize: number
  totalBidSize: number
  totalAskSize: number
}

export function insertRewardSnapshots(rows: RewardSnapshotRow[]) {
  if (rows.length === 0) return
  const db = getDb()
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO reward_snapshots
      (condition_id, ts, daily_rate, min_size, max_spread, accepting_orders)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const tx = db.transaction((rs: RewardSnapshotRow[]) => {
    for (const r of rs) {
      stmt.run(r.conditionId, r.ts, r.dailyRate, r.minSize, r.maxSpread, r.acceptingOrders ? 1 : 0)
    }
  })
  tx(rows)
}

export function insertBookSnapshots(rows: BookSnapshotRow[]) {
  if (rows.length === 0) return
  const db = getDb()
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO book_snapshots
      (token_id, ts, best_bid, best_ask, mid, spread,
       qualifying_bid_size, qualifying_ask_size, total_bid_size, total_ask_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const tx = db.transaction((bs: BookSnapshotRow[]) => {
    for (const b of bs) {
      stmt.run(
        b.tokenId, b.ts,
        b.bestBid, b.bestAsk, b.mid, b.spread,
        b.qualifyingBidSize, b.qualifyingAskSize,
        b.totalBidSize, b.totalAskSize,
      )
    }
  })
  tx(rows)
}

// ── Read queries used by the API plugin ──

export interface LatestMarketRow {
  condition_id: string
  slug: string
  question: string
  end_date_iso: string | null
  min_order_size: number
  min_tick_size: number
  tags: string
  last_seen: number
  // Latest reward snapshot joined in:
  ts: number
  daily_rate: number
  min_size: number
  max_spread: number
  accepting_orders: number
}

export function getLatestMarkets(): LatestMarketRow[] {
  const db = getDb()
  return db.prepare(`
    SELECT m.*, r.ts, r.daily_rate, r.min_size, r.max_spread, r.accepting_orders
    FROM markets m
    INNER JOIN (
      SELECT condition_id, MAX(ts) AS max_ts
      FROM reward_snapshots
      GROUP BY condition_id
    ) latest ON latest.condition_id = m.condition_id
    INNER JOIN reward_snapshots r
      ON r.condition_id = latest.condition_id AND r.ts = latest.max_ts
    ORDER BY r.daily_rate DESC
  `).all() as LatestMarketRow[]
}

export interface LatestBookRow {
  token_id: string
  condition_id: string
  outcome: string
  ts: number
  best_bid: number | null
  best_ask: number | null
  mid: number | null
  spread: number | null
  qualifying_bid_size: number
  qualifying_ask_size: number
  total_bid_size: number
  total_ask_size: number
}

export function getLatestBooks(): LatestBookRow[] {
  const db = getDb()
  return db.prepare(`
    SELECT t.token_id, t.condition_id, t.outcome,
           b.ts, b.best_bid, b.best_ask, b.mid, b.spread,
           b.qualifying_bid_size, b.qualifying_ask_size,
           b.total_bid_size, b.total_ask_size
    FROM tokens t
    INNER JOIN (
      SELECT token_id, MAX(ts) AS max_ts
      FROM book_snapshots
      GROUP BY token_id
    ) latest ON latest.token_id = t.token_id
    INNER JOIN book_snapshots b
      ON b.token_id = latest.token_id AND b.ts = latest.max_ts
  `).all() as LatestBookRow[]
}

export function getRewardHistory(conditionId: string) {
  const db = getDb()
  return db.prepare(
    `SELECT ts, daily_rate, min_size, max_spread FROM reward_snapshots
     WHERE condition_id = ? ORDER BY ts`,
  ).all(conditionId) as Array<{ ts: number; daily_rate: number; min_size: number; max_spread: number }>
}

export function getBookHistoryByMarket(conditionId: string) {
  const db = getDb()
  return db.prepare(
    `SELECT b.token_id, t.outcome, b.ts, b.mid, b.spread,
            b.qualifying_bid_size, b.qualifying_ask_size
     FROM book_snapshots b
     INNER JOIN tokens t ON t.token_id = b.token_id
     WHERE t.condition_id = ?
     ORDER BY b.ts, t.outcome`,
  ).all(conditionId) as Array<{
    token_id: string; outcome: string; ts: number; mid: number | null; spread: number | null;
    qualifying_bid_size: number; qualifying_ask_size: number
  }>
}

// Returns per-market daily volatility (σ of mid in dollars) computed over the
// last `windowHours` of book snapshots. Uses stddev of mid-to-mid changes
// between consecutive snapshots, scaled to a full day.
//
// For each condition_id we compute volatility on the first outcome's token
// (binary markets are mirror-images so YES and NO have the same σ).
//
// Performance: with ~1M book snapshots in a 24h window the previous "fetch
// then group in JS" approach was loading hundreds of MB into Node and
// dominating dev-server RAM. Volatility is only used by the simulator — and
// the simulator only ever consumes the top-N markets by daily pool — so we
// pre-restrict to those condition_ids in SQL and stream a tiny result set
// back to JS. Each call is O(top-N · samples-per-market) instead of
// O(total-snapshots).
const VOLATILITY_TOP_N_DEFAULT = 400

export interface MarketVolatilityRow {
  conditionId: string
  dailyStddevDollars: number
  samples: number
  hoursCovered: number
}

export function getMarketVolatility(
  windowHours = 24,
  topN = VOLATILITY_TOP_N_DEFAULT,
): Record<string, MarketVolatilityRow> {
  const db = getDb()
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000

  // Pull just the top-N most-rewarded markets and the *first* token per
  // condition. Binary markets are price-symmetric, so one token's σ stands in
  // for the market.
  const topMarkets = db
    .prepare(
      `SELECT t.condition_id, MIN(t.token_id) AS token_id
       FROM tokens t
       INNER JOIN (
         SELECT condition_id, MAX(ts) AS max_ts
         FROM reward_snapshots
         GROUP BY condition_id
       ) latest ON latest.condition_id = t.condition_id
       INNER JOIN reward_snapshots r
         ON r.condition_id = latest.condition_id AND r.ts = latest.max_ts
       WHERE r.daily_rate > 0
       GROUP BY t.condition_id
       ORDER BY r.daily_rate DESC
       LIMIT ?`,
    )
    .all(topN) as Array<{ condition_id: string; token_id: string }>

  if (topMarkets.length === 0) return {}

  // Per-token mid series, fetched one prepared statement at a time. Each
  // result is bounded to ~window/snapshot-cadence rows (≈300 for 24h@5min),
  // so the in-memory footprint is at most topN×300 = ~120K small rows.
  const seriesStmt = db.prepare(
    `SELECT ts, mid FROM book_snapshots
     WHERE token_id = ? AND ts >= ? AND mid IS NOT NULL
     ORDER BY ts`,
  )

  const out: Record<string, MarketVolatilityRow> = {}
  for (const m of topMarkets) {
    const series = seriesStmt.all(m.token_id, cutoff) as Array<{ ts: number; mid: number }>
    if (series.length < 3) continue

    let sum = 0
    let sumSq = 0
    let intervalMs = 0
    const n = series.length - 1
    for (let i = 1; i < series.length; i++) {
      const d = series[i].mid - series[i - 1].mid
      sum += d
      sumSq += d * d
      intervalMs += series[i].ts - series[i - 1].ts
    }
    const mean = sum / n
    const variance = Math.max(0, (sumSq - n * mean * mean) / Math.max(1, n - 1))
    const stepSigma = Math.sqrt(variance)
    const avgIntervalMs = intervalMs / n
    const barsPerDay = avgIntervalMs > 0 ? (24 * 60 * 60 * 1000) / avgIntervalMs : 1
    const dailyStddevDollars = stepSigma * Math.sqrt(barsPerDay)
    const hoursCovered = (series[series.length - 1].ts - series[0].ts) / (60 * 60 * 1000)

    out[m.condition_id] = {
      conditionId: m.condition_id,
      dailyStddevDollars,
      samples: series.length,
      hoursCovered,
    }
  }
  return out
}

export function getStats() {
  const db = getDb()
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM markets) AS markets,
      (SELECT COUNT(*) FROM reward_snapshots) AS reward_snapshots,
      (SELECT COUNT(*) FROM book_snapshots) AS book_snapshots,
      (SELECT MIN(ts) FROM reward_snapshots) AS first_ts,
      (SELECT MAX(ts) FROM reward_snapshots) AS last_ts
  `).get() as {
    markets: number; reward_snapshots: number; book_snapshots: number
    first_ts: number | null; last_ts: number | null
  }
  return row
}
