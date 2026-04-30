import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export type HedgeStatus = 'pending' | 'done' | 'failed' | 'skipped' | 'not-applicable' | 'abandoned'

// 'paper'     — fill inserted synchronously from an ORDER_FILLED engine event.
// 'reconciler' — fill inserted by the reconciliation poller after seeing a CLOB
//                trade with no matching paper fill (late / divergent execution).
export type RealFillSource = 'paper' | 'reconciler'

export interface RealFillRow {
  id: string
  decisionId: string
  paperFillId: string | null
  realOrderId: string
  conditionId: string
  question: string
  side: 'bid' | 'ask'
  fillPrice: number
  size: number
  hedgePrice: number
  realisedPnlUsd: number
  makerFeeUsd: number
  takerFeeUsd: number
  filledAt: number
  hedgeOrderId: string | null
  hedgeStatus: HedgeStatus
  txHash: string | null
  clobTradeId: string | null
  tokenId: string | null
  source: RealFillSource
  hedgeRetryCount: number
}

@Injectable()
export class RealFillRepo {
  constructor(private readonly prisma: PrismaService) {}

  async insert(f: RealFillRow): Promise<void> {
    await this.prisma.realFill.upsert({
      where: { id: f.id },
      create: {
        id: f.id,
        decisionId: f.decisionId,
        paperFillId: f.paperFillId,
        realOrderId: f.realOrderId,
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
        txHash: f.txHash,
        clobTradeId: f.clobTradeId,
        tokenId: f.tokenId,
        source: f.source,
        hedgeRetryCount: f.hedgeRetryCount,
      },
      update: {
        hedgeOrderId: f.hedgeOrderId,
        hedgeStatus: f.hedgeStatus,
        txHash: f.txHash,
        clobTradeId: f.clobTradeId,
      },
    })
  }

  async findByClobTradeId(clobTradeId: string): Promise<RealFillRow | null> {
    const r = await this.prisma.realFill.findUnique({ where: { clobTradeId } })
    return r ? this.toRow(r) : null
  }

  async updateHedge(
    id: string,
    hedgeOrderId: string | null,
    hedgeStatus: HedgeStatus,
    txHash?: string | null,
  ): Promise<void> {
    await this.prisma.realFill.update({
      where: { id },
      data: { hedgeOrderId, hedgeStatus, ...(txHash !== undefined ? { txHash } : {}) },
    })
  }

  async incrementRetryCount(id: string): Promise<number> {
    const updated = await this.prisma.realFill.update({
      where: { id },
      data: { hedgeRetryCount: { increment: 1 } },
      select: { hedgeRetryCount: true },
    })
    return updated.hedgeRetryCount
  }

  async readUnhedged(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<RealFillRow[]> {
    const since = new Date(Date.now() - maxAgeMs)
    const rows = await this.prisma.realFill.findMany({
      where: {
        hedgeStatus: { in: ['skipped', 'failed'] as string[] },
        filledAt: { gte: since },
        // Only retry fills where we know the tokenId — without it we can't
        // place a hedge order on the CLOB. clobTradeId is not the right proxy
        // because paper-engine fills (source='paper') can still be real on-chain
        // positions; tokenId being set is the authoritative signal that hedging
        // is possible.
        tokenId: { not: null },
      },
      orderBy: { filledAt: 'asc' },
    })
    return rows.map((r) => this.toRow(r))
  }

  async readRecent(limit = 200): Promise<RealFillRow[]> {
    const rows = await this.prisma.realFill.findMany({
      orderBy: { filledAt: 'desc' },
      take: limit,
    })
    return rows.map((r) => this.toRow(r))
  }

  async readAll(limit = 10_000): Promise<RealFillRow[]> {
    const rows = await this.prisma.realFill.findMany({
      orderBy: { filledAt: 'asc' },
      take: limit,
    })
    return rows.map((r) => this.toRow(r))
  }

  private toRow(r: {
    id: string
    decisionId: string
    paperFillId: string | null
    realOrderId: string
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
    txHash: string | null
    clobTradeId: string | null
    tokenId: string | null
    source: string
    hedgeRetryCount: number
  }): RealFillRow {
    return {
      id: r.id,
      decisionId: r.decisionId,
      paperFillId: r.paperFillId,
      realOrderId: r.realOrderId,
      conditionId: r.conditionId,
      question: r.question,
      side: r.side as 'bid' | 'ask',
      fillPrice: r.fillPrice,
      size: r.size,
      hedgePrice: r.hedgePrice,
      realisedPnlUsd: r.realisedPnlUsd,
      makerFeeUsd: r.makerFeeUsd,
      takerFeeUsd: r.takerFeeUsd,
      filledAt: r.filledAt.getTime(),
      hedgeOrderId: r.hedgeOrderId,
      hedgeStatus: r.hedgeStatus as HedgeStatus,
      txHash: r.txHash,
      clobTradeId: r.clobTradeId,
      tokenId: r.tokenId,
      source: r.source as RealFillSource,
      hedgeRetryCount: r.hedgeRetryCount,
    }
  }
}
