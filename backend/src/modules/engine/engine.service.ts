import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit, forwardRef } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { BROKER_TOKEN, type Broker } from '../../domain/broker.types'
import { CAPITAL_SAMPLE_MS, REALLOC_MS, REWARD_TICK_MS } from '../../domain/constants'
import { ENGINE_EVENT, type OrderCancelledEvent } from '../../domain/events'
import type { StrategyConfig } from '../../domain/strategy.types'
import { MarketWsService } from '../polymarket/market-ws.service'
import { EngineStateRepo } from '../persistence/engine-state.repo'
import { FillRepo } from '../persistence/fill.repo'
import { OrderRepo } from '../persistence/order.repo'
import { PositionRepo } from '../persistence/position.repo'
import { RewardRepo } from '../persistence/reward.repo'
import { CapitalRepo } from '../persistence/capital.repo'

import { EngineAllocService } from './engine-alloc.service'
import { EngineFillService } from './engine-fill.service'
import { EngineRewardsService } from './engine-rewards.service'
import { createEngineRuntimeState, type EngineRuntimeState } from './engine-state'

export interface EngineBroadcaster {
  onStateChange?: () => void
}

@Injectable()
export class EngineService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EngineService.name)
  readonly state: EngineRuntimeState = createEngineRuntimeState()

  private rewardTimer: NodeJS.Timeout | null = null
  private reallocTimer: NodeJS.Timeout | null = null
  private hourlyTimer: NodeJS.Timeout | null = null
  private hourlyBootstrap: NodeJS.Timeout | null = null
  private capitalTimer: NodeJS.Timeout | null = null
  private capitalBootstrap: NodeJS.Timeout | null = null

  private broadcaster: EngineBroadcaster | null = null

  constructor(
    @Inject(BROKER_TOKEN) readonly broker: Broker,
    private readonly ws: MarketWsService,
    private readonly stateRepo: EngineStateRepo,
    private readonly rewardRepo: RewardRepo,
    private readonly orderRepo: OrderRepo,
    private readonly fillRepo: FillRepo,
    private readonly positionRepo: PositionRepo,
    private readonly capitalRepo: CapitalRepo,
    private readonly events: EventEmitter2,
    @Inject(forwardRef(() => EngineAllocService)) private readonly alloc: EngineAllocService,
    @Inject(forwardRef(() => EngineFillService)) private readonly fill: EngineFillService,
    private readonly rewards: EngineRewardsService,
  ) {}

  registerBroadcaster(b: EngineBroadcaster): void {
    this.broadcaster = b
  }

  async onModuleInit(): Promise<void> {
    const reward = await this.rewardRepo.read()
    this.state.rewardTotal = reward.totalEarnedUsd
    this.state.rewardLastRate = reward.lastRatePerDay
    this.state.rewardLastUpdatedAt = reward.lastUpdatedAt
    await this.resumeIfNeeded()
  }

  async onApplicationShutdown(): Promise<void> {
    // Leave engine persisted as-is so restart can resume.
    this.clearTimers()
    if (this.state.ws) {
      this.state.ws.stop()
      this.state.ws = null
    }
  }

  private async resumeIfNeeded(): Promise<void> {
    const row = await this.stateRepo.read()
    if (row.state !== 'running' || !row.config) return
    this.logger.log('resuming previous run from Postgres…')
    const now = Date.now()
    const resting = (await this.orderRepo.readRecent(2000)).filter((o) => o.status === 'resting')
    await this.orderRepo.cancelAllResting(now)
    for (const o of resting) {
      this.events.emit(ENGINE_EVENT.ORDER_CANCELLED, {
        decisionId: o.decisionId,
        paperOrderId: o.id,
        at: now,
      } satisfies OrderCancelledEvent)
    }
    await this.positionRepo.clearAll()
    await this.start(row.config, { resumed: true, prevStartedAt: row.startedAt })
  }

  async start(
    config: StrategyConfig,
    opts: { resumed?: boolean; prevStartedAt?: number | null } = {},
  ): Promise<void> {
    if (this.state.state === 'running') return
    this.state.state = 'running'
    this.state.startedAt = opts.resumed && opts.prevStartedAt ? opts.prevStartedAt : Date.now()
    this.state.config = config
    this.state.marketPnlHistory.clear()
    this.state.portfolioPnlHistory = []
    this.state.globalPauseUntil = 0

    await this.stateRepo.write({
      state: 'running',
      startedAt: this.state.startedAt,
      config,
      lastAllocAt: Date.now(),
    })

    await this.alloc.reallocate(this.state)
    this.scheduleRewardTick()
    this.scheduleRealloc()
    this.scheduleHourlySnapshot()
    this.scheduleCapitalSample()
    this.logger.log(`started — ${this.state.positions.size} positions`)
    this.broadcaster?.onStateChange?.()
  }

  async stop(): Promise<void> {
    if (this.state.state !== 'running') return
    this.state.state = 'stopping'
    this.clearTimers()
    if (this.state.ws) {
      this.state.ws.stop()
      this.state.ws = null
    }

    const now = Date.now()
    const orders = await this.orderRepo.readRecent(2000)
    const resting = orders.filter((o) => o.status === 'resting')
    await Promise.all(resting.map((o) => this.broker.cancelOrder(o.id)))
    await this.orderRepo.cancelAllResting(now)
    for (const o of resting) {
      this.events.emit(ENGINE_EVENT.ORDER_CANCELLED, {
        decisionId: o.decisionId,
        paperOrderId: o.id,
        at: now,
      } satisfies OrderCancelledEvent)
    }
    await this.positionRepo.clearAll()
    this.state.positions.clear()

    this.state.state = 'idle'
    this.state.startedAt = null
    await this.stateRepo.write({ state: 'idle', startedAt: null, config: null, lastAllocAt: null })
    this.logger.log('stopped')
    this.broadcaster?.onStateChange?.()
  }

  async resetHistory(): Promise<void> {
    if (this.state.state === 'running') throw new Error('stop the engine before resetting history')
    const now = Date.now()
    await this.positionRepo.clearAll()
    await this.orderRepo.cancelAllResting(now)
    await this.rewardRepo.write({ totalEarnedUsd: 0, lastRatePerDay: 0, lastUpdatedAt: now })
    this.state.rewardTotal = 0
    this.state.rewardLastRate = 0
    this.state.rewardLastUpdatedAt = now
  }

  restartWs(): void {
    if (this.state.ws) {
      this.state.ws.stop()
      this.state.ws = null
    }
    const tokenIds = [...this.state.positions.values()].map((p) => p.tokenId)
    if (tokenIds.length === 0) return
    this.state.ws = this.ws.startStream(tokenIds, {
      onBook: (tokenId, view) => {
        this.fill.evaluateBook(this.state, tokenId, view)
        this.broadcaster?.onStateChange?.()
      },
      onStatus: (st, info) => {
        if (st === 'open') this.logger.log(`ws open — streaming ${info.streamed} tokens`)
      },
    })
  }

  async snapshot(): Promise<Record<string, unknown>> {
    const [s, reward, orders, fills, positions] = await Promise.all([
      this.stateRepo.read(),
      this.rewardRepo.read(),
      this.orderRepo.readRecent(500),
      this.fillRepo.readRecent(200),
      this.positionRepo.readAll(),
    ])
    return {
      state: s.state,
      startedAt: s.startedAt,
      brokerKind: this.broker.kind,
      config: s.config ?? null,
      orders,
      fills,
      reward,
      positions,
      lastAllocAt: s.lastAllocAt,
    }
  }

  private clearTimers(): void {
    if (this.rewardTimer) { clearInterval(this.rewardTimer); this.rewardTimer = null }
    if (this.reallocTimer) { clearInterval(this.reallocTimer); this.reallocTimer = null }
    if (this.hourlyTimer) { clearInterval(this.hourlyTimer); this.hourlyTimer = null }
    if (this.hourlyBootstrap) { clearTimeout(this.hourlyBootstrap); this.hourlyBootstrap = null }
    if (this.capitalTimer) { clearInterval(this.capitalTimer); this.capitalTimer = null }
    if (this.capitalBootstrap) { clearTimeout(this.capitalBootstrap); this.capitalBootstrap = null }
  }

  private scheduleRewardTick(): void {
    if (this.rewardTimer) clearInterval(this.rewardTimer)
    this.rewardTimer = setInterval(() => void this.rewards.accrue(this.state), REWARD_TICK_MS)
  }

  private scheduleRealloc(): void {
    if (this.reallocTimer) clearInterval(this.reallocTimer)
    this.reallocTimer = setInterval(() => void this.alloc.reallocate(this.state), REALLOC_MS)
  }

  private scheduleHourlySnapshot(): void {
    if (this.hourlyTimer) clearInterval(this.hourlyTimer)
    if (this.hourlyBootstrap) clearTimeout(this.hourlyBootstrap)
    const msUntilNextHour = 3_600_000 - (Date.now() % 3_600_000)
    this.hourlyBootstrap = setTimeout(() => {
      void this.rewards.takeHourlySnapshot(this.state)
      this.hourlyTimer = setInterval(() => void this.rewards.takeHourlySnapshot(this.state), 3_600_000)
    }, msUntilNextHour)
  }

  private scheduleCapitalSample(): void {
    if (this.capitalTimer) clearInterval(this.capitalTimer)
    if (this.capitalBootstrap) clearTimeout(this.capitalBootstrap)
    void this.rewards.takeCapitalSample(this.state)
    const msUntilNextBucket = CAPITAL_SAMPLE_MS - (Date.now() % CAPITAL_SAMPLE_MS)
    this.capitalBootstrap = setTimeout(() => {
      void this.rewards.takeCapitalSample(this.state)
      this.capitalTimer = setInterval(() => void this.rewards.takeCapitalSample(this.state), CAPITAL_SAMPLE_MS)
    }, msUntilNextBucket)
  }
}
