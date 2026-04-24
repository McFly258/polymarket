import { Body, Controller, Get, HttpCode, Post, Query, HttpException, HttpStatus } from '@nestjs/common'

import { DEFAULT_STRATEGY } from '../../domain/strategy'
import type { StrategyConfig } from '../../domain/strategy.types'
import { CapitalRepo } from '../persistence/capital.repo'
import { FillRepo } from '../persistence/fill.repo'
import { RewardRepo } from '../persistence/reward.repo'

import { EngineService } from './engine.service'

@Controller()
export class EngineController {
  constructor(
    private readonly engine: EngineService,
    private readonly capitalRepo: CapitalRepo,
    private readonly rewardRepo: RewardRepo,
    private readonly fillRepo: FillRepo,
  ) {}

  @Get('state')
  async state() {
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
  async fillsHistory(@Query('limit') limit?: string) {
    const n = Math.min(Number(limit ?? 10_000) || 10_000, 100_000)
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
