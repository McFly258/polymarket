import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export interface RealExecutionStateRow {
  enabled: boolean
  paused: boolean
  pauseReason: string | null
  dailyLossUsd: number
  dailyLossDayUtc: string | null
  updatedAt: number
}

@Injectable()
export class RealStateRepo {
  constructor(private readonly prisma: PrismaService) {}

  async read(): Promise<RealExecutionStateRow> {
    const r = await this.prisma.realExecutionState.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    })
    return {
      enabled: r.enabled,
      paused: r.paused,
      pauseReason: r.pauseReason,
      dailyLossUsd: r.dailyLossUsd,
      dailyLossDayUtc: r.dailyLossDayUtc,
      updatedAt: r.updatedAt.getTime(),
    }
  }

  async write(patch: Partial<Omit<RealExecutionStateRow, 'updatedAt'>>): Promise<RealExecutionStateRow> {
    const r = await this.prisma.realExecutionState.upsert({
      where: { id: 1 },
      create: { id: 1, ...patch },
      update: patch,
    })
    return {
      enabled: r.enabled,
      paused: r.paused,
      pauseReason: r.pauseReason,
      dailyLossUsd: r.dailyLossUsd,
      dailyLossDayUtc: r.dailyLossDayUtc,
      updatedAt: r.updatedAt.getTime(),
    }
  }
}
