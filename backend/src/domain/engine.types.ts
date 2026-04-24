import type { BookView } from './book.types'

export type EngineState = 'idle' | 'running' | 'stopping'

export interface InternalPosition {
  conditionId: string
  question: string
  tokenId: string
  outcome: string
  bidOrderId: string | null
  askOrderId: string | null
  bidPrice: number
  askPrice: number
  bidSize: number
  askSize: number
  maxSpreadDollars: number
  dailyPool: number
  midPrice: number | null
  bestBid: number | null
  bestAsk: number | null
  rewardSharePct: number
  expectedRatePerDay: number
  capitalUsd: number
  totalEarnedUsd: number
  earnedSinceLastSnapshot: number
  ourScore: number
  totalScore: number
  latestBook: BookView | null
}

export interface FillEntry {
  side: 'bid' | 'ask'
  time: number
}

export interface PnlEntry {
  time: number
  pnl: number
}

export interface InventoryBias {
  bias: 'long' | 'short'
  until: number
}
