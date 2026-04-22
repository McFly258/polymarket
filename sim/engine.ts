// Backend paper-trading engine.
//
// Mirrors src/services/paperTrading.ts but runs as a standalone Node process
// so the simulation keeps running when no browser is open.
//
// Lifecycle:
//   1. start(config) — fetch markets, run the allocator, post phantom orders
//      via PaperBroker, open a WS stream for every token we hold.
//   2. WS book updates feed evaluateBook(). If a phantom order's price is
//      crossed by the new top-of-book we mark it filled and market-hedge back
//      to flat.
//   3. Every REWARD_TICK_MS we integrate reward accrual from each position's
//      instantaneous score share.
//   4. Every REALLOC_MS we fetch fresh markets, rebuild allocations, and
//      cancel/replace positions that no longer make the cut (or whose prices
//      have drifted materially).
//
// Everything persists to the existing polymarket.db via sim/db.ts. On restart
// we automatically resume if the last state was 'running'.
//
// Swapping to a live driver is a one-line change: pass a LiveBroker to the
// constructor instead of defaulting to PaperBroker. All fill detection, hedge,
// reward accrual, and re-alloc logic is broker-agnostic.
//
// Module layout:
//   - engineAlloc.ts   — reallocate / openPosition / closePosition / repositionMarket
//   - engineFill.ts    — evaluateBook + post-fill handling (hedge + breakers)
//   - engineRewards.ts — accrueRewards + hourly snapshot
//   - engineRisk.ts    — pure breaker decisions (adverse selection, drawdowns)
//   - engineConstants.ts / engineData.ts / engineNotify.ts / engineTypes.ts

import { PaperBroker, type Broker } from '../src/services/broker.ts'
import type { StrategyConfig } from '../src/types.ts'
import {
  cancelAllRestingOrders,
  clearAllPositions,
  fullReset,
  readEngineState,
  readPositions,
  readRecentFills,
  readRecentOrders,
  readReward,
  writeEngineState,
  type PositionRow,
} from './db.ts'
import { startMarketStream, type WsClient } from './wsClient.ts'
import { REALLOC_MS, REWARD_TICK_MS } from './engineConstants.ts'
import type { EngineState, InternalPosition } from './engineTypes.ts'
import { reallocate } from './engineAlloc.ts'
import { evaluateBook } from './engineFill.ts'
import { accrueRewards, takeHourlySnapshot } from './engineRewards.ts'

export class BackendPaperEngine {
  // State exposed to extracted modules (engineAlloc / engineFill / engineRewards).
  // These were `private` before chunking; the engine still owns them, the
  // modules just need read/write access without round-tripping through methods.
  state: EngineState = 'idle'
  startedAt: number | null = null
  config: StrategyConfig | null = null
  positions = new Map<string, InternalPosition>()
  // Adverse-selection detector state
  fillHistory = new Map<string, Array<{ side: 'bid' | 'ask'; time: number }>>()
  blacklist = new Map<string, number>() // conditionId → expiry timestamp (ms)
  // Per-market drawdown — rolling realised PnL per fill, keyed by conditionId
  marketPnlHistory = new Map<string, Array<{ time: number; pnl: number }>>()
  // Inventory skew — tracks which side was most recently filled per market
  inventoryBias = new Map<string, { bias: 'long' | 'short'; until: number }>()
  // Portfolio-wide drawdown — rolling realised PnL across every market
  portfolioPnlHistory: Array<{ time: number; pnl: number }> = []
  globalPauseUntil = 0
  rewardTotal = 0
  rewardLastRate = 0
  rewardLastUpdatedAt = Date.now()
  readonly broker: Broker

  private rewardTimer: NodeJS.Timeout | null = null
  private reallocTimer: NodeJS.Timeout | null = null
  private hourlySnapshotTimer: NodeJS.Timeout | null = null
  private ws: WsClient | null = null

  constructor(broker: Broker = new PaperBroker()) {
    this.broker = broker
    // Restore reward accrual from DB so the 'running' uptime survives restart.
    const reward = readReward()
    this.rewardTotal = reward.totalEarnedUsd
    this.rewardLastRate = reward.lastRatePerDay
    this.rewardLastUpdatedAt = reward.lastUpdatedAt
  }

  /** Auto-resume if the DB says we were running when the process died. */
  async resumeIfNeeded(): Promise<void> {
    const s = readEngineState()
    if (s.state !== 'running' || !s.configJson) return
    try {
      const config = JSON.parse(s.configJson) as StrategyConfig
      console.log('[engine] resuming previous run from DB…')
      // Cancel any leftover resting orders from the crashed run; we'll rebuild
      // fresh positions from the latest market state.
      cancelAllRestingOrders(Date.now())
      clearAllPositions()
      await this.start(config, { resumed: true, prevStartedAt: s.startedAt })
    } catch (err) {
      console.error('[engine] resume failed, staying idle:', err)
      writeEngineState({ state: 'idle', startedAt: null, configJson: null, lastAllocAt: null })
    }
  }

  async start(config: StrategyConfig, opts: { resumed?: boolean; prevStartedAt?: number | null } = {}): Promise<void> {
    if (this.state === 'running') return
    this.state = 'running'
    this.startedAt = opts.resumed && opts.prevStartedAt ? opts.prevStartedAt : Date.now()
    this.config = config
    this.marketPnlHistory.clear()
    this.portfolioPnlHistory = []
    this.globalPauseUntil = 0

    writeEngineState({
      state: 'running',
      startedAt: this.startedAt,
      configJson: JSON.stringify(config),
      lastAllocAt: Date.now(),
    })

    await reallocate(this)
    this.scheduleRewardTick()
    this.scheduleRealloc()
    this.scheduleHourlySnapshot()
    console.log(`[engine] started — ${this.positions.size} positions, uptime anchor ${new Date(this.startedAt).toISOString()}`)
  }

  async stop(): Promise<void> {
    if (this.state !== 'running') return
    this.state = 'stopping'

    if (this.rewardTimer) { clearInterval(this.rewardTimer); this.rewardTimer = null }
    if (this.reallocTimer) { clearInterval(this.reallocTimer); this.reallocTimer = null }
    if (this.hourlySnapshotTimer) { clearInterval(this.hourlySnapshotTimer); this.hourlySnapshotTimer = null }
    if (this.ws) { this.ws.stop(); this.ws = null }

    const now = Date.now()
    const orders = readRecentOrders(2000)
    const resting = orders.filter((o) => o.status === 'resting')
    await Promise.all(resting.map((o) => this.broker.cancelOrder(o.id)))
    cancelAllRestingOrders(now)
    clearAllPositions()
    this.positions.clear()

    this.state = 'idle'
    this.startedAt = null
    writeEngineState({ state: 'idle', startedAt: null, configJson: null, lastAllocAt: null })
    console.log('[engine] stopped')
  }

  resetHistory(): void {
    if (this.state === 'running') throw new Error('stop the engine before resetting history')
    const now = Date.now()
    fullReset(now)
    this.rewardTotal = 0
    this.rewardLastRate = 0
    this.rewardLastUpdatedAt = now
  }

  /** Pull the current engine snapshot straight from SQLite — what the HTTP
   *  server hands to the frontend. Reads are fast thanks to WAL mode. */
  snapshot() {
    const s = readEngineState()
    const reward = readReward()
    return {
      state: s.state,
      startedAt: s.startedAt,
      brokerKind: this.broker.kind,
      config: s.configJson ? JSON.parse(s.configJson) : null,
      orders: readRecentOrders(500),
      fills: readRecentFills(200),
      reward,
      positions: readPositions(),
      lastAllocAt: s.lastAllocAt,
    }
  }

  /** Refresh the WS subscription to the current token set. Called from
   *  engineAlloc after each realloc cycle. */
  restartWs(): void {
    if (this.ws) { this.ws.stop(); this.ws = null }
    const tokenIds = [...this.positions.values()].map((p) => p.tokenId)
    if (tokenIds.length === 0) return
    this.ws = startMarketStream(tokenIds, {
      onBook: (tokenId, view) => evaluateBook(this, tokenId, view),
      onStatus: (state, info) => {
        if (state === 'open') console.log(`[engine] ws open — streaming ${info.streamed} tokens`)
      },
    })
  }

  /** InternalPosition → DB row. Used by every module that touches positions. */
  toRow(pos: InternalPosition, now: number): PositionRow {
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

  private scheduleRewardTick(): void {
    if (this.rewardTimer) clearInterval(this.rewardTimer)
    this.rewardTimer = setInterval(() => accrueRewards(this), REWARD_TICK_MS)
  }

  private scheduleRealloc(): void {
    if (this.reallocTimer) clearInterval(this.reallocTimer)
    this.reallocTimer = setInterval(() => { void reallocate(this) }, REALLOC_MS)
  }

  private scheduleHourlySnapshot(): void {
    if (this.hourlySnapshotTimer) clearInterval(this.hourlySnapshotTimer)
    // Fire once per hour, aligned to the top of the hour.
    const msUntilNextHour = 3_600_000 - (Date.now() % 3_600_000)
    setTimeout(() => {
      takeHourlySnapshot(this)
      this.hourlySnapshotTimer = setInterval(() => takeHourlySnapshot(this), 3_600_000)
    }, msUntilNextHour)
  }
}
