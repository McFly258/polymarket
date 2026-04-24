import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

export type RealOrderStatus =
  | 'pending'
  | 'accepted'
  | 'resting'
  | 'partial'
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
  filledSize: number
  status: RealOrderStatus
  rejectReason: string | null
  postedAt: number
  closedAt: number | null
  txHash: string | null
  lastReconciledAt: number | null
  discrepancy: string | null
}

export type RealOrderReconcilePatch = {
  filledSize?: number
  status?: RealOrderStatus
  closedAt?: number | null
  discrepancy?: string | null
  lastReconciledAt: number
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
        filledSize: o.filledSize,
        status: o.status,
        rejectReason: o.rejectReason,
        postedAt: new Date(o.postedAt),
        closedAt: o.closedAt ? new Date(o.closedAt) : null,
        txHash: o.txHash,
        lastReconciledAt: o.lastReconciledAt ? new Date(o.lastReconciledAt) : null,
        discrepancy: o.discrepancy,
      },
      update: {
        status: o.status,
        filledSize: o.filledSize,
        rejectReason: o.rejectReason,
        closedAt: o.closedAt ? new Date(o.closedAt) : null,
        txHash: o.txHash,
        lastReconciledAt: o.lastReconciledAt ? new Date(o.lastReconciledAt) : null,
        discrepancy: o.discrepancy,
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

  async patchReconcile(id: string, patch: RealOrderReconcilePatch): Promise<void> {
    const data: Record<string, unknown> = {
      lastReconciledAt: new Date(patch.lastReconciledAt),
    }
    if (patch.status !== undefined) data['status'] = patch.status
    if (patch.filledSize !== undefined) data['filledSize'] = patch.filledSize
    if (patch.closedAt !== undefined)
      data['closedAt'] = patch.closedAt ? new Date(patch.closedAt) : null
    if (patch.discrepancy !== undefined) data['discrepancy'] = patch.discrepancy
    await this.prisma.realOrder.update({ where: { id }, data })
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

  // Orders the reconciler needs to poll: anything that might still be live on
  // the CLOB, plus anything we cancelled where a late fill could still land.
  async readOpen(): Promise<RealOrderRow[]> {
    const rows = await this.prisma.realOrder.findMany({
      where: { status: { in: ['accepted', 'resting', 'partial', 'pending'] } },
      orderBy: { postedAt: 'asc' },
    })
    return rows.map((r) => this.toRow(r))
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.prisma.realOrder.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
    const out: Record<string, number> = {}
    for (const r of rows) out[r.status] = r._count._all
    return out
  }

  async countDiscrepancies(): Promise<number> {
    return this.prisma.realOrder.count({ where: { NOT: { discrepancy: null } } })
  }

  async lastReconciledAt(): Promise<number | null> {
    const r = await this.prisma.realOrder.findFirst({
      where: { NOT: { lastReconciledAt: null } },
      orderBy: { lastReconciledAt: 'desc' },
      select: { lastReconciledAt: true },
    })
    return r?.lastReconciledAt ? r.lastReconciledAt.getTime() : null
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
    filledSize: number
    status: string
    rejectReason: string | null
    postedAt: Date
    closedAt: Date | null
    txHash: string | null
    lastReconciledAt: Date | null
    discrepancy: string | null
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
      filledSize: r.filledSize,
      status: r.status as RealOrderStatus,
      rejectReason: r.rejectReason,
      postedAt: r.postedAt.getTime(),
      closedAt: r.closedAt ? r.closedAt.getTime() : null,
      txHash: r.txHash,
      lastReconciledAt: r.lastReconciledAt ? r.lastReconciledAt.getTime() : null,
      discrepancy: r.discrepancy,
    }
  }
}
