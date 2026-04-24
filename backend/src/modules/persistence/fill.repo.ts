import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export type FillSide = 'bid' | 'ask'
export type HedgeStatus = 'pending' | 'done' | 'failed'

export interface FillRow {
  id: string
  orderId: string
  conditionId: string
  question: string
  side: FillSide
  fillPrice: number
  size: number
  hedgePrice: number
  realisedPnlUsd: number
  makerFeeUsd: number
  takerFeeUsd: number
  filledAt: number
  hedgeOrderId: string | null
  hedgeStatus: HedgeStatus
}

@Injectable()
export class FillRepo {
  constructor(private readonly prisma: PrismaService) {}

  async insert(f: FillRow): Promise<void> {
    await this.prisma.fill.upsert({
      where: { id: f.id },
      create: {
        id: f.id,
        orderId: f.orderId,
        conditionId: f.conditionId,
        question: f.question,
        side: f.side,
        fillPrice: f.fillPrice,
        size: f.size,
        hedgePrice: f.hedgePrice,
        realisedPnlUsd: f.realisedPnlUsd,
        makerFeeUsd: f.makerFeeUsd,
        takerFeeUsd: f.takerFeeUsd,
        filledAt: new Date(f.filledAt),
        hedgeOrderId: f.hedgeOrderId,
        hedgeStatus: f.hedgeStatus,
      },
      update: {
        hedgeOrderId: f.hedgeOrderId,
        hedgeStatus: f.hedgeStatus,
      },
    })
  }

  async updateHedge(id: string, hedgeOrderId: string | null, hedgeStatus: HedgeStatus): Promise<void> {
    await this.prisma.fill.update({
      where: { id },
      data: { hedgeOrderId, hedgeStatus },
    })
  }

  async readRecent(limit = 200): Promise<FillRow[]> {
    const rows = await this.prisma.fill.findMany({
      orderBy: { filledAt: 'desc' },
      take: limit,
    })
    return rows.map(this.toRow)
  }

  async readAll(limit = 10_000): Promise<FillRow[]> {
    const rows = await this.prisma.fill.findMany({
      orderBy: { filledAt: 'asc' },
      take: limit,
    })
    return rows.map(this.toRow)
  }

  private toRow(r: {
    id: string
    orderId: string
    conditionId: string
    question: string
    side: string
    fillPrice: number
    size: number
    hedgePrice: number
    realisedPnlUsd: number
    makerFeeUsd: number
    takerFeeUsd: number
    filledAt: Date
    hedgeOrderId: string | null
    hedgeStatus: string
  }): FillRow {
    return {
      id: r.id,
      orderId: r.orderId,
      conditionId: r.conditionId,
      question: r.question,
      side: r.side as FillSide,
      fillPrice: r.fillPrice,
      size: r.size,
      hedgePrice: r.hedgePrice,
      realisedPnlUsd: r.realisedPnlUsd,
      makerFeeUsd: r.makerFeeUsd,
      takerFeeUsd: r.takerFeeUsd,
      filledAt: r.filledAt.getTime(),
      hedgeOrderId: r.hedgeOrderId,
      hedgeStatus: r.hedgeStatus as HedgeStatus,
    }
  }
}
