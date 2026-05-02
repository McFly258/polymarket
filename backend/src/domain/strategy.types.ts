export interface StrategyConfig {
  totalCapitalUsd: number
  perMarketCapitalUsd: number
  postingDistancePct: number
  minTicksBehindTop: number
  minYieldPct: number
  minDaysToResolution: number
  makerFeePct: number
  takerFeePct: number
  gasCostPerOrderUsd: number
  repriceThresholdCents: number
  hedgeFillsOnBook: boolean
  minPriceFloor?: number
  minHedgeDepthMultiple?: number
  maxFillsPerWindow?: number
  fillWindowMinutes?: number
  blacklistMinutes?: number
  minExpectedRewardSharePct?: number
  marketLossLimitUsd?: number
  marketLossWindowHours?: number
  marketLossBlacklistMinutes?: number
  globalLossLimitUsd?: number
  globalLossWindowHours?: number
  globalPauseMinutes?: number
  closePositionDaysToResolution?: number
  topUpWinnersEnabled?: boolean
  topUpMultiplier?: number
  softFallbackEnabled?: boolean
  softFallbackCapitalFraction?: number
  softFallbackMinSharePct?: number
  softFallbackMinYieldPct?: number
  asymmetricSizingEnabled?: boolean
  enforceRewardMinSize?: boolean
  subMinFallbackEnabled?: boolean
  maxRewardMinSize?: number
  mtmStopLossPct?: number
  maxInventoryHoldMinutes?: number
}

export interface StrategyAllocation {
  conditionId: string
  slug: string
  question: string
  dailyPool: number
  maxSpreadCents: number
  minSize: number
  daysToResolution: number | null
  midPrice: number | null
  bidPrice: number | null
  askPrice: number | null
  bidDistanceFromTopCents: number
  askDistanceFromTopCents: number
  sharesPerSide: number
  ourScore: number
  competingScore: number
  grossDailyUsd: number
  expectedDailyUsd: number
  capitalUsd: number
  bidCapitalUsd: number
  askCapitalUsd: number
  bidSideShare: number
  askSideShare: number
  yieldPctDaily: number
  dailyVolUsd: number
  expectedRepricesPerDay: number
  expectedRepriceCostUsd: number
  expectedFillsPerDayPerSide: number
  expectedFillCostUsd: number
  warnings: string[]
}

export interface SimulationResult {
  config: StrategyConfig
  allocations: StrategyAllocation[]
  deployedCapital: number
  grossDailyUsd: number
  expectedDailyUsd: number
  portfolioYieldPctDaily: number
  totalCostUsd: number
}

export interface MarketVolatility {
  conditionId: string
  dailyStddevDollars: number
  samples: number
  hoursCovered: number
}

export interface BookLevelSnapshot {
  price: number
  size: number
}

export interface BookSnapshot {
  tokenId: string
  outcome: string
  price: number
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  spread: number | null
  withinRewardSpread: boolean | null
  qualifyingBidDepthUsd: number
  qualifyingAskDepthUsd: number
  bids: BookLevelSnapshot[]
  asks: BookLevelSnapshot[]
}

export interface RewardsRow {
  conditionId: string
  slug: string
  question: string
  icon: string | null
  endDateIso: string | null
  tags: string[]
  minOrderSize: number
  minTickSize: number
  rewardMinSize: number
  rewardMaxSpread: number
  dailyRate: number
  books: BookSnapshot[]
  eligibleSides: number
}
