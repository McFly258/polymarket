import { fetchBooks, fetchRewardMarkets, type BookView } from '../api/polymarket'
import { USDC_POLYGON } from '../constants'
import type { BookSnapshot, DashboardData, RawMarket, RewardsRow } from '../types'

function dailyRateForMarket(market: RawMarket): number {
  const rates = market.rewards?.rates
  if (!rates || rates.length === 0) return 0
  const usdc = rates.find((r) => r.asset_address.toLowerCase() === USDC_POLYGON.toLowerCase())
  return (usdc ?? rates[0]).rewards_daily_rate
}

// max_spread from the CLOB is in cents (e.g. 3.5 → $0.035).
// A maker earns rewards if their order is within max_spread of the mid.
// We treat the market as "in-band" when the current book spread is small enough
// that both sides of the book could host reward-earning orders — roughly
// book_spread ≤ 2 × (max_spread / 100).
function withinRewardSpread(
  bookSpreadDollars: number | null,
  maxSpreadCents: number,
): boolean | null {
  if (bookSpreadDollars === null) return null
  const maxSpreadDollars = maxSpreadCents / 100
  return bookSpreadDollars <= 2 * maxSpreadDollars
}

export function filterActiveRewardMarkets(raw: RawMarket[]): RawMarket[] {
  return raw.filter(
    (m) =>
      m.active && !m.closed && !m.archived && m.accepting_orders && m.enable_order_book &&
      m.rewards && (m.rewards.rates?.length ?? 0) > 0,
  )
}

export function collectTokenIds(markets: RawMarket[]): string[] {
  return markets.flatMap((m) => m.tokens.map((t) => t.token_id))
}

/**
 * Pure derivation: given the set of reward markets and a (possibly partial)
 * map of current books, compute the dashboard view. This is called on every
 * ws tick — keep it cheap.
 */
export function buildDashboard(
  markets: RawMarket[],
  books: Map<string, BookView>,
  updatedAt: string,
): DashboardData {
  const rows: RewardsRow[] = markets.map((market) => {
    const maxSpreadDollars = market.rewards.max_spread / 100
    const bookSnapshots: BookSnapshot[] = market.tokens.map((token) => {
      const book = books.get(token.token_id)
      const bestBid = book?.bestBid ?? null
      const bestAsk = book?.bestAsk ?? null
      const mid = book?.mid ?? null
      const spread = book?.spread ?? null

      let qualifyingBidDepthUsd = 0
      let qualifyingAskDepthUsd = 0
      if (book && mid !== null) {
        for (const lvl of book.bids) {
          if (mid - lvl.price <= maxSpreadDollars) {
            qualifyingBidDepthUsd += lvl.price * lvl.size
          }
        }
        for (const lvl of book.asks) {
          if (lvl.price - mid <= maxSpreadDollars) {
            qualifyingAskDepthUsd += lvl.price * lvl.size
          }
        }
      }

      return {
        tokenId: token.token_id,
        outcome: token.outcome,
        price: token.price,
        bestBid,
        bestAsk,
        mid,
        spread,
        withinRewardSpread: withinRewardSpread(spread, market.rewards.max_spread),
        qualifyingBidDepthUsd,
        qualifyingAskDepthUsd,
        bids: book?.bids ?? [],
        asks: book?.asks ?? [],
      }
    })

    const eligibleSides = bookSnapshots.filter((b) => b.withinRewardSpread === true).length

    return {
      conditionId: market.condition_id,
      slug: market.market_slug,
      question: market.question,
      icon: market.icon,
      endDateIso: market.end_date_iso,
      tags: market.tags ?? [],
      minOrderSize: market.minimum_order_size,
      minTickSize: market.minimum_tick_size,
      rewardMinSize: market.rewards.min_size,
      rewardMaxSpread: market.rewards.max_spread,
      dailyRate: dailyRateForMarket(market),
      books: bookSnapshots,
      eligibleSides,
    }
  })

  rows.sort((a, b) => b.dailyRate - a.dailyRate)

  return {
    updatedAt,
    rows,
    totals: {
      markets: rows.length,
      dailyPool: rows.reduce((sum, r) => sum + r.dailyRate, 0),
      eligibleMarkets: rows.filter((r) => r.eligibleSides > 0).length,
    },
  }
}

export interface MarketsAndBooks {
  markets: RawMarket[]
  books: Map<string, BookView>
  updatedAt: string
}

/**
 * One-shot HTTP load of markets + books. Used for the initial boot snapshot
 * and as a periodic safety resync in case the WS misses updates.
 */
export async function loadMarketsAndBooks(): Promise<MarketsAndBooks> {
  const rawMarkets = await fetchRewardMarkets()
  const markets = filterActiveRewardMarkets(rawMarkets)
  const books = await fetchBooks(collectTokenIds(markets))
  return { markets, books, updatedAt: new Date().toISOString() }
}

/** Back-compat for any caller still using the old single-call signature. */
export async function loadDashboard(): Promise<DashboardData> {
  const { markets, books, updatedAt } = await loadMarketsAndBooks()
  return buildDashboard(markets, books, updatedAt)
}
