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

export interface BookSnapshot {
  tokenId: string
  outcome: string
  price: number
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  spread: number | null
  withinRewardSpread: boolean | null
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
