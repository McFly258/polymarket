// Engine timing constants and risk-criteria thresholds.
// Scoring helpers live here because they depend only on these constants.

export const REWARD_TICK_MS = 1_000
export const REALLOC_MS = 5 * 60_000
export const VOL_WINDOW_HOURS = 24

// C1: skip markets where best bid OR best ask is below this floor.
export const MIN_PRICE_FLOOR = 0.05

// C2a: max fraction of fill price we're willing to lose on the instant hedge.
export const MAX_HEDGE_SLIPPAGE = 0.01

// C2a+: absolute cent cap — at high prices (>0.70) the 3% fraction tolerates
// more cents of drift than the spread can absorb; cap in absolute cents.
// Whichever is tighter (pct or abs) wins.
export const MAX_HEDGE_SLIPPAGE_ABS = 0.015

// C2b: hedge side must hold at least this multiple of our order size in visible depth.
export const MIN_HEDGE_DEPTH_RATIO = 5

// C5: minimum book activity proxy.
export const MIN_BOOK_LEVELS = 3
export const MIN_BOOK_DEPTH_SHARES = 100

// C6: volatility gate — skip markets whose daily price std-dev exceeds this threshold.
export const MAX_DAILY_STDDEV = 0.04

// C7: binary-extreme exclusion.
export const MIN_MID_PRICE = 0.20
export const MAX_MID_PRICE = 0.80

// C4: mid-drift cancel — cancel if live best crosses within this many ticks of our quote.
export const DRIFT_CANCEL_TICKS = 1
export const TICK = 0.01

// C4+: after a drift-cancel, wait this long before reposting on the same market.
export const REPOSITION_DELAY_MS = 10_000

// Inventory skew — after a fill, adjust quotes for 30 min to discourage
// same-side re-fills and encourage closing the accumulated inventory.
export const INVENTORY_BIAS_DECAY_MS = 30 * 60_000
export const INVENTORY_SKEW_WIDE_TICKS = 2   // ticks to widen the filled side
export const INVENTORY_SKEW_TIGHT_TICKS = 1  // ticks to tighten the opposite side

export function levelScore(d: number, sizeUsd: number, maxSpreadDollars: number): number {
  if (d < 0 || d > maxSpreadDollars) return 0
  return (1 - d / maxSpreadDollars) * sizeUsd
}

export function competingScore(
  levels: { price: number; size: number }[],
  mid: number,
  maxSpreadDollars: number,
  side: 'bid' | 'ask',
): number {
  let total = 0
  for (const lvl of levels) {
    const d = side === 'bid' ? mid - lvl.price : lvl.price - mid
    total += levelScore(d, lvl.price * lvl.size, maxSpreadDollars)
  }
  return total
}
