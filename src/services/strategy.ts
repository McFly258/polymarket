import type {
  BookSnapshot,
  RewardsRow,
  SimulationResult,
  StrategyAllocation,
  StrategyConfig,
} from '../types'

export const DEFAULT_STRATEGY: StrategyConfig = {
  totalCapitalUsd: 2000,
  perMarketCapitalUsd: 100,
  postingDistancePct: 0.85,
  minTicksBehindTop: 2,
  minYieldPct: 0.05,
  minDaysToResolution: 7,
}

/**
 * Polymarket rewards are paid proportionally to a size-weighted score inside the
 * reward zone (max_spread around mid). Their exact scoring function is piecewise,
 * but for sizing/allocation purposes a linear-decay approximation works fine:
 *
 *     weight(d) = max(0, 1 - d / max_spread)
 *
 * where d is the distance from mid and max_spread is in dollars. Size * weight
 * is summed per side to get the total score, and each side earns half the pool.
 */
function levelScore(priceDistanceFromMid: number, sizeUsd: number, maxSpreadDollars: number): number {
  if (priceDistanceFromMid < 0 || priceDistanceFromMid > maxSpreadDollars) return 0
  const weight = 1 - priceDistanceFromMid / maxSpreadDollars
  return weight * sizeUsd
}

function competingScoreForSide(
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

function daysUntil(iso: string | null, now: number): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return (t - now) / (24 * 60 * 60 * 1000)
}

function roundToTick(price: number, tick: number, dir: 'down' | 'up'): number {
  if (!Number.isFinite(tick) || tick <= 0) return price
  const fn = dir === 'down' ? Math.floor : Math.ceil
  return fn(price / tick) * tick
}

/**
 * Price a single market allocation. We post on the YES outcome only.
 *
 * Goal: sit deep inside the reward zone but FAR from the touch price so resting
 * orders almost never fill. Specifically we anchor to mid ± postingDistancePct *
 * max_spread, then enforce minTicksBehindTop ticks of buffer behind the top of
 * book (so even if the touch drifts toward us we still won't be hit first).
 *
 * Each side deploys perMarketCapitalUsd / 2. Shares = halfCapital / price.
 */
function allocateMarket(row: RewardsRow, config: StrategyConfig, now: number): StrategyAllocation | null {
  const daysToResolution = daysUntil(row.endDateIso, now)
  const warnings: string[] = []

  // Pick the YES-side book (first outcome) as the canonical one.
  const yesBook: BookSnapshot | undefined = row.books[0]
  if (!yesBook || yesBook.mid === null || yesBook.bestBid === null || yesBook.bestAsk === null) {
    return null
  }

  const maxSpreadDollars = row.rewardMaxSpread / 100
  const tick = row.minTickSize > 0 ? row.minTickSize : 0.01
  const mid = yesBook.mid

  // Anchor postingDistancePct of the way from mid to the outer edge of the
  // reward zone. e.g. 0.85 * 4¢ = 3.4¢ behind mid.
  const targetDistance = Math.max(tick, config.postingDistancePct * maxSpreadDollars)

  const bidAnchor = mid - targetDistance
  const askAnchor = mid + targetDistance

  // Enforce a minimum tick buffer behind top of book so we're never the next
  // resting level the market would chew through.
  const bidCap = yesBook.bestBid - config.minTicksBehindTop * tick
  const askCap = yesBook.bestAsk + config.minTicksBehindTop * tick

  const bidPriceRaw = Math.min(bidAnchor, bidCap)
  const askPriceRaw = Math.max(askAnchor, askCap)

  // Round to the tick grid in the safer direction (lower bid, higher ask).
  const bidPrice = Math.max(tick, roundToTick(bidPriceRaw, tick, 'down'))
  const askPrice = Math.min(1 - tick, roundToTick(askPriceRaw, tick, 'up'))

  const halfCapital = config.perMarketCapitalUsd / 2
  const bidShares = halfCapital / Math.max(bidPrice, 0.01)
  const askShares = halfCapital / Math.max(askPrice, 0.01)
  const minSize = row.rewardMinSize

  if (bidShares < minSize) warnings.push(`bid ${bidShares.toFixed(0)} < min ${minSize}`)
  if (askShares < minSize) warnings.push(`ask ${askShares.toFixed(0)} < min ${minSize}`)

  const bidDistance = mid - bidPrice
  const askDistance = askPrice - mid

  if (bidDistance > maxSpreadDollars) warnings.push('bid outside reward zone')
  if (askDistance > maxSpreadDollars) warnings.push('ask outside reward zone')

  const bidDistanceFromTopCents = Math.max(0, (yesBook.bestBid - bidPrice) * 100)
  const askDistanceFromTopCents = Math.max(0, (askPrice - yesBook.bestAsk) * 100)

  const ourBidScore = levelScore(bidDistance, bidPrice * bidShares, maxSpreadDollars)
  const ourAskScore = levelScore(askDistance, askPrice * askShares, maxSpreadDollars)
  const ourScore = ourBidScore + ourAskScore

  const competingBid = competingScoreForSide(yesBook.bids, mid, maxSpreadDollars, 'bid')
  const competingAsk = competingScoreForSide(yesBook.asks, mid, maxSpreadDollars, 'ask')
  const competingScore = competingBid + competingAsk

  // Each side earns half the daily pool. Our per-side share = our_score / (our_score + competing_score).
  const bidSideShare = ourBidScore > 0 ? ourBidScore / (ourBidScore + competingBid) : 0
  const askSideShare = ourAskScore > 0 ? ourAskScore / (ourAskScore + competingAsk) : 0
  const expectedDailyUsd = (row.dailyRate / 2) * bidSideShare + (row.dailyRate / 2) * askSideShare

  const capitalUsd = config.perMarketCapitalUsd
  const yieldPctDaily = capitalUsd > 0 ? (expectedDailyUsd / capitalUsd) * 100 : 0

  return {
    conditionId: row.conditionId,
    slug: row.slug,
    question: row.question,
    dailyPool: row.dailyRate,
    maxSpreadCents: row.rewardMaxSpread,
    minSize: row.rewardMinSize,
    daysToResolution,
    midPrice: mid,
    bidPrice,
    askPrice,
    bidDistanceFromTopCents,
    askDistanceFromTopCents,
    sharesPerSide: Math.min(bidShares, askShares),
    ourScore,
    competingScore,
    expectedDailyUsd,
    capitalUsd,
    yieldPctDaily,
    warnings,
  }
}

export function runSimulation(rows: RewardsRow[], config: StrategyConfig): SimulationResult {
  const now = Date.now()

  const candidates = rows
    .filter((r) => r.dailyRate > 0)
    .filter((r) => {
      const days = daysUntil(r.endDateIso, now)
      return days === null || days >= config.minDaysToResolution
    })
    .map((r) => allocateMarket(r, config, now))
    .filter((a): a is StrategyAllocation => a !== null)
    .filter((a) => a.warnings.every((w) => !w.includes('outside reward zone')))
    .filter((a) => a.expectedDailyUsd > 0)
    .filter((a) => a.yieldPctDaily >= config.minYieldPct)
    .sort((a, b) => b.yieldPctDaily - a.yieldPctDaily)

  const allocations: StrategyAllocation[] = []
  let remaining = config.totalCapitalUsd
  for (const c of candidates) {
    if (remaining < c.capitalUsd) break
    allocations.push(c)
    remaining -= c.capitalUsd
  }

  const deployedCapital = allocations.reduce((s, a) => s + a.capitalUsd, 0)
  const expectedDailyUsd = allocations.reduce((s, a) => s + a.expectedDailyUsd, 0)
  const portfolioYieldPctDaily = deployedCapital > 0 ? (expectedDailyUsd / deployedCapital) * 100 : 0

  return {
    config,
    allocations,
    deployedCapital,
    expectedDailyUsd,
    portfolioYieldPctDaily,
  }
}
