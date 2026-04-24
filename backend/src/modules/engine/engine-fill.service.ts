import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import type { BookView } from '../../domain/book.types'
import { ENGINE_EVENT, type OrderCancelledEvent, type OrderFilledEvent } from '../../domain/events'
import { BROKER_TOKEN, type Broker } from '../../domain/broker.types'
import {
  DRIFT_CANCEL_TICKS,
  INVENTORY_BIAS_DECAY_MS,
  MAX_HEDGE_SLIPPAGE,
  MAX_HEDGE_SLIPPAGE_ABS,
  REPOSITION_DELAY_MS,
  TICK,
} from '../../domain/constants'
import type { InternalPosition } from '../../domain/engine.types'
import { notifyTelegram } from '../../domain/notify'
import {
  checkAdverseSelection,
  checkMarketDrawdown,
  checkPortfolioDrawdown,
} from '../../domain/risk'
import type { StrategyConfig } from '../../domain/strategy.types'
import { FillRepo, type FillRow } from '../persistence/fill.repo'
import { OrderRepo } from '../persistence/order.repo'
import { PositionRepo } from '../persistence/position.repo'

import { EngineAllocService } from './engine-alloc.service'
import type { EngineRuntimeState } from './engine-state'
import { positionRowFromInternal } from './engine-state'

@Injectable()
export class EngineFillService {
  private readonly logger = new Logger('engine.fill')

  constructor(
    @Inject(BROKER_TOKEN) private readonly broker: Broker,
    private readonly orderRepo: OrderRepo,
    private readonly fillRepo: FillRepo,
    private readonly positionRepo: PositionRepo,
    @Inject(forwardRef(() => EngineAllocService)) private readonly alloc: EngineAllocService,
    private readonly events: EventEmitter2,
  ) {}

  evaluateBook(s: EngineRuntimeState, tokenId: string, view: BookView): void {
    if (s.state !== 'running') return
    let pos: InternalPosition | undefined
    for (const p of s.positions.values()) {
      if (p.tokenId === tokenId) {
        pos = p
        break
      }
    }
    if (!pos) return

    pos.latestBook = view
    pos.midPrice = view.mid
    pos.bestBid = view.bestBid
    pos.bestAsk = view.bestAsk

    // C4: drift-cancel.
    const bidDrift =
      pos.bidOrderId &&
      view.bestBid !== null &&
      view.bestBid > pos.bidPrice &&
      view.bestBid <= pos.bidPrice + DRIFT_CANCEL_TICKS * TICK
    const askDrift =
      pos.askOrderId &&
      view.bestAsk !== null &&
      view.bestAsk < pos.askPrice &&
      view.bestAsk >= pos.askPrice - DRIFT_CANCEL_TICKS * TICK
    if (bidDrift || askDrift) {
      const tag = pos.conditionId.slice(0, 8)
      this.logger.log(
        `C4 drift-cancel ${tag} — bestBid=${view.bestBid?.toFixed(3)} ourBid=${pos.bidPrice.toFixed(3)} bestAsk=${view.bestAsk?.toFixed(3)} ourAsk=${pos.askPrice.toFixed(3)}`,
      )
      s.positions.delete(pos.conditionId)
      const toCancel = [pos.bidOrderId, pos.askOrderId].filter((x): x is string => !!x)
      const now = Date.now()
      const cidToRepost = pos.conditionId
      const decisionIdToCancel = pos.decisionId
      void Promise.all(toCancel.map((id) => this.broker.cancelOrder(id))).then(async () => {
        for (const id of toCancel) await this.orderRepo.updateStatus(id, 'cancelled', now)
        await this.positionRepo.delete(cidToRepost)
        for (const id of toCancel) {
          this.events.emit(ENGINE_EVENT.ORDER_CANCELLED, {
            decisionId: decisionIdToCancel,
            paperOrderId: id,
            at: now,
          } satisfies OrderCancelledEvent)
        }
        setTimeout(() => {
          void this.alloc.repositionMarket(s, cidToRepost)
        }, REPOSITION_DELAY_MS)
      })
      return
    }

    if (pos.bidOrderId && view.bestBid !== null && view.bestBid <= pos.bidPrice) {
      void this.handleFill(s, pos, 'bid', view)
    }
    if (pos.askOrderId && view.bestAsk !== null && view.bestAsk >= pos.askPrice) {
      void this.handleFill(s, pos, 'ask', view)
    }
  }

  private async handleFill(
    s: EngineRuntimeState,
    pos: InternalPosition,
    side: 'bid' | 'ask',
    view: BookView,
  ): Promise<void> {
    const orderId = side === 'bid' ? pos.bidOrderId : pos.askOrderId
    if (!orderId) return
    const config: StrategyConfig = s.config ?? ({ makerFeePct: 0, takerFeePct: 0 } as StrategyConfig)

    if (side === 'bid') pos.bidOrderId = null
    else pos.askOrderId = null

    const orderPrice = side === 'bid' ? pos.bidPrice : pos.askPrice
    const orderSize = side === 'bid' ? pos.bidSize : pos.askSize
    await this.orderRepo.updateStatus(orderId, 'filled', Date.now())

    const rawHedgePrice = side === 'bid' ? view.bestBid ?? orderPrice : view.bestAsk ?? orderPrice
    const fillTimeSlip =
      side === 'bid' ? (orderPrice - rawHedgePrice) / orderPrice : (rawHedgePrice - orderPrice) / orderPrice
    const fillTimeSlipAbs = Math.abs(orderPrice - rawHedgePrice)
    const tripPct = fillTimeSlip > MAX_HEDGE_SLIPPAGE
    const tripAbs = fillTimeSlipAbs > MAX_HEDGE_SLIPPAGE_ABS
    const isPassiveHedge = tripPct || tripAbs
    const hedgePrice = isPassiveHedge ? orderPrice : rawHedgePrice
    const hedgeSide = side === 'bid' ? 'sell' : 'buy'
    if (isPassiveHedge) {
      const reason =
        tripAbs && !tripPct
          ? `abs slip $${fillTimeSlipAbs.toFixed(3)} > $${MAX_HEDGE_SLIPPAGE_ABS}`
          : `slip ${(fillTimeSlip * 100).toFixed(1)}% > ${(MAX_HEDGE_SLIPPAGE * 100).toFixed(0)}%`
      this.logger.log(`fill-time ${reason} on ${pos.conditionId.slice(0, 8)} — passive hedge at ${orderPrice}`)
      const oppositeOrderId = side === 'bid' ? pos.askOrderId : pos.bidOrderId
      if (oppositeOrderId) {
        if (side === 'bid') pos.askOrderId = null
        else pos.bidOrderId = null
        const cancelledAt = Date.now()
        void this.broker.cancelOrder(oppositeOrderId).then(async () => {
          await this.orderRepo.updateStatus(oppositeOrderId, 'cancelled', cancelledAt)
          this.events.emit(ENGINE_EVENT.ORDER_CANCELLED, {
            decisionId: pos.decisionId,
            paperOrderId: oppositeOrderId,
            at: cancelledAt,
          } satisfies OrderCancelledEvent)
        })
      }
    }
    const gross =
      side === 'bid' ? (hedgePrice - orderPrice) * orderSize : (orderPrice - hedgePrice) * orderSize
    const makerFee = orderPrice * orderSize * (config.makerFeePct ?? 0)
    const takerFee = hedgePrice * orderSize * (config.takerFeePct ?? 0)
    const realisedPnl = gross - makerFee - takerFee
    const fillId = `fill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    const fill: FillRow = {
      id: fillId,
      decisionId: pos.decisionId,
      orderId,
      conditionId: pos.conditionId,
      question: pos.question,
      side,
      fillPrice: orderPrice,
      size: orderSize,
      hedgePrice,
      realisedPnlUsd: realisedPnl,
      makerFeeUsd: makerFee,
      takerFeeUsd: takerFee,
      filledAt: Date.now(),
      hedgeOrderId: null,
      hedgeStatus: 'pending',
    }
    await this.fillRepo.insert(fill)
    await this.positionRepo.upsert(positionRowFromInternal(pos, Date.now()))
    this.events.emit(ENGINE_EVENT.ORDER_FILLED, {
      decisionId: pos.decisionId,
      paperFill: fill,
      hedgeSide,
      hedgeExpectedPrice: orderPrice,
      hedgeFillPrice: hedgePrice,
      tokenId: pos.tokenId,
      isPassiveHedge,
    } satisfies OrderFilledEvent)

    s.inventoryBias.set(pos.conditionId, {
      bias: side === 'bid' ? 'long' : 'short',
      until: Date.now() + INVENTORY_BIAS_DECAY_MS,
    })

    const pnlSign = realisedPnl >= 0 ? '+' : ''
    notifyTelegram(
      `🔔 Fill (${side})\n${pos.question}\nprice=${orderPrice.toFixed(3)} size=${orderSize} pnl=${pnlSign}$${realisedPnl.toFixed(2)}`,
    )

    try {
      const hedgeRes = await this.broker.marketHedge({
        conditionId: pos.conditionId,
        tokenId: pos.tokenId,
        side: hedgeSide,
        size: orderSize,
        expectedPrice: orderPrice,
        fillPrice: hedgePrice,
      })
      await this.fillRepo.updateHedge(fillId, hedgeRes.id, 'done')
    } catch {
      await this.fillRepo.updateHedge(fillId, null, 'failed')
    }

    if (isPassiveHedge) {
      const blMs = (s.config?.blacklistMinutes ?? 60) * 60_000
      const bl = Date.now() + blMs
      s.blacklist.set(pos.conditionId, bl)
      s.fillHistory.delete(pos.conditionId)
      s.marketPnlHistory.delete(pos.conditionId)
      s.inventoryBias.delete(pos.conditionId)
      void this.alloc.closePosition(s, pos.conditionId)

      const slipTxt =
        tripAbs && !tripPct ? `$${fillTimeSlipAbs.toFixed(3)} abs` : `${(fillTimeSlip * 100).toFixed(1)}%`
      notifyTelegram(
        `⚠️ Unhedged fill: ${slipTxt} slippage on ${side}\n${pos.question}\nOpposite side cancelled. Blacklisted ${s.config?.blacklistMinutes ?? 60}m.`,
      )
      return
    }

    const cfg = s.config ?? ({} as StrategyConfig)
    const condId = pos.conditionId
    const now = Date.now()

    // Breaker 1: adverse selection
    const adverse = checkAdverseSelection(s.fillHistory, condId, side, now, cfg)
    if (adverse) {
      this.logger.log(
        `adverse-selection on ${condId.slice(0, 8)} — ${adverse.sameSideFills}× ${side} in ${adverse.windowMinutes}m`,
      )
      s.blacklist.set(condId, adverse.blacklistUntil)
      s.fillHistory.delete(condId)
      s.inventoryBias.delete(condId)
      void this.alloc.closePosition(s, condId)
      notifyTelegram(
        `🚨 Adverse selection: ${adverse.sameSideFills}× ${side} fills in ${adverse.windowMinutes}m\n${pos.question}\nPosition closed. Blacklisted ${adverse.blacklistMinutes}m.`,
      )
    }

    // Breaker 2: per-market drawdown
    const market = checkMarketDrawdown(s.marketPnlHistory, s.blacklist, condId, realisedPnl, now, cfg)
    if (market) {
      this.logger.log(
        `🛑 market drawdown on ${condId.slice(0, 8)} — $${market.windowPnl.toFixed(2)} in ${market.windowHours}h`,
      )
      s.blacklist.set(condId, market.blacklistUntil)
      s.marketPnlHistory.delete(condId)
      s.inventoryBias.delete(condId)
      void this.alloc.closePosition(s, condId)
      notifyTelegram(
        `🛑 Market drawdown: $${market.windowPnl.toFixed(2)} in ${market.windowHours}h ≤ −$${market.lossLimitUsd}\n${pos.question}\nPosition closed. Blacklisted ${market.blacklistMinutes}m.`,
      )
    }

    // Breaker 3: portfolio drawdown
    const portfolio = checkPortfolioDrawdown(s.portfolioPnlHistory, s.globalPauseUntil, realisedPnl, now, cfg)
    s.portfolioPnlHistory = portfolio.history
    if (portfolio.hit) {
      const h = portfolio.hit
      s.globalPauseUntil = h.globalPauseUntil
      this.logger.log(
        `🛑🛑 PORTFOLIO DRAWDOWN — $${h.windowPnl.toFixed(2)} in ${h.windowHours}h, pausing ${h.pauseMinutes}m`,
      )
      s.portfolioPnlHistory = []
      for (const heldId of [...s.positions.keys()]) void this.alloc.closePosition(s, heldId)
      notifyTelegram(
        `🛑🛑 PORTFOLIO DRAWDOWN: $${h.windowPnl.toFixed(2)} in ${h.windowHours}h ≤ −$${h.lossLimitUsd}\nAll positions closed. Engine paused ${h.pauseMinutes}m.`,
      )
    }
  }
}
