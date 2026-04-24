import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export interface Capital5MinRow {
  bucketEpoch: number
  sampledAt: number
  totalCapitalUsd: number
}

@Injectable()
export class CapitalRepo {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(r: Capital5MinRow): Promise<void> {
    await this.prisma.capitalSample.upsert({
      where: { bucketEpoch: BigInt(r.bucketEpoch) },
      create: {
        bucketEpoch: BigInt(r.bucketEpoch),
        sampledAt: new Date(r.sampledAt),
        totalCapitalUsd: r.totalCapitalUsd,
      },
      update: {
        sampledAt: new Date(r.sampledAt),
        totalCapitalUsd: r.totalCapitalUsd,
      },
    })
  }

  async read(limit = 288): Promise<Capital5MinRow[]> {
    const rows = await this.prisma.capitalSample.findMany({
      orderBy: { bucketEpoch: 'desc' },
      take: limit,
    })
    return rows.map((r) => ({
      bucketEpoch: Number(r.bucketEpoch),
      sampledAt: r.sampledAt.getTime(),
      totalCapitalUsd: r.totalCapitalUsd,
    }))
  }
}
