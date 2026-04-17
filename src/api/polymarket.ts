import { CLOB_BASE } from '../constants'
import type { RawBook, RawMarket } from '../types'

interface SamplingResponse {
  limit: number
  count: number
  next_cursor: string
  data: RawMarket[]
}

const PAGE_TERMINATOR = 'LTE='

export async function fetchRewardMarkets(): Promise<RawMarket[]> {
  const all: RawMarket[] = []
  let cursor = ''

  for (let page = 0; page < 20; page++) {
    const url = cursor
      ? `${CLOB_BASE}/sampling-markets?next_cursor=${encodeURIComponent(cursor)}`
      : `${CLOB_BASE}/sampling-markets`

    const res = await fetch(url)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`CLOB /sampling-markets ${res.status}: ${body.slice(0, 200)}`)
    }

    const payload = (await res.json()) as SamplingResponse
    for (const m of payload.data ?? []) all.push(m)

    if (!payload.next_cursor || payload.next_cursor === PAGE_TERMINATOR) break
    if (payload.data.length === 0) break
    cursor = payload.next_cursor
  }

  return all
}

export interface BookView {
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  spread: number | null
}

function parseBook(book: RawBook): BookView {
  // CLOB returns bids ascending (best last) and asks descending (best last)
  const lastBid = book.bids.at(-1)
  const lastAsk = book.asks.at(-1)
  const bestBid = lastBid ? parseFloat(lastBid.price) : null
  const bestAsk = lastAsk ? parseFloat(lastAsk.price) : null
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null
  return { bestBid, bestAsk, mid, spread }
}

const BOOK_BATCH = 100
const BOOK_CONCURRENCY = 8

async function fetchBooksBatch(slice: string[]): Promise<[string, BookView][]> {
  const res = await fetch(`${CLOB_BASE}/books`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slice.map((token_id) => ({ token_id }))),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`CLOB /books ${res.status}: ${body.slice(0, 200)}`)
  }
  const books = (await res.json()) as RawBook[]
  // asset_id is the token ID echoed back by the CLOB
  return books.map((book) => [book.asset_id, parseBook(book)])
}

export async function fetchBooks(tokenIds: string[]): Promise<Map<string, BookView>> {
  const result = new Map<string, BookView>()
  if (tokenIds.length === 0) return result

  const batches: string[][] = []
  for (let i = 0; i < tokenIds.length; i += BOOK_BATCH) {
    batches.push(tokenIds.slice(i, i + BOOK_BATCH))
  }

  // Fetch in parallel with a concurrency cap to avoid overwhelming the CLOB
  for (let i = 0; i < batches.length; i += BOOK_CONCURRENCY) {
    const window = batches.slice(i, i + BOOK_CONCURRENCY)
    const settled = await Promise.allSettled(window.map(fetchBooksBatch))
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        for (const [id, view] of s.value) result.set(id, view)
      }
    }
  }

  return result
}
