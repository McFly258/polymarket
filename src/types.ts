export interface RawToken {
  token_id: string
  outcome: string
  price: number
  winner: boolean
}

export interface RawRewardRate {
  asset_address: string
  rewards_daily_rate: number
}

export interface RawRewards {
  rates: RawRewardRate[] | null
  min_size: number
  max_spread: number
}

export interface RawMarket {
  condition_id: string
  question_id: string
  question: string
  description: string
  market_slug: string
  end_date_iso: string | null
  icon: string | null
  image: string | null
  active: boolean
  closed: boolean
  archived: boolean
  accepting_orders: boolean
  enable_order_book: boolean
  minimum_order_size: number
  minimum_tick_size: number
  neg_risk: boolean
  is_50_50_outcome: boolean
  rewards: RawRewards
  tokens: RawToken[]
  tags: string[]
}

export interface RawBook {
  market: string
  asset_id: string
  timestamp: string
  hash: string
  bids: Array<{ price: string; size: string }>
  asks: Array<{ price: string; size: string }>
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
  /** Aggregate USD size ($=price*shares) sitting inside the reward zone. */
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

export interface DashboardTotals {
  markets: number
  dailyPool: number
  eligibleMarkets: number
}

export interface DashboardData {
  updatedAt: string
  rows: RewardsRow[]
  totals: DashboardTotals
}

export interface RewardHistoryPoint {
  ts: number
  daily_rate: number
  min_size: number
  max_spread: number
}

export interface BookHistoryPoint {
  token_id: string
  outcome: string
  ts: number
  mid: number | null
  spread: number | null
  qualifying_bid_size: number
  qualifying_ask_size: number
}

export interface MarketHistoryData {
  rewards: RewardHistoryPoint[]
  books: BookHistoryPoint[]
}

export interface StrategyConfig {
  totalCapitalUsd: number
  perMarketCapitalUsd: number
  /**
   * Where in the reward zone to post, as a fraction from mid (0) to outer edge (1).
   * 0.85 means post 85% of the way out — far behind top-of-book, low fill risk,
   * still earns ~15% of the max reward weight.
   */
  postingDistancePct: number
  /** Minimum number of ticks the order must sit behind best bid/ask. */
  minTicksBehindTop: number
  /** Minimum expected daily yield (%) to bother allocating capital. */
  minYieldPct: number
  /** Exclude markets resolving in less than N days (adverse selection spike). */
  minDaysToResolution: number
}

export interface StrategyAllocation {
  conditionId: string
  slug: string
  question: string
  dailyPool: number
  maxSpreadCents: number
  minSize: number
  daysToResolution: number | null
  /** Mid price the quotes are anchored to. */
  midPrice: number | null
  /** Suggested bid price (YES outcome) — our resting bid. */
  bidPrice: number | null
  /** Suggested ask price (YES outcome) — our resting ask. */
  askPrice: number | null
  /** Distance bid sits behind best bid, in cents. Higher = harder to fill. */
  bidDistanceFromTopCents: number
  /** Distance ask sits in front of best ask, in cents. */
  askDistanceFromTopCents: number
  /** Shares posted per side given perMarketCapitalUsd / 2. */
  sharesPerSide: number
  /** Sum of our qualifying score on both sides. */
  ourScore: number
  /** Total competing qualifying score on both sides. */
  competingScore: number
  /** Expected daily reward in USD. */
  expectedDailyUsd: number
  /** Capital deployed ($) for this allocation. */
  capitalUsd: number
  /** Annualised yield if we earn expectedDaily every day. */
  yieldPctDaily: number
  warnings: string[]
}

export interface SimulationResult {
  config: StrategyConfig
  allocations: StrategyAllocation[]
  deployedCapital: number
  expectedDailyUsd: number
  portfolioYieldPctDaily: number
}
