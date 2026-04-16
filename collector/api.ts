// Polymarket CLOB fetchers used by the collector (Node side).
// The browser uses Vite proxy — these hit the CLOB directly.

import { BOOK_BATCH, CLOB_BASE, MAX_MARKET_PAGES, PAGE_TERMINATOR } from './config.ts'

export interface RewardRate {
  asset_address: string
  rewards_daily_rate: number
}

export interface RewardsConfig {
  rates: RewardRate[] | null
  min_size: number
  max_spread: number
}

export interface Token {
  token_id: string
  outcome: string
  price: number
  winner: boolean
}

export interface Market {
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

export async function fetchRewardMarkets(): Promise<Market[]> {
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

export interface RawBook {
  market: string
  asset_id: string
  timestamp: string
  bids: Array<{ price: string; size: string }>
  asks: Array<{ price: string; size: string }>
}

export async function fetchBooks(tokenIds: string[]): Promise<Map<string, RawBook>> {
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

// ── Book-derived metrics ──

export interface BookMetrics {
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  spread: number | null
  // Total share size of bids strictly within max_spread/100 of mid
  // whose individual size is ≥ rewardMinSize. Counts toward maker-reward score.
  qualifyingBidSize: number
  qualifyingAskSize: number
  // Total share size on each side regardless of price or min_size — context only.
  totalBidSize: number
  totalAskSize: number
}

// CLOB returns bids ascending (best last), asks descending (best last).
export function computeBookMetrics(
  book: RawBook | undefined,
  rewardMinSize: number,
  maxSpreadCents: number,
): BookMetrics {
  const empty: BookMetrics = {
    bestBid: null, bestAsk: null, mid: null, spread: null,
    qualifyingBidSize: 0, qualifyingAskSize: 0,
    totalBidSize: 0, totalAskSize: 0,
  }
  if (!book) return empty

  const bids = book.bids.map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
  const asks = book.asks.map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
  const bestBid = bids.at(-1)?.price ?? null
  const bestAsk = asks.at(-1)?.price ?? null
  if (bestBid === null || bestAsk === null) {
    return {
      ...empty, bestBid, bestAsk,
      totalBidSize: bids.reduce((s, l) => s + l.size, 0),
      totalAskSize: asks.reduce((s, l) => s + l.size, 0),
    }
  }

  const mid = (bestBid + bestAsk) / 2
  const spread = bestAsk - bestBid
  const maxSpreadDollars = maxSpreadCents / 100

  const qualifyingBidSize = bids
    .filter((l) => l.size >= rewardMinSize && mid - l.price <= maxSpreadDollars)
    .reduce((s, l) => s + l.size, 0)

  const qualifyingAskSize = asks
    .filter((l) => l.size >= rewardMinSize && l.price - mid <= maxSpreadDollars)
    .reduce((s, l) => s + l.size, 0)

  return {
    bestBid, bestAsk, mid, spread,
    qualifyingBidSize, qualifyingAskSize,
    totalBidSize: bids.reduce((s, l) => s + l.size, 0),
    totalAskSize: asks.reduce((s, l) => s + l.size, 0),
  }
}
