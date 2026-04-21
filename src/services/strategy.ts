import type {
  BookSnapshot,
  MarketVolatility,
  RewardsRow,
  SimulationResult,
  StrategyAllocation,
  StrategyConfig,
} from '../types'

export const DEFAULT_STRATEGY: StrategyConfig = {
  totalCapitalUsd: 2000,
  perMarketCapitalUsd: 30,
  postingDistancePct: 0.85,
  minTicksBehindTop: 2,
  minYieldPct: 0.05,
  minDaysToResolution: 7,
  // Polymarket CLOB is currently 0% maker/taker. Configurable so the strategy
  // stays honest if that changes.
  makerFeePct: 0,
  takerFeePct: 0,
  // Polymarket uses meta-transactions (relayer-paid gas), so user-visible gas
  // per order is effectively 0. If you wanted to self-relay the tx cost would
  // be ~$0.001 on Polygon — still negligible.
  gasCostPerOrderUsd: 0,
  // Reprice whenever the mid drifts more than 1 cent. Polymarket tick size is
  // often 0.1¢ or 1¢; 1¢ is a reasonable default that avoids chasing noise.
  repriceThresholdCents: 1,
  // Hedge inventory on a fill by crossing the opposite side. Safer than carrying
  // a directional book on a binary market, and matches how pros run these.
  hedgeFillsOnBook: true,
  // Risk criteria — see Notion "Polymarket Paper Trading — Risk Criteria to
  // Maximize PnL" doc for the rationale and the Iran Gulf state reference case.
  minPriceFloor: 0.05,
  minHedgeDepthMultiple: 5,
  maxFillsPerWindow: 3,
  fillWindowMinutes: 15,
  blacklistMinutes: 60,
  minExpectedRewardSharePct: 3,
  marketLossLimitUsd: 5,
  marketLossWindowHours: 24,
  closePositionDaysToResolution: 2,
  topUpWinnersEnabled: true,
  topUpMultiplier: 2,
  softFallbackEnabled: true,
  softFallbackCapitalFraction: 0.5,
  softFallbackMinSharePct: 1.5,
  softFallbackMinYieldPct: 0.02,
  asymmetricSizingEnabled: true,
}

// ── Reward scoring ──────────────────────────────────────────────────────────
// Polymarket pays rewards proportionally to a size-weighted score inside the
// reward zone (max_spread around mid). Their exact scoring function is
// piecewise; for allocation purposes a linear-decay approximation works fine:
//     weight(d) = max(0, 1 - d / max_spread)
// where d is the distance from mid and max_spread is in dollars. Size * weight
// is summed per side to get the total score, and each side earns half the pool.

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

export function daysUntil(iso: string | null, now: number): number | null {
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

// ── Repositioning + fill cost model ─────────────────────────────────────────
// Given a daily 1-sigma mid-move in dollars (σ) we can estimate:
//
// 1. Reprice frequency. We repost when the mid drifts more than
//    repriceThreshold dollars. In a driftless Brownian motion the expected
//    number of barrier crossings per day is approx (σ_daily / threshold)^2 / 2,
//    but that blows up at small thresholds. A cleaner rule-of-thumb, consistent
//    with empirical Polymarket behaviour: expected crossings ≈ σ / threshold.
//    We clamp to a sensible range.
//
// 2. Fill probability. Our resting order sits d dollars behind the touch. The
//    probability the mid moves past us within a day, one-sided, ≈ 2 * Φ(-d / σ),
//    where Φ is the standard-normal CDF. Each side is independent in the Brownian
//    approximation (fills on bid and fills on ask are disjoint random events).
//
// 3. Fill P&L. When our bid is hit, the mid has moved DOWN by at least d. We're
//    long at bidPrice vs. a new mid ≤ bidPrice → mark-to-market loss per share
//    ≈ d (floor; actual expected loss given a touch ≈ d + σ/√(2π), but we use d
//    as a conservative lower bound). If we hedge on the book we pay half-spread
//    plus takerFeePct to flip back to flat.

function stdNormalCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 approximation, max error ~7.5e-8.
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax)
  return 0.5 * (1 + sign * y)
}

interface CostInputs {
  shares: number
  price: number // our posted price
  distanceFromMid: number // dollars
  dailyVol: number // σ in dollars
  config: StrategyConfig
  bookSpread: number // $
}

interface SideCost {
  fillProb: number
  expectedLossUsd: number
  expectedFeeUsd: number
}

function sideFillCost({ shares, price, distanceFromMid, dailyVol, config, bookSpread }: CostInputs): SideCost {
  if (dailyVol <= 0 || distanceFromMid <= 0) {
    return { fillProb: 0, expectedLossUsd: 0, expectedFeeUsd: 0 }
  }
  // One-sided hit probability within a day (Brownian, zero drift).
  const fillProb = Math.min(1, 2 * stdNormalCdf(-distanceFromMid / dailyVol))
  const notional = shares * price

  // Maker fee charged on the fill.
  const makerFee = notional * config.makerFeePct

  // Mark-to-market loss from adverse mid move.
  const mtmLoss = shares * distanceFromMid

  // Hedging cost (cross the spread + taker fee) if we flatten post-fill.
  const hedgeCost = config.hedgeFillsOnBook
    ? shares * (bookSpread / 2) + notional * config.takerFeePct
    : 0

  const expectedLossUsd = fillProb * (mtmLoss + hedgeCost)
  const expectedFeeUsd = fillProb * makerFee
  return { fillProb, expectedLossUsd, expectedFeeUsd }
}

function repriceFrequencyPerDay(dailyVol: number, thresholdDollars: number): number {
  if (dailyVol <= 0 || thresholdDollars <= 0) return 0
  // σ / threshold, clamped to [0, 50] reprices/day. A $0.005 daily σ with a 1¢
  // threshold implies ~0.5 reprices/day — realistic for a calm market.
  const raw = dailyVol / thresholdDollars
  return Math.max(0, Math.min(50, raw))
}

function allocateMarket(
  row: RewardsRow,
  config: StrategyConfig,
  volatility: MarketVolatility | undefined,
  now: number,
): StrategyAllocation | null {
  const daysToResolution = daysUntil(row.endDateIso, now)
  const warnings: string[] = []

  const yesBook: BookSnapshot | undefined = row.books[0]
  if (!yesBook || yesBook.mid === null || yesBook.bestBid === null || yesBook.bestAsk === null) {
    return null
  }

  // Risk criterion #1 — min price floor. Pre-filter penny-tick books before we
  // burn cycles on scoring/cost math.
  const minFloor = config.minPriceFloor ?? DEFAULT_STRATEGY.minPriceFloor ?? 0
  if (minFloor > 0 && yesBook.bestBid < minFloor) return null

  // Risk criterion #2 — min hedge-side depth. The YES bid book is the hedge
  // venue when our resting bid fills (we sell to flatten); the YES ask book is
  // the hedge venue when our resting ask fills (we buy to flatten). Require
  // each side's qualifying depth (USD inside the reward zone) to be ≥ multiple
  // × our per-side notional.
  const hedgeMult = config.minHedgeDepthMultiple ?? DEFAULT_STRATEGY.minHedgeDepthMultiple ?? 0
  if (hedgeMult > 0) {
    const perSideNotional = config.perMarketCapitalUsd / 2
    const needed = hedgeMult * perSideNotional
    if (yesBook.qualifyingBidDepthUsd < needed) return null
    if (yesBook.qualifyingAskDepthUsd < needed) return null
  }

  const maxSpreadDollars = row.rewardMaxSpread / 100
  const tick = row.minTickSize > 0 ? row.minTickSize : 0.01
  const mid = yesBook.mid
  const bookSpread = yesBook.bestAsk - yesBook.bestBid

  // Anchor posting depth inside the reward zone.
  const targetDistance = Math.max(tick, config.postingDistancePct * maxSpreadDollars)
  const bidAnchor = mid - targetDistance
  const askAnchor = mid + targetDistance
  const bidCap = yesBook.bestBid - config.minTicksBehindTop * tick
  const askCap = yesBook.bestAsk + config.minTicksBehindTop * tick
  const bidPriceRaw = Math.min(bidAnchor, bidCap)
  const askPriceRaw = Math.max(askAnchor, askCap)
  const bidPrice = Math.max(tick, roundToTick(bidPriceRaw, tick, 'down'))
  const askPrice = Math.min(1 - tick, roundToTick(askPriceRaw, tick, 'up'))

  const totalCapital = config.perMarketCapitalUsd
  const halfCapital = totalCapital / 2
  // Asymmetric sizing is computed after share scores — placeholder shares for score calculation
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

  // ── Gross reward ──
  const ourBidScore = levelScore(bidDistance, bidPrice * bidShares, maxSpreadDollars)
  const ourAskScore = levelScore(askDistance, askPrice * askShares, maxSpreadDollars)
  const ourScore = ourBidScore + ourAskScore
  const competingBid = competingScoreForSide(yesBook.bids, mid, maxSpreadDollars, 'bid')
  const competingAsk = competingScoreForSide(yesBook.asks, mid, maxSpreadDollars, 'ask')
  const competingScore = competingBid + competingAsk
  const bidSideShare = ourBidScore > 0 ? ourBidScore / (ourBidScore + competingBid) : 0
  const askSideShare = ourAskScore > 0 ? ourAskScore / (ourAskScore + competingAsk) : 0

  // Risk criterion — competing score gate. Skip markets where our expected reward
  // share (averaged across both sides) falls below the configured threshold.
  // Entering such markets means absorbing fill risk for near-zero reward income.
  const minSharePct = config.minExpectedRewardSharePct ?? DEFAULT_STRATEGY.minExpectedRewardSharePct ?? 0
  const avgSharePct = ((bidSideShare + askSideShare) / 2) * 100
  if (minSharePct > 0 && avgSharePct < minSharePct) {
    console.log(
      `[strategy] skip ${row.conditionId.slice(0, 8)} — share ${avgSharePct.toFixed(2)}% < ${minSharePct}%`,
    )
    return null
  }

  // Asymmetric per-side sizing: split total capital proportionally to share, clamped [30%, 70%].
  // When one side dominates (e.g. bid 80% share, ask 5%), put more capital on the dominant side
  // to earn more rewards. Total notional stays the same — zero risk delta.
  const asymEnabled = config.asymmetricSizingEnabled !== false // default true
  let bidCapitalUsd = halfCapital
  let askCapitalUsd = halfCapital
  if (asymEnabled && bidSideShare + askSideShare > 0) {
    const rawBidFrac = bidSideShare / (bidSideShare + askSideShare)
    const bidFrac = Math.min(0.7, Math.max(0.3, rawBidFrac))
    bidCapitalUsd = totalCapital * bidFrac
    askCapitalUsd = totalCapital * (1 - bidFrac)
  }

  const grossDailyUsd = row.dailyRate * bidSideShare * (bidCapitalUsd / totalCapital) +
    row.dailyRate * askSideShare * (askCapitalUsd / totalCapital)

  // ── Costs from volatility-driven reposting + fills ──
  const dailyVol = volatility?.dailyStddevDollars ?? 0

  // Use asymmetric share counts for cost modelling so fill-cost scales with actual deployment.
  const bidSharesAsym = bidCapitalUsd / Math.max(bidPrice, 0.01)
  const askSharesAsym = askCapitalUsd / Math.max(askPrice, 0.01)

  const bidCost = sideFillCost({
    shares: bidSharesAsym,
    price: bidPrice,
    distanceFromMid: bidDistance,
    dailyVol,
    config,
    bookSpread,
  })
  const askCost = sideFillCost({
    shares: askSharesAsym,
    price: askPrice,
    distanceFromMid: askDistance,
    dailyVol,
    config,
    bookSpread,
  })
  const expectedFillCostUsd =
    bidCost.expectedLossUsd + bidCost.expectedFeeUsd + askCost.expectedLossUsd + askCost.expectedFeeUsd

  const repricesPerDay = repriceFrequencyPerDay(dailyVol, config.repriceThresholdCents / 100)
  // Each reprice = cancel+repost on both sides = 4 order ops.
  const expectedRepriceCostUsd = repricesPerDay * 4 * config.gasCostPerOrderUsd

  const netDailyUsd = grossDailyUsd - expectedFillCostUsd - expectedRepriceCostUsd
  const capitalUsd = totalCapital
  const yieldPctDaily = capitalUsd > 0 ? (netDailyUsd / capitalUsd) * 100 : 0

  if (dailyVol === 0) warnings.push('no volatility history — costs assumed 0')
  if (expectedFillCostUsd > grossDailyUsd) warnings.push('fill risk exceeds gross reward')

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
    grossDailyUsd,
    expectedDailyUsd: netDailyUsd,
    capitalUsd,
    bidCapitalUsd,
    askCapitalUsd,
    bidSideShare,
    askSideShare,
    yieldPctDaily,
    dailyVolUsd: dailyVol,
    expectedRepricesPerDay: repricesPerDay,
    expectedRepriceCostUsd,
    expectedFillsPerDayPerSide: (bidCost.fillProb + askCost.fillProb) / 2,
    expectedFillCostUsd,
    warnings,
  }
}

function scoreAndFilter(
  rows: RewardsRow[],
  config: StrategyConfig,
  volatility: Record<string, MarketVolatility>,
  now: number,
  minYieldPct: number,
): StrategyAllocation[] {
  return rows
    .map((r) => allocateMarket(r, config, volatility[r.conditionId], now))
    .filter((a): a is StrategyAllocation => a !== null)
    .filter((a) => a.warnings.every((w) => !w.includes('outside reward zone')))
    .filter((a) => a.expectedDailyUsd > 0)
    .filter((a) => a.yieldPctDaily >= minYieldPct)
    .sort((a, b) => b.yieldPctDaily - a.yieldPctDaily)
}

export function runSimulation(
  rows: RewardsRow[],
  config: StrategyConfig,
  volatility: Record<string, MarketVolatility> = {},
): SimulationResult {
  const now = Date.now()

  const pool = rows
    .filter((r) => r.dailyRate > 0)
    .filter((r) => {
      const days = daysUntil(r.endDateIso, now)
      return days === null || days >= config.minDaysToResolution
    })

  // ── Primary pass ──
  const candidates = scoreAndFilter(pool, config, volatility, now, config.minYieldPct)

  const allocations: StrategyAllocation[] = []
  let remaining = config.totalCapitalUsd
  const occupied = new Set<string>()
  for (const c of candidates) {
    if (remaining < c.capitalUsd) break
    allocations.push(c)
    remaining -= c.capitalUsd
    occupied.add(c.conditionId)
  }

  // ── Top-up pass — re-score held markets at `topUpMultiplier` × per-market cap.
  // Reusing allocateMarket re-runs the hedge-depth + competing-share + yield
  // filters at the larger notional, so only markets that still clear every gate
  // at the upsized capital get topped up. Iterates highest-yield first to
  // prioritise our strongest edges.
  const topUpEnabled = config.topUpWinnersEnabled ?? true
  const topUpMultiplier = config.topUpMultiplier ?? 2
  if (topUpEnabled && topUpMultiplier > 1) {
    const topUpConfig: StrategyConfig = {
      ...config,
      perMarketCapitalUsd: config.perMarketCapitalUsd * topUpMultiplier,
    }
    const rowById = new Map(pool.map((r) => [r.conditionId, r]))
    for (let i = 0; i < allocations.length; i++) {
      const orig = allocations[i]
      const row = rowById.get(orig.conditionId)
      if (!row) continue
      const upsized = allocateMarket(row, topUpConfig, volatility[row.conditionId], now)
      if (!upsized) continue
      if (!upsized.warnings.every((w) => !w.includes('outside reward zone'))) continue
      if (upsized.expectedDailyUsd <= 0) continue
      if (upsized.yieldPctDaily < config.minYieldPct) continue
      const delta = upsized.capitalUsd - orig.capitalUsd
      if (delta <= 0 || delta > remaining) continue
      allocations[i] = upsized
      remaining -= delta
    }
  }

  // ── Soft fallback — fills any remaining budget with looser-threshold markets
  // at a fraction of the per-market cap. Smaller per-market exposure keeps the
  // worst-case loss bounded at ~`softFallbackCapitalFraction` × the primary cap,
  // while still capturing rewards on markets that narrowly missed the main gate.
  const softEnabled = config.softFallbackEnabled ?? true
  if (softEnabled && remaining > 0) {
    const fraction = config.softFallbackCapitalFraction ?? 0.5
    const fallbackConfig: StrategyConfig = {
      ...config,
      perMarketCapitalUsd: Math.max(1, config.perMarketCapitalUsd * fraction),
      minExpectedRewardSharePct: config.softFallbackMinSharePct ?? 1.5,
    }
    const fallbackMinYield = config.softFallbackMinYieldPct ?? 0.02
    const remainingPool = pool.filter((r) => !occupied.has(r.conditionId))
    const fallbackCandidates = scoreAndFilter(remainingPool, fallbackConfig, volatility, now, fallbackMinYield)
    for (const c of fallbackCandidates) {
      if (remaining < c.capitalUsd) break
      allocations.push(c)
      remaining -= c.capitalUsd
      occupied.add(c.conditionId)
    }
  }

  const deployedCapital = allocations.reduce((s, a) => s + a.capitalUsd, 0)
  const grossDailyUsd = allocations.reduce((s, a) => s + a.grossDailyUsd, 0)
  const expectedDailyUsd = allocations.reduce((s, a) => s + a.expectedDailyUsd, 0)
  const totalCostUsd = allocations.reduce(
    (s, a) => s + a.expectedFillCostUsd + a.expectedRepriceCostUsd,
    0,
  )
  const portfolioYieldPctDaily = deployedCapital > 0 ? (expectedDailyUsd / deployedCapital) * 100 : 0

  return {
    config,
    allocations,
    deployedCapital,
    grossDailyUsd,
    expectedDailyUsd,
    portfolioYieldPctDaily,
    totalCostUsd,
  }
}
