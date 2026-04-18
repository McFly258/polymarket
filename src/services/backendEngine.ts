// Frontend client for the backend paper-trading engine.
//
// Polls /paper-api/state every POLL_MS and exposes an EngineSnapshot in the
// same shape the browser PaperTradingEngine returns, so the PaperTradingPanel
// can render either source interchangeably.

import type { StrategyConfig } from '../types'
import type { EngineSnapshot, FillEvent, PaperPosition, PhantomOrder, RewardAccrual } from './paperTrading'

const POLL_MS = 1_000
const BASE = '/paper-api'

interface ServerOrderRow {
  id: string; conditionId: string; tokenId: string; outcome: string; side: 'bid' | 'ask'
  price: number; size: number; status: 'resting' | 'filled' | 'cancelled'
  postedAt: number; postedBestBid: number | null; postedBestAsk: number | null; closedAt: number | null
}
interface ServerFillRow {
  id: string; orderId: string; conditionId: string; question: string; side: 'bid' | 'ask'
  fillPrice: number; size: number; hedgePrice: number
  realisedPnlUsd: number; makerFeeUsd: number; takerFeeUsd: number
  filledAt: number; hedgeOrderId: string | null; hedgeStatus: 'pending' | 'done' | 'failed'
}
interface ServerPositionRow {
  conditionId: string; question: string; tokenId: string; outcome: string
  bidOrderId: string | null; askOrderId: string | null
  bidPrice: number; askPrice: number; bidSize: number; askSize: number
  maxSpreadDollars: number; dailyPool: number
  midPrice: number | null; bestBid: number | null; bestAsk: number | null
  rewardSharePct: number; expectedRatePerDay: number; updatedAt: number
}
interface ServerSnapshot {
  state: 'idle' | 'running' | 'stopping'
  startedAt: number | null
  brokerKind: 'paper' | 'live'
  config: StrategyConfig | null
  orders: ServerOrderRow[]
  fills: ServerFillRow[]
  reward: { totalEarnedUsd: number; lastRatePerDay: number; lastUpdatedAt: number }
  positions: ServerPositionRow[]
  lastAllocAt: number | null
}

function toOrder(o: ServerOrderRow): PhantomOrder {
  return {
    id: o.id, conditionId: o.conditionId, tokenId: o.tokenId, outcome: o.outcome,
    side: o.side, price: o.price, size: o.size, postedAt: o.postedAt, status: o.status,
    postedBestBid: o.postedBestBid, postedBestAsk: o.postedBestAsk,
  }
}
function toFill(f: ServerFillRow): FillEvent {
  return {
    id: f.id, orderId: f.orderId, conditionId: f.conditionId, question: f.question,
    side: f.side, fillPrice: f.fillPrice, size: f.size, hedgePrice: f.hedgePrice,
    realisedPnlUsd: f.realisedPnlUsd, makerFeeUsd: f.makerFeeUsd, takerFeeUsd: f.takerFeeUsd,
    filledAt: f.filledAt, hedgeOrderId: f.hedgeOrderId, hedgeStatus: f.hedgeStatus,
  }
}
function toPosition(p: ServerPositionRow): PaperPosition {
  return {
    conditionId: p.conditionId, question: p.question,
    bidOrderId: p.bidOrderId, askOrderId: p.askOrderId,
    midPrice: p.midPrice, bestBid: p.bestBid, bestAsk: p.bestAsk,
    rewardSharePct: p.rewardSharePct, expectedRatePerDay: p.expectedRatePerDay,
  }
}

export interface RewardHourlyPoint {
  hourEpoch: number
  snapshotAt: number
  totalEarnedUsd: number
  ratePerDay: number
}

export interface PositionRewardHourlyPoint {
  hourEpoch: number
  snapshotAt: number
  conditionId: string
  question: string
  rewardSharePct: number
  expectedRatePerDay: number
  earnedThisHourUsd: number
}

export interface BackendEngineClient {
  snapshot(): EngineSnapshot
  subscribe(fn: () => void): () => void
  start(config: StrategyConfig): Promise<void>
  stop(): Promise<void>
  resetHistory(): Promise<void>
  /** Null when we haven't reached the server yet. */
  lastError(): string | null
  fetchRewardHistory(limit?: number): Promise<RewardHourlyPoint[]>
  fetchPositionRewardHistory(conditionId?: string, limit?: number): Promise<PositionRewardHourlyPoint[]>
  fetchFillsHistory(limit?: number): Promise<FillEvent[]>
}

function emptySnapshot(): EngineSnapshot {
  const reward: RewardAccrual = { totalEarnedUsd: 0, lastRatePerDay: 0, lastUpdatedAt: Date.now() }
  return {
    state: 'idle',
    startedAt: null,
    brokerKind: 'paper',
    config: {} as StrategyConfig,
    orders: [],
    fills: [],
    reward,
    positions: [],
  }
}

class BackendEngineClientImpl implements BackendEngineClient {
  private snap: EngineSnapshot = emptySnapshot()
  private listeners = new Set<() => void>()
  private timer: number | null = null
  private error: string | null = null

  constructor() {
    void this.poll()
    this.timer = window.setInterval(() => void this.poll(), POLL_MS)
  }

  snapshot(): EngineSnapshot {
    return this.snap
  }

  lastError(): string | null {
    return this.error
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async start(config: StrategyConfig): Promise<void> {
    const res = await fetch(`${BASE}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (!res.ok) throw new Error(`start failed: ${res.status}`)
    await this.poll()
  }

  async stop(): Promise<void> {
    const res = await fetch(`${BASE}/stop`, { method: 'POST' })
    if (!res.ok) throw new Error(`stop failed: ${res.status}`)
    await this.poll()
  }

  async resetHistory(): Promise<void> {
    const res = await fetch(`${BASE}/reset`, { method: 'POST' })
    if (!res.ok) throw new Error(`reset failed: ${res.status}`)
    await this.poll()
  }

  async fetchRewardHistory(limit = 168): Promise<RewardHourlyPoint[]> {
    const res = await fetch(`${BASE}/reward-history?limit=${limit}`)
    if (!res.ok) throw new Error(`reward-history ${res.status}`)
    return (await res.json()) as RewardHourlyPoint[]
  }

  async fetchPositionRewardHistory(conditionId?: string, limit = 168): Promise<PositionRewardHourlyPoint[]> {
    const qs = new URLSearchParams({ limit: String(limit) })
    if (conditionId) qs.set('conditionId', conditionId)
    const res = await fetch(`${BASE}/position-reward-history?${qs.toString()}`)
    if (!res.ok) throw new Error(`position-reward-history ${res.status}`)
    return (await res.json()) as PositionRewardHourlyPoint[]
  }

  async fetchFillsHistory(limit = 10_000): Promise<FillEvent[]> {
    const res = await fetch(`${BASE}/fills-history?limit=${limit}`)
    if (!res.ok) throw new Error(`fills-history ${res.status}`)
    const rows = (await res.json()) as ServerFillRow[]
    return rows.map(toFill)
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch(`${BASE}/state`)
      if (!res.ok) {
        this.error = `state ${res.status}`
        this.notify()
        return
      }
      const data = (await res.json()) as ServerSnapshot
      this.snap = {
        state: data.state,
        startedAt: data.startedAt,
        brokerKind: data.brokerKind,
        config: (data.config ?? {}) as StrategyConfig,
        orders: data.orders.map(toOrder),
        fills: data.fills.map(toFill),
        reward: data.reward,
        positions: data.positions.map(toPosition),
      }
      this.error = null
      this.notify()
    } catch (err) {
      this.error = (err as Error).message
      this.notify()
    }
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }
}

let singleton: BackendEngineClient | null = null
export function getBackendEngine(): BackendEngineClient {
  if (!singleton) singleton = new BackendEngineClientImpl()
  return singleton
}
