import type { BookView } from './wsClient.ts'

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

export type EngineState = 'idle' | 'running' | 'stopping'
