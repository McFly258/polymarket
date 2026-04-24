import { Injectable, OnModuleInit } from '@nestjs/common'

import type { StrategyConfig } from '../../domain/strategy.types'
import { PrismaService } from '../prisma/prisma.service'

export type PersistedEngineState = 'idle' | 'running' | 'stopping'

export interface EngineStateRow {
  state: PersistedEngineState
  startedAt: number | null
  config: StrategyConfig | null
  lastAllocAt: number | null
}

@Injectable()
export class EngineStateRepo implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.engineState.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, state: 'idle' },
    })
    await this.prisma.reward.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, totalEarnedUsd: 0, lastRatePerDay: 0, lastUpdatedAt: new Date() },
    })
  }

  async read(): Promise<EngineStateRow> {
    const row = await this.prisma.engineState.findUniqueOrThrow({ where: { id: 1 } })
    return {
      state: row.state as PersistedEngineState,
      startedAt: row.startedAt ? row.startedAt.getTime() : null,
      config: (row.configJson as unknown as StrategyConfig | null) ?? null,
      lastAllocAt: row.lastAllocAt ? row.lastAllocAt.getTime() : null,
    }
  }

  async write(s: EngineStateRow): Promise<void> {
    await this.prisma.engineState.update({
      where: { id: 1 },
      data: {
        state: s.state,
        startedAt: s.startedAt ? new Date(s.startedAt) : null,
        configJson: (s.config ?? null) as never,
        lastAllocAt: s.lastAllocAt ? new Date(s.lastAllocAt) : null,
      },
    })
  }
}
