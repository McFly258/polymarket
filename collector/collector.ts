#!/usr/bin/env node
// Polymarket rewards collector — snapshots every reward-eligible market +
// its live order book into SQLite. Run periodically via cron, e.g. every 5 min:
//   node --experimental-strip-types collector/collector.ts
// See package.json script: npm run sim:collect

import {
  bucketTs, SNAPSHOT_BUCKET_MS, USDC_POLYGON,
} from './config.ts'
import {
  computeBookMetrics, fetchBooks, fetchRewardMarkets, type Market,
} from './api.ts'
import {
  insertBookSnapshots, insertRewardSnapshots, upsertMarket, upsertToken,
  getStats, type BookSnapshotRow, type RewardSnapshotRow,
} from './db.ts'

function dailyRateFor(market: Market): number {
  const rates = market.rewards?.rates
  if (!rates?.length) return 0
  const usdc = rates.find((r) => r.asset_address.toLowerCase() === USDC_POLYGON.toLowerCase())
  return (usdc ?? rates[0]).rewards_daily_rate
}

async function collect(): Promise<void> {
  const now = Date.now()
  const ts = bucketTs(now)
  console.log(`[collector] ${new Date(ts).toISOString()} — fetching sampling-markets…`)

  const markets = await fetchRewardMarkets()
  const eligible = markets.filter(
    (m) =>
      m.active && !m.closed && !m.archived && m.enable_order_book &&
      m.rewards && (m.rewards.rates?.length ?? 0) > 0,
  )
  console.log(`  markets: ${markets.length} total, ${eligible.length} with rewards pool`)

  // Upsert market + token metadata.
  for (const m of eligible) {
    upsertMarket({
      conditionId: m.condition_id,
      slug: m.market_slug,
      question: m.question,
      endDateIso: m.end_date_iso,
      minOrderSize: m.minimum_order_size,
      minTickSize: m.minimum_tick_size,
      tags: m.tags ?? [],
      seenAt: ts,
    })
    for (const t of m.tokens) {
      upsertToken(t.token_id, m.condition_id, t.outcome)
    }
  }

  // Record the rewards config snapshot per market.
  const rewardRows: RewardSnapshotRow[] = eligible.map((m) => ({
    conditionId: m.condition_id,
    ts,
    dailyRate: dailyRateFor(m),
    minSize: m.rewards.min_size,
    maxSpread: m.rewards.max_spread,
    acceptingOrders: m.accepting_orders,
  }))
  insertRewardSnapshots(rewardRows)
  console.log(`  reward_snapshots: +${rewardRows.length}`)

  // Pull orderbooks for every token in one batched call.
  const tokenIds = eligible.flatMap((m) => m.tokens.map((t) => t.token_id))
  console.log(`  fetching ${tokenIds.length} orderbooks…`)
  const books = await fetchBooks(tokenIds)

  const bookRows: BookSnapshotRow[] = []
  for (const m of eligible) {
    for (const t of m.tokens) {
      const metrics = computeBookMetrics(books.get(t.token_id), m.rewards.min_size, m.rewards.max_spread)
      bookRows.push({
        tokenId: t.token_id,
        ts,
        bestBid: metrics.bestBid,
        bestAsk: metrics.bestAsk,
        mid: metrics.mid,
        spread: metrics.spread,
        qualifyingBidSize: metrics.qualifyingBidSize,
        qualifyingAskSize: metrics.qualifyingAskSize,
        totalBidSize: metrics.totalBidSize,
        totalAskSize: metrics.totalAskSize,
      })
    }
  }
  insertBookSnapshots(bookRows)
  console.log(`  book_snapshots: +${bookRows.length}`)

  const stats = getStats()
  console.log(
    `  DB: ${stats.markets} markets, ${stats.reward_snapshots} reward rows, ${stats.book_snapshots} book rows` +
    (stats.last_ts ? `, latest ${new Date(stats.last_ts).toISOString()}` : ''),
  )
  console.log(`  bucket: ${SNAPSHOT_BUCKET_MS / 60000}min`)
}

collect().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
