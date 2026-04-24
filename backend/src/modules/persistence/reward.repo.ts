import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export interface RewardRow {
  totalEarnedUsd: number
  lastRatePerDay: number
  lastUpdatedAt: number
}

export interface RewardHourlyRow {
  hourEpoch: number
  snapshotAt: number
  totalEarnedUsd: number
  ratePerDay: number
  totalCapitalUsd: number
}

export interface PositionRewardHourlyRow {
  hourEpoch: number
  snapshotAt: number
  conditionId: string
  question: string
  rewardSharePct: number
  expectedRatePerDay: number
  earnedThisHourUsd: number
}

@Injectable()
export class RewardRepo {
  constructor(private readonly prisma: PrismaService) {}

  async read(): Promise<RewardRow> {
    const r = await this.prisma.reward.findUniqueOrThrow({ where: { id: 1 } })
    return {
      totalEarnedUsd: r.totalEarnedUsd,
      lastRatePerDay: r.lastRatePerDay,
      lastUpdatedAt: r.lastUpdatedAt.getTime(),
    }
  }

  async write(r: RewardRow): Promise<void> {
    await this.prisma.reward.update({
      where: { id: 1 },
      data: {
        totalEarnedUsd: r.totalEarnedUsd,
        lastRatePerDay: r.lastRatePerDay,
        lastUpdatedAt: new Date(r.lastUpdatedAt),
      },
    })
  }

  async upsertHourly(row: RewardHourlyRow): Promise<void> {
    await this.prisma.rewardHourly.upsert({
      where: { hourEpoch: BigInt(row.hourEpoch) },
      create: {
        hourEpoch: BigInt(row.hourEpoch),
        snapshotAt: new Date(row.snapshotAt),
        totalEarnedUsd: row.totalEarnedUsd,
        ratePerDay: row.ratePerDay,
        totalCapitalUsd: row.totalCapitalUsd,
      },
      update: {
        snapshotAt: new Date(row.snapshotAt),
        totalEarnedUsd: row.totalEarnedUsd,
        ratePerDay: row.ratePerDay,
        totalCapitalUsd: row.totalCapitalUsd,
      },
    })
  }

  async insertPositionHourly(rows: PositionRewardHourlyRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.prisma.positionRewardHourly.createMany({
      data: rows.map((r) => ({
        hourEpoch: BigInt(r.hourEpoch),
        snapshotAt: new Date(r.snapshotAt),
        conditionId: r.conditionId,
        question: r.question,
        rewardSharePct: r.rewardSharePct,
        expectedRatePerDay: r.expectedRatePerDay,
        earnedThisHourUsd: r.earnedThisHourUsd,
      })),
    })
  }

  async readHourly(limit = 168): Promise<RewardHourlyRow[]> {
    const rows = await this.prisma.rewardHourly.findMany({
      orderBy: { hourEpoch: 'desc' },
      take: limit,
    })
    return rows.map((r) => ({
      hourEpoch: Number(r.hourEpoch),
      snapshotAt: r.snapshotAt.getTime(),
      totalEarnedUsd: r.totalEarnedUsd,
      ratePerDay: r.ratePerDay,
      totalCapitalUsd: r.totalCapitalUsd,
    }))
  }

  async readPositionHourly(conditionId: string | undefined, limit = 168): Promise<PositionRewardHourlyRow[]> {
    const rows = await this.prisma.positionRewardHourly.findMany({
      where: conditionId ? { conditionId } : undefined,
      orderBy: { hourEpoch: 'desc' },
      take: limit,
    })
    return rows.map((r) => ({
      hourEpoch: Number(r.hourEpoch),
      snapshotAt: r.snapshotAt.getTime(),
      conditionId: r.conditionId,
      question: r.question,
      rewardSharePct: r.rewardSharePct,
      expectedRatePerDay: r.expectedRatePerDay,
      earnedThisHourUsd: r.earnedThisHourUsd,
    }))
  }
}
