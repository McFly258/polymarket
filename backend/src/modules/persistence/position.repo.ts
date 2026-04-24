import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export interface PositionRow {
  conditionId: string
  question: string
  tokenId: string
  outcome: string
  bidOrderId: string | null
  askOrderId: string | null
  bidPrice: number
  askPrice: number
  bidSize: number
  askSize: number
  maxSpreadDollars: number
  dailyPool: number
  midPrice: number | null
  bestBid: number | null
  bestAsk: number | null
  rewardSharePct: number
  expectedRatePerDay: number
  capitalUsd: number
  updatedAt: number
}

@Injectable()
export class PositionRepo {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(p: PositionRow): Promise<void> {
    await this.prisma.position.upsert({
      where: { conditionId: p.conditionId },
      create: {
        conditionId: p.conditionId,
        question: p.question,
        tokenId: p.tokenId,
        outcome: p.outcome,
        bidOrderId: p.bidOrderId,
        askOrderId: p.askOrderId,
        bidPrice: p.bidPrice,
        askPrice: p.askPrice,
        bidSize: p.bidSize,
        askSize: p.askSize,
        maxSpreadDollars: p.maxSpreadDollars,
        dailyPool: p.dailyPool,
        midPrice: p.midPrice,
        bestBid: p.bestBid,
        bestAsk: p.bestAsk,
        rewardSharePct: p.rewardSharePct,
        expectedRatePerDay: p.expectedRatePerDay,
        capitalUsd: p.capitalUsd,
        updatedAt: new Date(p.updatedAt),
      },
      update: {
        question: p.question,
        tokenId: p.tokenId,
        outcome: p.outcome,
        bidOrderId: p.bidOrderId,
        askOrderId: p.askOrderId,
        bidPrice: p.bidPrice,
        askPrice: p.askPrice,
        bidSize: p.bidSize,
        askSize: p.askSize,
        maxSpreadDollars: p.maxSpreadDollars,
        dailyPool: p.dailyPool,
        midPrice: p.midPrice,
        bestBid: p.bestBid,
        bestAsk: p.bestAsk,
        rewardSharePct: p.rewardSharePct,
        expectedRatePerDay: p.expectedRatePerDay,
        capitalUsd: p.capitalUsd,
        updatedAt: new Date(p.updatedAt),
      },
    })
  }

  async readAll(): Promise<PositionRow[]> {
    const rows = await this.prisma.position.findMany()
    return rows.map((r) => ({
      conditionId: r.conditionId,
      question: r.question,
      tokenId: r.tokenId,
      outcome: r.outcome,
      bidOrderId: r.bidOrderId,
      askOrderId: r.askOrderId,
      bidPrice: r.bidPrice,
      askPrice: r.askPrice,
      bidSize: r.bidSize,
      askSize: r.askSize,
      maxSpreadDollars: r.maxSpreadDollars,
      dailyPool: r.dailyPool,
      midPrice: r.midPrice,
      bestBid: r.bestBid,
      bestAsk: r.bestAsk,
      rewardSharePct: r.rewardSharePct,
      expectedRatePerDay: r.expectedRatePerDay,
      capitalUsd: r.capitalUsd,
      updatedAt: r.updatedAt.getTime(),
    }))
  }

  async delete(conditionId: string): Promise<void> {
    await this.prisma.position.deleteMany({ where: { conditionId } })
  }

  async clearAll(): Promise<void> {
    await this.prisma.position.deleteMany({})
  }
}
