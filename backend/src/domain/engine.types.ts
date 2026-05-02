import type { BookView } from './book.types'

export type EngineState = 'idle' | 'running' | 'stopping'

export interface InternalPosition {
  conditionId: string
  question: string
  tokenId: string
  noTokenId?: string
  outcome: string
  decisionId: string | null
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
  // Set when one side fills naturally while the opposing order is still live.
  // Cleared when the opposing order fills — no external hedge needed for either leg.
  pendingPairFill?: 'bid' | 'ask'
  // Epoch ms when pendingPairFill was last set — used by the max-hold-time circuit breaker.
  pendingPairFillAt?: number
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
