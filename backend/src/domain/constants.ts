// Engine timing and risk thresholds — port of sim/engineConstants.ts.
// Scoring helpers live here because they depend only on these constants.

export const REWARD_TICK_MS = 1_000
export const REALLOC_MS = 5 * 60_000
export const CAPITAL_SAMPLE_MS = 5 * 60_000
export const VOL_WINDOW_HOURS = 24

export const MIN_PRICE_FLOOR = 0.05

// C2a: pct and absolute cent caps on hedge slippage — whichever is tighter wins.
export const MAX_HEDGE_SLIPPAGE = 0.01
export const MAX_HEDGE_SLIPPAGE_ABS = 0.015

export const MIN_HEDGE_DEPTH_RATIO = 5

export const MIN_BOOK_LEVELS = 3
export const MIN_BOOK_DEPTH_SHARES = 100

export const MAX_DAILY_STDDEV = 0.04

// C7: binary-extreme exclusion.
export const MIN_MID_PRICE = 0.20
export const MAX_MID_PRICE = 0.80

// C4: drift-cancel.
export const DRIFT_CANCEL_TICKS = 1
export const TICK = 0.01
export const REPOSITION_DELAY_MS = 10_000

// Inventory skew after fill.
export const INVENTORY_BIAS_DECAY_MS = 30 * 60_000
export const INVENTORY_SKEW_WIDE_TICKS = 2
export const INVENTORY_SKEW_TIGHT_TICKS = 1

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
