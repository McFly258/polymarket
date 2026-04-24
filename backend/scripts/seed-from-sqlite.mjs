/**
 * seed-from-sqlite.mjs
 *
 * Reads all paper_* rows from SQLite (polymarket.db at repo root) and inserts
 * them into the NestJS/Postgres database.  Safe to run while both services
 * are live:
 *   - uses UPSERT / ON CONFLICT DO NOTHING so re-runs are idempotent
 *   - does NOT truncate existing data
 *
 * Epoch-ms  →  ISO-8601 conversion required for every DateTime column.
 * BigInt columns (hour_epoch, bucket_epoch) are forwarded as-is.
 *
 * Run from repo root:  node backend/scripts/seed-from-sqlite.mjs
 * Override SQLite path: SQLITE_DB=/path/to/polymarket.db node ...
 */

import Database from 'better-sqlite3'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const { Pool } = pg

const __dirname = dirname(fileURLToPath(import.meta.url))
// Repo root is two levels up from backend/scripts/
const REPO_ROOT = resolve(__dirname, '..', '..')
const DB_PATH = process.env.SQLITE_DB ?? join(REPO_ROOT, 'polymarket.db')

// ── helpers ────────────────────────────────────────────────────────────────

/** Convert epoch-ms integer to JS Date (null → null). */
const ts = (ms) => (ms == null ? null : new Date(ms))

// ── connections ────────────────────────────────────────────────────────────

const sqlite = new Database(DB_PATH, { readonly: true })
sqlite.pragma('journal_mode = WAL')

const pool = new Pool({
  connectionString:
    'postgresql://polymarket_nest:polymarket_nest_dev@127.0.0.1:5433/polymarket_paper',
})

// ── migration helpers ──────────────────────────────────────────────────────

async function run(label, sqliteQuery, pgInsert, transform) {
  const rows = sqlite.prepare(sqliteQuery).all()
  if (rows.length === 0) {
    console.log(`  ${label}: 0 rows — skipped`)
    return 0
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let inserted = 0
    for (const r of rows) {
      const values = transform(r)
      const result = await client.query(pgInsert, values)
      inserted += result.rowCount ?? 0
    }
    await client.query('COMMIT')
    console.log(`  ${label}: ${rows.length} source rows → ${inserted} inserted/updated`)
    return inserted
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ── main ───────────────────────────────────────────────────────────────────

console.log('\nPolymarket SQLite → Postgres seed\n')
console.log('Source:', DB_PATH)
console.log('Target: postgresql://127.0.0.1:5433/polymarket_paper\n')

// 1. engine_state  (singleton, id=1)
await run(
  'engine_state',
  `SELECT id, state, started_at, config_json, last_alloc_at, updated_at FROM paper_engine_state`,
  `INSERT INTO engine_state (id, state, started_at, config_json, last_alloc_at, updated_at)
   VALUES ($1, $2, $3, $4::jsonb, $5, $6)
   ON CONFLICT (id) DO UPDATE SET
     state        = EXCLUDED.state,
     started_at   = EXCLUDED.started_at,
     config_json  = EXCLUDED.config_json,
     last_alloc_at= EXCLUDED.last_alloc_at,
     updated_at   = EXCLUDED.updated_at`,
  (r) => [
    r.id,
    r.state,
    ts(r.started_at),
    r.config_json,          // already JSON text
    ts(r.last_alloc_at),
    ts(r.updated_at),
  ],
)

// 2. reward  (singleton, id=1)
await run(
  'reward',
  `SELECT id, total_earned_usd, last_rate_per_day, last_updated_at FROM paper_reward`,
  `INSERT INTO reward (id, total_earned_usd, last_rate_per_day, last_updated_at)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (id) DO UPDATE SET
     total_earned_usd = EXCLUDED.total_earned_usd,
     last_rate_per_day= EXCLUDED.last_rate_per_day,
     last_updated_at  = EXCLUDED.last_updated_at`,
  (r) => [r.id, r.total_earned_usd, r.last_rate_per_day, ts(r.last_updated_at)],
)

// 3. orders
await run(
  'orders',
  `SELECT id, condition_id, token_id, outcome, side, price, size, status,
          posted_at, posted_best_bid, posted_best_ask, closed_at
   FROM paper_orders`,
  `INSERT INTO orders
     (id, condition_id, token_id, outcome, side, price, size, status,
      posted_at, posted_best_bid, posted_best_ask, closed_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
   ON CONFLICT (id) DO NOTHING`,
  (r) => [
    r.id, r.condition_id, r.token_id, r.outcome, r.side,
    r.price, r.size, r.status,
    ts(r.posted_at), r.posted_best_bid, r.posted_best_ask, ts(r.closed_at),
  ],
)

// 4. fills
await run(
  'fills',
  `SELECT id, order_id, condition_id, question, side, fill_price, size, hedge_price,
          realised_pnl_usd, maker_fee_usd, taker_fee_usd, filled_at, hedge_order_id, hedge_status
   FROM paper_fills`,
  `INSERT INTO fills
     (id, order_id, condition_id, question, side, fill_price, size, hedge_price,
      realised_pnl_usd, maker_fee_usd, taker_fee_usd, filled_at, hedge_order_id, hedge_status)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
   ON CONFLICT (id) DO NOTHING`,
  (r) => [
    r.id, r.order_id, r.condition_id, r.question, r.side,
    r.fill_price, r.size, r.hedge_price,
    r.realised_pnl_usd, r.maker_fee_usd, r.taker_fee_usd,
    ts(r.filled_at), r.hedge_order_id, r.hedge_status,
  ],
)

// 5. positions
await run(
  'positions',
  `SELECT condition_id, question, token_id, outcome, bid_order_id, ask_order_id,
          bid_price, ask_price, bid_size, ask_size, max_spread_dollars, daily_pool,
          mid_price, best_bid, best_ask, reward_share_pct, expected_rate_per_day,
          capital_usd, updated_at
   FROM paper_positions`,
  `INSERT INTO positions
     (condition_id, question, token_id, outcome, bid_order_id, ask_order_id,
      bid_price, ask_price, bid_size, ask_size, max_spread_dollars, daily_pool,
      mid_price, best_bid, best_ask, reward_share_pct, expected_rate_per_day,
      capital_usd, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
   ON CONFLICT (condition_id) DO UPDATE SET
     question            = EXCLUDED.question,
     token_id            = EXCLUDED.token_id,
     outcome             = EXCLUDED.outcome,
     bid_order_id        = EXCLUDED.bid_order_id,
     ask_order_id        = EXCLUDED.ask_order_id,
     bid_price           = EXCLUDED.bid_price,
     ask_price           = EXCLUDED.ask_price,
     bid_size            = EXCLUDED.bid_size,
     ask_size            = EXCLUDED.ask_size,
     max_spread_dollars  = EXCLUDED.max_spread_dollars,
     daily_pool          = EXCLUDED.daily_pool,
     mid_price           = EXCLUDED.mid_price,
     best_bid            = EXCLUDED.best_bid,
     best_ask            = EXCLUDED.best_ask,
     reward_share_pct    = EXCLUDED.reward_share_pct,
     expected_rate_per_day = EXCLUDED.expected_rate_per_day,
     capital_usd         = EXCLUDED.capital_usd,
     updated_at          = EXCLUDED.updated_at`,
  (r) => [
    r.condition_id, r.question, r.token_id, r.outcome,
    r.bid_order_id, r.ask_order_id,
    r.bid_price, r.ask_price, r.bid_size, r.ask_size,
    r.max_spread_dollars, r.daily_pool,
    r.mid_price, r.best_bid, r.best_ask,
    r.reward_share_pct, r.expected_rate_per_day,
    r.capital_usd, ts(r.updated_at),
  ],
)

// 6. reward_hourly  (hourEpoch is BigInt PK)
await run(
  'reward_hourly',
  `SELECT hour_epoch, snapshot_at, total_earned_usd, rate_per_day, total_capital_usd
   FROM paper_reward_hourly`,
  `INSERT INTO reward_hourly
     (hour_epoch, snapshot_at, total_earned_usd, rate_per_day, total_capital_usd)
   VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (hour_epoch) DO UPDATE SET
     snapshot_at      = EXCLUDED.snapshot_at,
     total_earned_usd = EXCLUDED.total_earned_usd,
     rate_per_day     = EXCLUDED.rate_per_day,
     total_capital_usd= EXCLUDED.total_capital_usd`,
  (r) => [
    BigInt(r.hour_epoch),
    ts(r.snapshot_at),
    r.total_earned_usd,
    r.rate_per_day,
    r.total_capital_usd ?? 0,
  ],
)

// 7. position_reward_hourly  (autoincrement PK — skip id, let Postgres assign)
//    Use ON CONFLICT DO NOTHING on a unique logical key; table has no unique
//    constraint beyond PK, so we simply insert all rows (idempotent on re-run
//    by checking existing count first).
{
  const existingCount = parseInt(
    (await pool.query('SELECT COUNT(*) FROM position_reward_hourly')).rows[0].count,
    10,
  )
  const rows = sqlite
    .prepare(
      `SELECT hour_epoch, snapshot_at, condition_id, question, reward_share_pct,
              expected_rate_per_day, earned_this_hour_usd
       FROM paper_position_reward_hourly`,
    )
    .all()

  if (existingCount > 0) {
    console.log(
      `  position_reward_hourly: ${existingCount} rows already present — skipping to avoid duplicates`,
    )
  } else {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const r of rows) {
        await client.query(
          `INSERT INTO position_reward_hourly
             (hour_epoch, snapshot_at, condition_id, question, reward_share_pct,
              expected_rate_per_day, earned_this_hour_usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            BigInt(r.hour_epoch),
            ts(r.snapshot_at),
            r.condition_id,
            r.question,
            r.reward_share_pct,
            r.expected_rate_per_day,
            r.earned_this_hour_usd,
          ],
        )
      }
      await client.query('COMMIT')
      console.log(`  position_reward_hourly: ${rows.length} rows inserted`)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}

// 8. capital_5min  (bucketEpoch is BigInt PK)
await run(
  'capital_5min',
  `SELECT bucket_epoch, sampled_at, total_capital_usd FROM paper_capital_5min`,
  `INSERT INTO capital_5min (bucket_epoch, sampled_at, total_capital_usd)
   VALUES ($1,$2,$3)
   ON CONFLICT (bucket_epoch) DO UPDATE SET
     sampled_at       = EXCLUDED.sampled_at,
     total_capital_usd= EXCLUDED.total_capital_usd`,
  (r) => [BigInt(r.bucket_epoch), ts(r.sampled_at), r.total_capital_usd],
)

// ── verification ───────────────────────────────────────────────────────────

console.log('\n── Verification ──────────────────────────────────────────────\n')

const pgCounts = await pool.query(`
  SELECT 'engine_state' AS tbl, COUNT(*) FROM engine_state
  UNION ALL SELECT 'orders',                COUNT(*) FROM orders
  UNION ALL SELECT 'fills',                 COUNT(*) FROM fills
  UNION ALL SELECT 'positions',             COUNT(*) FROM positions
  UNION ALL SELECT 'reward',                COUNT(*) FROM reward
  UNION ALL SELECT 'reward_hourly',         COUNT(*) FROM reward_hourly
  UNION ALL SELECT 'position_reward_hourly',COUNT(*) FROM position_reward_hourly
  UNION ALL SELECT 'capital_5min',          COUNT(*) FROM capital_5min
`)

const sqliteCounts = {
  engine_state: sqlite.prepare('SELECT COUNT(*) AS c FROM paper_engine_state').get().c,
  orders: sqlite.prepare('SELECT COUNT(*) AS c FROM paper_orders').get().c,
  fills: sqlite.prepare('SELECT COUNT(*) AS c FROM paper_fills').get().c,
  positions: sqlite.prepare('SELECT COUNT(*) AS c FROM paper_positions').get().c,
  reward: sqlite.prepare('SELECT COUNT(*) AS c FROM paper_reward').get().c,
  reward_hourly: sqlite.prepare('SELECT COUNT(*) AS c FROM paper_reward_hourly').get().c,
  position_reward_hourly: sqlite.prepare('SELECT COUNT(*) AS c FROM paper_position_reward_hourly').get().c,
  capital_5min: sqlite.prepare('SELECT COUNT(*) AS c FROM paper_capital_5min').get().c,
}

console.log('Table                     SQLite   Postgres  Match')
console.log('─────────────────────────────────────────────────')
for (const { tbl, count } of pgCounts.rows) {
  const src = sqliteCounts[tbl] ?? '?'
  const pgn = parseInt(count, 10)
  const match = pgn >= src ? '✓' : '✗'
  console.log(`${tbl.padEnd(26)}${String(src).padStart(6)}   ${String(pgn).padStart(8)}  ${match}`)
}

await pool.end()
sqlite.close()
console.log('\nDone.\n')
