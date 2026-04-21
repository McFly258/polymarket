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
  /** Minimum expected NET daily yield (%) to bother allocating capital. */
  minYieldPct: number
  /** Exclude markets resolving in less than N days (adverse selection spike). */
  minDaysToResolution: number
  /** Maker fee as a fraction of notional per fill (0.00 = no fee, Polymarket default today). */
  makerFeePct: number
  /** Taker fee as a fraction of notional — used when we hedge inventory after a fill. */
  takerFeePct: number
  /** USD gas cost per order operation (place or cancel). Polymarket uses meta-tx so default is 0. */
  gasCostPerOrderUsd: number
  /**
   * Reprice when the mid moves by more than this many cents. Smaller = more
   * reposts (more gas cost) but quotes stay well-placed; larger = fewer reposts
   * but more time outside the reward zone.
   */
  repriceThresholdCents: number
  /**
   * If true, assume we taker-hedge inventory back to flat immediately on any fill
   * (costs takerFeePct notional + crossing the spread). If false, we hold the
   * position and carry the P&L to resolution — riskier, no hedge cost.
   */
  hedgeFillsOnBook: boolean
  /**
   * Risk criterion #1 — min price floor. Skip markets where YES bestBid is below
   * this dollar floor. Penny-tick markets ($0.01) hedge at $0.001 = ~90% slippage,
   * which obliterates reward accrual. Optional for back-compat with stored configs.
   */
  minPriceFloor?: number
  /**
   * Risk criterion #2 — min hedge-side depth multiple. Require qualifying USD
   * depth on each side of the YES book to be ≥ this multiple of our per-side
   * notional (perMarketCapitalUsd / 2). Thin hedge books cause large slippage
   * on a fill. Optional for back-compat with stored configs.
   */
  minHedgeDepthMultiple?: number
  /**
   * Adverse-selection detector: max same-side fills within fillWindowMinutes
   * before the engine closes the position and blacklists the market.
   * Optional — defaults to 3.
   */
  maxFillsPerWindow?: number
  /** Rolling window length for the fill counter, in minutes. Defaults to 15. */
  fillWindowMinutes?: number
  /** How long (minutes) to blacklist a market after triggering. Defaults to 60. */
  blacklistMinutes?: number
}

/** Per-market daily volatility estimate (std-dev of mid moves, in dollars). */
export interface MarketVolatility {
  conditionId: string
  dailyStddevDollars: number
  samples: number
  hoursCovered: number
}

export interface VolatilityMap {
  volatility: Record<string, MarketVolatility>
  windowHours: number
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
  /** Gross daily reward in USD (before fees/fills/gas). */
  grossDailyUsd: number
  /** Net daily USD after fees, expected fill P&L, and reprice gas costs. */
  expectedDailyUsd: number
  /** Capital deployed ($) for this allocation. */
  capitalUsd: number
  /** Net yield per day as a percentage of capitalUsd. */
  yieldPctDaily: number
  /** Daily mid volatility (USD, 1 sigma) used in the fill/reprice model. */
  dailyVolUsd: number
  /** Expected number of reprices per day given mid volatility + reprice threshold. */
  expectedRepricesPerDay: number
  /** Expected USD gas cost per day for reprices (cancel+repost, both sides). */
  expectedRepriceCostUsd: number
  /** Expected number of fills per day (per side). */
  expectedFillsPerDayPerSide: number
  /** Expected fill-related USD cost per day (adverse selection + maker/taker fees). */
  expectedFillCostUsd: number
  warnings: string[]
}

export interface SimulationResult {
  config: StrategyConfig
  allocations: StrategyAllocation[]
  deployedCapital: number
  /** Sum of gross daily rewards before costs. */
  grossDailyUsd: number
  /** Sum of net daily P&L after fees, fills, and gas. */
  expectedDailyUsd: number
  /** Net portfolio yield (net daily / deployed). */
  portfolioYieldPctDaily: number
  /** Total expected daily cost (fills + gas) across the portfolio. */
  totalCostUsd: number
}
