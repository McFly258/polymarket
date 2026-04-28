import { Controller, Get, Post, Logger } from '@nestjs/common'

import { FillRepo } from '../persistence/fill.repo'

import { ClobBroker, type BalanceSnapshot } from './clob-broker'
import { RealFillRepo, type RealFillRow } from './real-fill.repo'
import { RealOrderRepo, type RealOrderRow } from './real-order.repo'
import { RealPositionRepo, type RealPositionRow } from './real-position.repo'
import { RealStateRepo } from './real-state.repo'
import {
  ReconciliationService,
  type ReconciliationStatus,
} from './reconciliation.service'

export interface BalanceDto extends BalanceSnapshot {
  minBalanceUsdc: number
  sufficient: boolean
  enabled: boolean
}

export interface RealStatusDto {
  enabled: boolean
  paused: boolean
  pauseReason: string | null
  dailyLossUsd: number
  maxDailyLossUsd: number
}

export interface CompareRow {
  decisionId: string
  paperFillPrice: number | null
  realFillPrice: number | null
  priceDelta: number | null
  paperPnlUsd: number | null
  realPnlUsd: number | null
  pnlDelta: number | null
  side: string | null
  conditionId: string | null
  filledAt: number | null
}

@Controller()
export class RealExecutionController {
  private readonly logger = new Logger(RealExecutionController.name)

  constructor(
    private readonly stateRepo: RealStateRepo,
    private readonly realFillRepo: RealFillRepo,
    private readonly realOrderRepo: RealOrderRepo,
    private readonly realPositionRepo: RealPositionRepo,
    private readonly reconciler: ReconciliationService,
    private readonly fillRepo: FillRepo,
    private readonly broker: ClobBroker,
  ) {}

  @Get('admin/real/status')
  async getStatus(): Promise<RealStatusDto> {
    const state = await this.stateRepo.read()
    const maxDailyLossUsd = Number(process.env['REAL_MAX_DAILY_LOSS_USD'] ?? 100)
    return {
      enabled: this.broker.isEnabled(),
      paused: state.paused,
      pauseReason: state.pauseReason,
      dailyLossUsd: state.dailyLossUsd,
      maxDailyLossUsd,
    }
  }

  @Get('admin/real/balance')
  async getBalance(): Promise<BalanceDto> {
    const minBalanceUsdc = Number(process.env['REAL_MIN_BALANCE_USD'] ?? 10)
    const snapshot = await this.broker.getBalance()
    return {
      ...snapshot,
      minBalanceUsdc,
      sufficient: snapshot.balanceUsdc >= minBalanceUsdc,
      enabled: this.broker.isEnabled(),
    }
  }

  @Post('admin/real/pause')
  async pause(): Promise<{ ok: boolean; message: string }> {
    await this.stateRepo.write({ paused: true, pauseReason: 'manually paused via API' })
    this.logger.log('Real execution paused via API')
    return { ok: true, message: 'Real execution paused' }
  }

  @Post('admin/real/resume')
  async resume(): Promise<{ ok: boolean; message: string }> {
    await this.stateRepo.write({ paused: false, pauseReason: null })
    this.logger.log('Real execution resumed via API')
    return { ok: true, message: 'Real execution resumed' }
  }

  @Get('admin/real/reconcile/status')
  async reconcileStatus(): Promise<ReconciliationStatus> {
    return this.reconciler.getStatus()
  }

  @Post('admin/real/reconcile/run')
  async reconcileRun(): Promise<ReconciliationStatus> {
    this.logger.log('Reconciler force-run requested via API')
    return this.reconciler.runOnce()
  }

  @Get('admin/real/orders')
  async recentOrders(): Promise<RealOrderRow[]> {
    return this.realOrderRepo.readRecent(100)
  }

  @Get('admin/real/fills')
  async recentFills(): Promise<RealFillRow[]> {
    return this.realFillRepo.readRecent(100)
  }

  @Get('admin/real/discrepancies')
  async discrepancies(): Promise<{ count: number; orders: Array<Record<string, unknown>> }> {
    const rows = await this.realOrderRepo.readOpen()
    const flagged = rows.filter((r) => r.discrepancy !== null)
    return {
      count: flagged.length,
      orders: flagged.map((r) => ({
        id: r.id,
        decisionId: r.decisionId,
        status: r.status,
        size: r.size,
        filledSize: r.filledSize,
        discrepancy: r.discrepancy,
        lastReconciledAt: r.lastReconciledAt,
      })),
    }
  }

  @Get('compare')
  async compare(): Promise<CompareRow[]> {
    const [paperFills, realFills] = await Promise.all([
      this.fillRepo.readAll(10_000),
      this.realFillRepo.readAll(10_000),
    ])

    // Index real fills by decisionId for quick lookup
    const realByDecision = new Map<string, (typeof realFills)[0]>()
    for (const rf of realFills) {
      realByDecision.set(rf.decisionId, rf)
    }

    // Build compare table keyed by paper decisionId
    const rows: CompareRow[] = []

    for (const pf of paperFills) {
      const decisionId = pf.decisionId ?? pf.id
      const rf = realByDecision.get(decisionId)

      const paperFillPrice = pf.fillPrice
      const realFillPrice = rf?.fillPrice ?? null
      const priceDelta =
        realFillPrice !== null ? realFillPrice - paperFillPrice : null

      const paperPnlUsd = pf.realisedPnlUsd
      const realPnlUsd = rf?.realisedPnlUsd ?? null
      const pnlDelta = realPnlUsd !== null ? realPnlUsd - paperPnlUsd : null

      rows.push({
        decisionId,
        paperFillPrice,
        realFillPrice,
        priceDelta,
        paperPnlUsd,
        realPnlUsd,
        pnlDelta,
        side: pf.side,
        conditionId: pf.conditionId,
        filledAt: pf.filledAt,
      })
    }

    // Also include real fills that have no paper counterpart (orphans)
    for (const rf of realFills) {
      if (!rows.find((r) => r.decisionId === rf.decisionId)) {
        rows.push({
          decisionId: rf.decisionId,
          paperFillPrice: null,
          realFillPrice: rf.fillPrice,
          priceDelta: null,
          paperPnlUsd: null,
          realPnlUsd: rf.realisedPnlUsd,
          pnlDelta: null,
          side: rf.side,
          conditionId: rf.conditionId,
          filledAt: rf.filledAt,
        })
      }
    }

    return rows.sort((a, b) => (b.filledAt ?? 0) - (a.filledAt ?? 0))
  }
}
