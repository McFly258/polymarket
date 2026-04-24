import type { StrategyConfig } from '../../domain/strategy.types'
import type { EngineState, InventoryBias, InternalPosition, FillEntry, PnlEntry } from '../../domain/engine.types'
import type { WsClient } from '../polymarket/market-ws.service'

// Mutable in-memory state owned by EngineService. Collaborator services
// (alloc, fill, rewards) receive this by reference so they can read and
// mutate without round-tripping through method calls on the engine itself.
export interface EngineRuntimeState {
  state: EngineState
  startedAt: number | null
  config: StrategyConfig | null
  positions: Map<string, InternalPosition>
  fillHistory: Map<string, FillEntry[]>
  blacklist: Map<string, number>
  marketPnlHistory: Map<string, PnlEntry[]>
  inventoryBias: Map<string, InventoryBias>
  portfolioPnlHistory: PnlEntry[]
  globalPauseUntil: number
  rewardTotal: number
  rewardLastRate: number
  rewardLastUpdatedAt: number
  ws: WsClient | null
}

export function createEngineRuntimeState(): EngineRuntimeState {
  return {
    state: 'idle',
    startedAt: null,
    config: null,
    positions: new Map(),
    fillHistory: new Map(),
    blacklist: new Map(),
    marketPnlHistory: new Map(),
    inventoryBias: new Map(),
    portfolioPnlHistory: [],
    globalPauseUntil: 0,
    rewardTotal: 0,
    rewardLastRate: 0,
    rewardLastUpdatedAt: Date.now(),
    ws: null,
  }
}

export function positionRowFromInternal(pos: InternalPosition, now: number) {
  return {
    conditionId: pos.conditionId,
    question: pos.question,
    tokenId: pos.tokenId,
    outcome: pos.outcome,
    bidOrderId: pos.bidOrderId,
    askOrderId: pos.askOrderId,
    bidPrice: pos.bidPrice,
    askPrice: pos.askPrice,
    bidSize: pos.bidSize,
    askSize: pos.askSize,
    maxSpreadDollars: pos.maxSpreadDollars,
    dailyPool: pos.dailyPool,
    midPrice: pos.midPrice,
    bestBid: pos.bestBid,
    bestAsk: pos.bestAsk,
    rewardSharePct: pos.rewardSharePct,
    expectedRatePerDay: pos.expectedRatePerDay,
    capitalUsd: pos.capitalUsd,
    updatedAt: now,
  }
}
