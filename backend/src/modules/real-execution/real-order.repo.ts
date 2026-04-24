import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export type RealOrderStatus =
  | 'pending'
  | 'accepted'
  | 'resting'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'skipped'

export interface RealOrderRow {
  id: string
  decisionId: string
  paperOrderId: string
  conditionId: string
  tokenId: string
  outcome: string
  side: 'bid' | 'ask'
  price: number
  size: number
  status: RealOrderStatus
  rejectReason: string | null
  postedAt: number
  closedAt: number | null
  txHash: string | null
}

@Injectable()
export class RealOrderRepo {
  constructor(private readonly prisma: PrismaService) {}

  async insert(o: RealOrderRow): Promise<void> {
    await this.prisma.realOrder.upsert({
      where: { id: o.id },
      create: {
        id: o.id,
        decisionId: o.decisionId,
        paperOrderId: o.paperOrderId,
        conditionId: o.conditionId,
        tokenId: o.tokenId,
        outcome: o.outcome,
        side: o.side,
        price: o.price,
        size: o.size,
        status: o.status,
        rejectReason: o.rejectReason,
        postedAt: new Date(o.postedAt),
        closedAt: o.closedAt ? new Date(o.closedAt) : null,
        txHash: o.txHash,
      },
      update: {
        status: o.status,
        rejectReason: o.rejectReason,
        closedAt: o.closedAt ? new Date(o.closedAt) : null,
        txHash: o.txHash,
      },
    })
  }

  async updateStatusByPaperId(
    paperOrderId: string,
    status: RealOrderStatus,
    closedAt: number,
  ): Promise<void> {
    await this.prisma.realOrder.updateMany({
      where: { paperOrderId },
      data: { status, closedAt: new Date(closedAt) },
    })
  }

  async findByPaperId(paperOrderId: string): Promise<RealOrderRow | null> {
    const r = await this.prisma.realOrder.findFirst({ where: { paperOrderId } })
    return r ? this.toRow(r) : null
  }

  async readRecent(limit = 500): Promise<RealOrderRow[]> {
    const rows = await this.prisma.realOrder.findMany({
      orderBy: { postedAt: 'desc' },
      take: limit,
    })
    return rows.map((r) => this.toRow(r))
  }

  private toRow(r: {
    id: string
    decisionId: string
    paperOrderId: string
    conditionId: string
    tokenId: string
    outcome: string
    side: string
    price: number
    size: number
    status: string
    rejectReason: string | null
    postedAt: Date
    closedAt: Date | null
    txHash: string | null
  }): RealOrderRow {
    return {
      id: r.id,
      decisionId: r.decisionId,
      paperOrderId: r.paperOrderId,
      conditionId: r.conditionId,
      tokenId: r.tokenId,
      outcome: r.outcome,
      side: r.side as 'bid' | 'ask',
      price: r.price,
      size: r.size,
      status: r.status as RealOrderStatus,
      rejectReason: r.rejectReason,
      postedAt: r.postedAt.getTime(),
      closedAt: r.closedAt ? r.closedAt.getTime() : null,
      txHash: r.txHash,
    }
  }
}
