import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export interface RealExecutionStateRow {
  enabled: boolean
  paused: boolean
  pauseReason: string | null
  dailyLossUsd: number
  dailyLossDayUtc: string | null
  walletSyncCursorAt: number | null
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
    return this.toRow(r)
  }

  async write(patch: Partial<Omit<RealExecutionStateRow, 'updatedAt'>>): Promise<RealExecutionStateRow> {
    const dbPatch = {
      ...patch,
      walletSyncCursorAt:
        patch.walletSyncCursorAt !== undefined
          ? patch.walletSyncCursorAt === null
            ? null
            : new Date(patch.walletSyncCursorAt)
          : undefined,
    }
    const r = await this.prisma.realExecutionState.upsert({
      where: { id: 1 },
      create: { id: 1, ...dbPatch },
      update: dbPatch,
    })
    return this.toRow(r)
  }

  private toRow(r: {
    enabled: boolean
    paused: boolean
    pauseReason: string | null
    dailyLossUsd: number
    dailyLossDayUtc: string | null
    walletSyncCursorAt: Date | null
    updatedAt: Date
  }): RealExecutionStateRow {
    return {
      enabled: r.enabled,
      paused: r.paused,
      pauseReason: r.pauseReason,
      dailyLossUsd: r.dailyLossUsd,
      dailyLossDayUtc: r.dailyLossDayUtc,
      walletSyncCursorAt: r.walletSyncCursorAt ? r.walletSyncCursorAt.getTime() : null,
      updatedAt: r.updatedAt.getTime(),
    }
  }
}
