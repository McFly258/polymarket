import { fetchBooks, fetchRewardMarkets, computeBookMetrics, type Market } from '../collector/api.ts'
import { USDC_POLYGON } from '../collector/config.ts'
import type { BookSnapshot, MarketVolatility, RewardsRow } from '../src/types.ts'
import { getMarketVolatility } from '../collector/db.ts'
import { VOL_WINDOW_HOURS } from './engineConstants.ts'

function dailyRateFor(market: Market): number {
  const rates = market.rewards?.rates
  if (!rates?.length) return 0
  const usdc = rates.find((r) => r.asset_address.toLowerCase() === USDC_POLYGON.toLowerCase())
  return (usdc ?? rates[0]).rewards_daily_rate
}

// Build RewardsRow[] straight from CLOB fetchers. The strategy allocator needs
// the same shape the frontend uses; we reconstruct it from the Node-side API.
export async function fetchRewardsRows(): Promise<RewardsRow[]> {
  const markets = await fetchRewardMarkets()
  const eligible = markets.filter(
    (m) =>
      m.active && !m.closed && !m.archived && m.accepting_orders && m.enable_order_book &&
      m.rewards && (m.rewards.rates?.length ?? 0) > 0,
  )
  const tokenIds = eligible.flatMap((m) => m.tokens.map((t) => t.token_id))
  const books = await fetchBooks(tokenIds)

  return eligible.map((m) => {
    const maxSpreadDollars = m.rewards.max_spread / 100
    const bookSnapshots: BookSnapshot[] = m.tokens.map((t) => {
      const rawBook = books.get(t.token_id)
      const metrics = computeBookMetrics(rawBook, m.rewards.min_size, m.rewards.max_spread)
      const bids = rawBook?.bids
        .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
        .sort((a, b) => b.price - a.price) ?? []
      const asks = rawBook?.asks
        .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
        .sort((a, b) => a.price - b.price) ?? []
      let qualifyingBidDepthUsd = 0
      let qualifyingAskDepthUsd = 0
      if (metrics.mid !== null) {
        for (const l of bids) if (metrics.mid - l.price <= maxSpreadDollars) qualifyingBidDepthUsd += l.price * l.size
        for (const l of asks) if (l.price - metrics.mid <= maxSpreadDollars) qualifyingAskDepthUsd += l.price * l.size
      }
      return {
        tokenId: t.token_id,
        outcome: t.outcome,
        price: t.price,
        bestBid: metrics.bestBid,
        bestAsk: metrics.bestAsk,
        mid: metrics.mid,
        spread: metrics.spread,
        withinRewardSpread:
          metrics.spread === null ? null : metrics.spread <= 2 * maxSpreadDollars,
        qualifyingBidDepthUsd,
        qualifyingAskDepthUsd,
        bids,
        asks,
      }
    })
    const eligibleSides = bookSnapshots.filter((b) => b.withinRewardSpread === true).length
    return {
      conditionId: m.condition_id,
      slug: m.market_slug,
      question: m.question,
      icon: m.icon,
      endDateIso: m.end_date_iso,
      tags: m.tags ?? [],
      minOrderSize: m.minimum_order_size,
      minTickSize: m.minimum_tick_size,
      rewardMinSize: m.rewards.min_size,
      rewardMaxSpread: m.rewards.max_spread,
      dailyRate: dailyRateFor(m),
      books: bookSnapshots,
      eligibleSides,
    }
  })
}

export function loadVolatility(): Record<string, MarketVolatility> {
  try {
    const raw = getMarketVolatility(VOL_WINDOW_HOURS, 400)
    const out: Record<string, MarketVolatility> = {}
    for (const [cid, r] of Object.entries(raw)) {
      out[cid] = {
        conditionId: r.conditionId,
        dailyStddevDollars: r.dailyStddevDollars,
        samples: r.samples,
        hoursCovered: r.hoursCovered,
      }
    }
    return out
  } catch {
    return {}
  }
}
