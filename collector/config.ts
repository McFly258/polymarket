// Polymarket CLOB endpoints and collector parameters

export const CLOB_BASE = 'https://clob.polymarket.com'
export const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'

export const PAGE_TERMINATOR = 'LTE='
export const MAX_MARKET_PAGES = 40
export const BOOK_BATCH = 100

// One snapshot per 5-minute bucket — keeps DB growth manageable while still
// providing enough resolution to see eligibility flip around market moves.
export const SNAPSHOT_BUCKET_MS = 5 * 60 * 1000

export function bucketTs(ts: number, bucket = SNAPSHOT_BUCKET_MS): number {
  return Math.floor(ts / bucket) * bucket
}
