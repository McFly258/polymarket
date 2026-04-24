import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export type OrderSide = 'bid' | 'ask'
export type OrderStatus = 'resting' | 'filled' | 'cancelled'

export interface OrderRow {
  id: string
  decisionId: string | null
  conditionId: string
  tokenId: string
  outcome: string
  side: OrderSide
  price: number
  size: number
  status: OrderStatus
  postedAt: number
  postedBestBid: number | null
  postedBestAsk: number | null
  closedAt: number | null
}

@Injectable()
export class OrderRepo {
  constructor(private readonly prisma: PrismaService) {}

  async insert(o: OrderRow): Promise<void> {
    await this.prisma.order.upsert({
      where: { id: o.id },
      create: {
        id: o.id,
        decisionId: o.decisionId,
        conditionId: o.conditionId,
        tokenId: o.tokenId,
        outcome: o.outcome,
        side: o.side,
        price: o.price,
        size: o.size,
        status: o.status,
        postedAt: new Date(o.postedAt),
        postedBestBid: o.postedBestBid,
        postedBestAsk: o.postedBestAsk,
        closedAt: o.closedAt ? new Date(o.closedAt) : null,
      },
      update: {
        status: o.status,
        closedAt: o.closedAt ? new Date(o.closedAt) : null,
      },
    })
  }

  async updateStatus(id: string, status: OrderStatus, closedAt: number): Promise<void> {
    await this.prisma.order.update({
      where: { id },
      data: { status, closedAt: new Date(closedAt) },
    })
  }

  async readRecent(limit = 500): Promise<OrderRow[]> {
    const rows = await this.prisma.order.findMany({
      orderBy: { postedAt: 'desc' },
      take: limit,
    })
    return rows.map((r) => ({
      id: r.id,
      decisionId: r.decisionId,
      conditionId: r.conditionId,
      tokenId: r.tokenId,
      outcome: r.outcome,
      side: r.side as OrderSide,
      price: r.price,
      size: r.size,
      status: r.status as OrderStatus,
      postedAt: r.postedAt.getTime(),
      postedBestBid: r.postedBestBid,
      postedBestAsk: r.postedBestAsk,
      closedAt: r.closedAt ? r.closedAt.getTime() : null,
    }))
  }

  async cancelAllResting(now: number): Promise<void> {
    await this.prisma.order.updateMany({
      where: { status: 'resting' },
      data: { status: 'cancelled', closedAt: new Date(now) },
    })
  }
}
