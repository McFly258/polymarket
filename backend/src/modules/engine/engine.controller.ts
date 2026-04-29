import { Body, Controller, Get, HttpCode, Post, Query, HttpException, HttpStatus } from '@nestjs/common'

import { DEFAULT_STRATEGY } from '../../domain/strategy'
import type { StrategyConfig } from '../../domain/strategy.types'
import { CapitalRepo } from '../persistence/capital.repo'
import { FillRepo } from '../persistence/fill.repo'
import { RewardRepo } from '../persistence/reward.repo'
import { RealFillRepo } from '../real-execution/real-fill.repo'
import { RealOrderRepo } from '../real-execution/real-order.repo'
import { RealPositionRepo } from '../real-execution/real-position.repo'

import { EngineService } from './engine.service'

function mapRealOrderStatus(
  status: string,
): 'resting' | 'filled' | 'cancelled' {
  if (status === 'filled') return 'filled'
  if (status === 'cancelled' || status === 'rejected' || status === 'skipped') return 'cancelled'
  // pending | accepted | resting | partial => resting
  return 'resting'
}

@Controller()
export class EngineController {
  constructor(
    private readonly engine: EngineService,
    private readonly capitalRepo: CapitalRepo,
    private readonly rewardRepo: RewardRepo,
    private readonly fillRepo: FillRepo,
    private readonly realFillRepo: RealFillRepo,
    private readonly realPositionRepo: RealPositionRepo,
    private readonly realOrderRepo: RealOrderRepo,
  ) {}

  @Get('state')
  async state(@Query('mode') mode?: string) {
    if (mode === 'real') {
      const [orders, fills, positions] = await Promise.all([
        this.realOrderRepo.readRecent(500),
        this.realFillRepo.readRecent(200),
        this.realPositionRepo.readAll(),
      ])
      return {
        state: this.engine.state.state,
        startedAt: this.engine.state.startedAt,
        brokerKind: 'live',
        config: this.engine.state.config ?? null,
        orders: orders.map((o) => ({
          id: o.id,
          conditionId: o.conditionId,
          tokenId: o.tokenId,
          outcome: o.outcome,
          side: o.side,
          price: o.price,
          size: o.size,
          status: mapRealOrderStatus(o.status),
          postedAt: o.postedAt,
          closedAt: o.closedAt,
          postedBestBid: null,
          postedBestAsk: null,
        })),
        fills: fills.map((f) => ({
          id: f.id,
          orderId: f.realOrderId,
          conditionId: f.conditionId,
          question: f.question,
          side: f.side,
          fillPrice: f.fillPrice,
          size: f.size,
          hedgePrice: f.hedgePrice,
          realisedPnlUsd: f.realisedPnlUsd,
          makerFeeUsd: f.makerFeeUsd,
          takerFeeUsd: f.takerFeeUsd,
          filledAt: f.filledAt,
          hedgeOrderId: f.hedgeOrderId,
          hedgeStatus: f.hedgeStatus,
        })),
        reward: { totalEarnedUsd: 0, lastRatePerDay: 0, lastUpdatedAt: Date.now() },
        positions: positions.map((p) => ({
          conditionId: p.conditionId,
          question: p.question,
          tokenId: p.tokenId,
          outcome: p.outcome,
          bidOrderId: p.bidOrderId,
          askOrderId: p.askOrderId,
          bidPrice: p.bidPrice,
          askPrice: p.askPrice,
          bidSize: p.bidSize,
          askSize: p.askSize,
          maxSpreadDollars: 0,
          dailyPool: 0,
          midPrice: null,
          bestBid: null,
          bestAsk: null,
          rewardSharePct: 0,
          expectedRatePerDay: 0,
          capitalUsd: p.capitalUsd,
          updatedAt: p.updatedAt,
        })),
        lastAllocAt: null,
      }
    }
    return this.engine.snapshot()
  }

  @Get('reward-history')
  async rewardHistory(@Query('limit') limit?: string) {
    const n = Math.min(Number(limit ?? 168) || 168, 8760)
    return this.rewardRepo.readHourly(n)
  }

  @Get('capital-history')
  async capitalHistory(@Query('limit') limit?: string) {
    const n = Math.min(Number(limit ?? 288) || 288, 105_120)
    return this.capitalRepo.read(n)
  }

  @Get('position-reward-history')
  async positionRewardHistory(
    @Query('conditionId') conditionId?: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(Number(limit ?? 168) || 168, 8760)
    return this.rewardRepo.readPositionHourly(conditionId, n)
  }

  @Get('fills-history')
  async fillsHistory(@Query('limit') limit?: string, @Query('mode') mode?: string) {
    const n = Math.min(Number(limit ?? 10_000) || 10_000, 100_000)
    if (mode === 'real') {
      const rows = await this.realFillRepo.readAll(n)
      return rows.map((f) => ({
        id: f.id,
        orderId: f.realOrderId,
        conditionId: f.conditionId,
        question: f.question,
        side: f.side,
        fillPrice: f.fillPrice,
        size: f.size,
        hedgePrice: f.hedgePrice,
        realisedPnlUsd: f.realisedPnlUsd,
        makerFeeUsd: f.makerFeeUsd,
        takerFeeUsd: f.takerFeeUsd,
        filledAt: f.filledAt,
        hedgeOrderId: f.hedgeOrderId,
        hedgeStatus: f.hedgeStatus,
      }))
    }
    return this.fillRepo.readAll(n)
  }

  @Post('start')
  @HttpCode(200)
  async start(@Body() body: Partial<StrategyConfig> | undefined) {
    const config: StrategyConfig = { ...DEFAULT_STRATEGY, ...(body ?? {}) }
    await this.engine.start(config)
    return { ok: true, snapshot: await this.engine.snapshot() }
  }

  @Post('stop')
  @HttpCode(200)
  async stop() {
    await this.engine.stop()
    return { ok: true, snapshot: await this.engine.snapshot() }
  }

  @Post('reset')
  @HttpCode(200)
  async reset() {
    try {
      await this.engine.resetHistory()
    } catch (err) {
      throw new HttpException((err as Error).message, HttpStatus.CONFLICT)
    }
    return { ok: true }
  }
}
