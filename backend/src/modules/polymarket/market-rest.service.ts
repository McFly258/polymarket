import { Injectable, Logger } from '@nestjs/common'

import type { BookSnapshot, RewardsRow } from '../../domain/strategy.types'

const CLOB_BASE = 'https://clob.polymarket.com'
const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const PAGE_TERMINATOR = 'LTE='
const MAX_MARKET_PAGES = 40
const BOOK_BATCH = 100

interface RewardRate {
  asset_address: string
  rewards_daily_rate: number
}

interface RewardsConfig {
  rates: RewardRate[] | null
  min_size: number
  max_spread: number
}

interface Token {
  token_id: string
  outcome: string
  price: number
  winner: boolean
}

interface Market {
  condition_id: string
  question: string
  market_slug: string
  end_date_iso: string | null
  icon: string | null
  active: boolean
  closed: boolean
  archived: boolean
  accepting_orders: boolean
  enable_order_book: boolean
  minimum_order_size: number
  minimum_tick_size: number
  rewards: RewardsConfig
  tokens: Token[]
  tags: string[]
}

interface SamplingResponse {
  limit: number
  count: number
  next_cursor: string
  data: Market[]
}

interface RawBook {
  market: string
  asset_id: string
  timestamp: string
  bids: Array<{ price: string; size: string }>
  asks: Array<{ price: string; size: string }>
}

@Injectable()
export class MarketRestService {
  private readonly logger = new Logger(MarketRestService.name)

  async fetchRewardsRows(): Promise<RewardsRow[]> {
    const markets = await this.fetchRewardMarkets()
    const eligible = markets.filter(
      (m) =>
        m.active && !m.closed && !m.archived && m.accepting_orders && m.enable_order_book &&
        m.rewards && (m.rewards.rates?.length ?? 0) > 0,
    )
    const tokenIds = eligible.flatMap((m) => m.tokens.map((t) => t.token_id))
    const books = await this.fetchBooks(tokenIds)

    return eligible.map((m) => {
      const maxSpreadDollars = m.rewards.max_spread / 100
      const bookSnapshots: BookSnapshot[] = m.tokens.map((t) => {
        const rawBook = books.get(t.token_id)
        const metrics = this.computeBookMetrics(rawBook)
        const bids = (rawBook?.bids ?? [])
          .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
          .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
          .sort((a, b) => b.price - a.price)
        const asks = (rawBook?.asks ?? [])
          .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
          .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
          .sort((a, b) => a.price - b.price)
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
        dailyRate: this.dailyRateFor(m),
        books: bookSnapshots,
        eligibleSides,
      }
    })
  }

  private dailyRateFor(market: Market): number {
    const rates = market.rewards?.rates
    if (!rates?.length) return 0
    const usdc = rates.find((r) => r.asset_address.toLowerCase() === USDC_POLYGON.toLowerCase())
    return (usdc ?? rates[0]).rewards_daily_rate
  }

  private async fetchRewardMarkets(): Promise<Market[]> {
    const all: Market[] = []
    let cursor = ''

    for (let page = 0; page < MAX_MARKET_PAGES; page++) {
      const url = cursor
        ? `${CLOB_BASE}/sampling-markets?next_cursor=${encodeURIComponent(cursor)}`
        : `${CLOB_BASE}/sampling-markets`

      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`sampling-markets ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const payload = (await res.json()) as SamplingResponse
      for (const m of payload.data ?? []) all.push(m)

      if (!payload.next_cursor || payload.next_cursor === PAGE_TERMINATOR) break
      if (!payload.data?.length) break
      cursor = payload.next_cursor
    }

    return all
  }

  private async fetchBooks(tokenIds: string[]): Promise<Map<string, RawBook>> {
    const out = new Map<string, RawBook>()
    if (tokenIds.length === 0) return out

    for (let i = 0; i < tokenIds.length; i += BOOK_BATCH) {
      const slice = tokenIds.slice(i, i + BOOK_BATCH)
      const res = await fetch(`${CLOB_BASE}/books`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slice.map((token_id) => ({ token_id }))),
      })
      if (!res.ok) {
        throw new Error(`books ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const books = (await res.json()) as RawBook[]
      for (const b of books) out.set(b.asset_id, b)
    }
    return out
  }

  private computeBookMetrics(book: RawBook | undefined): {
    bestBid: number | null
    bestAsk: number | null
    mid: number | null
    spread: number | null
  } {
    if (!book) return { bestBid: null, bestAsk: null, mid: null, spread: null }
    const bids = book.bids.map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
    const asks = book.asks.map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
    const bestBid = bids.at(-1)?.price ?? null
    const bestAsk = asks.at(-1)?.price ?? null
    if (bestBid === null || bestAsk === null) return { bestBid, bestAsk, mid: null, spread: null }
    return { bestBid, bestAsk, mid: (bestBid + bestAsk) / 2, spread: bestAsk - bestBid }
  }
}
