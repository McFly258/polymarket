import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export interface RealPositionRow {
  conditionId: string
  decisionId: string | null
  question: string
  tokenId: string
  outcome: string
  bidOrderId: string | null
  askOrderId: string | null
  bidPrice: number
  askPrice: number
  bidSize: number
  askSize: number
  capitalUsd: number
  updatedAt: number
}

@Injectable()
export class RealPositionRepo {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(p: RealPositionRow): Promise<void> {
    await this.prisma.realPosition.upsert({
      where: { conditionId: p.conditionId },
      create: {
        conditionId: p.conditionId,
        decisionId: p.decisionId,
        question: p.question,
        tokenId: p.tokenId,
        outcome: p.outcome,
        bidOrderId: p.bidOrderId,
        askOrderId: p.askOrderId,
        bidPrice: p.bidPrice,
        askPrice: p.askPrice,
        bidSize: p.bidSize,
        askSize: p.askSize,
        capitalUsd: p.capitalUsd,
        updatedAt: new Date(p.updatedAt),
      },
      update: {
        decisionId: p.decisionId,
        question: p.question,
        tokenId: p.tokenId,
        outcome: p.outcome,
        bidOrderId: p.bidOrderId,
        askOrderId: p.askOrderId,
        bidPrice: p.bidPrice,
        askPrice: p.askPrice,
        bidSize: p.bidSize,
        askSize: p.askSize,
        capitalUsd: p.capitalUsd,
        updatedAt: new Date(p.updatedAt),
      },
    })
  }

  async readAll(): Promise<RealPositionRow[]> {
    const rows = await this.prisma.realPosition.findMany()
    return rows.map((r) => ({
      conditionId: r.conditionId,
      decisionId: r.decisionId,
      question: r.question,
      tokenId: r.tokenId,
      outcome: r.outcome,
      bidOrderId: r.bidOrderId,
      askOrderId: r.askOrderId,
      bidPrice: r.bidPrice,
      askPrice: r.askPrice,
      bidSize: r.bidSize,
      askSize: r.askSize,
      capitalUsd: r.capitalUsd,
      updatedAt: r.updatedAt.getTime(),
    }))
  }

  async delete(conditionId: string): Promise<void> {
    await this.prisma.realPosition.deleteMany({ where: { conditionId } })
  }
}
