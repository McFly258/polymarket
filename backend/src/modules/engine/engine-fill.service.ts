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
  REALLOC_MS,
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
import { RealPositionRepo } from '../real-execution/real-position.repo'

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
    private readonly realPositionRepo: RealPositionRepo,
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

    // C6 data: sample mid into rolling history (throttled to one per REALLOC_MS)
    if (view.mid !== null) {
      const now = Date.now()
      const lastSampled = s.midPriceLastSampled.get(pos.conditionId) ?? 0
      if (now - lastSampled >= REALLOC_MS) {
        const hist = s.midPriceHistory.get(pos.conditionId) ?? []
        hist.push({ ts: now, mid: view.mid })
        const cutoff = now - 24 * 60 * 60 * 1000
        s.midPriceHistory.set(pos.conditionId, hist.filter((h) => h.ts >= cutoff))
        s.midPriceLastSampled.set(pos.conditionId, now)
      }
    }

    // C5: MTM stop-loss — mid has moved far enough against our resting price
    // that a fill would be unhedgeable without a large loss. Cancel and blacklist.
    const mtmStop = s.config?.mtmStopLossPct ?? 0
    if (mtmStop > 0 && view.mid !== null) {
      const bidBreached = !!pos.bidOrderId && view.mid < pos.bidPrice * (1 - mtmStop)
      const askBreached = !!pos.askOrderId && view.mid > pos.askPrice * (1 + mtmStop)
      if (bidBreached || askBreached) {
        const side = bidBreached ? 'bid' : 'ask'
        const ourPrice = bidBreached ? pos.bidPrice : pos.askPrice
        const tag = pos.conditionId.slice(0, 8)
        this.logger.log(
          `C5 MTM stop-loss ${tag} — mid=${view.mid.toFixed(3)} ${side}Price=${ourPrice.toFixed(3)} threshold=${(mtmStop * 100).toFixed(0)}%`,
        )
        const blMs = (s.config?.blacklistMinutes ?? 60) * 60_000
        s.blacklist.set(pos.conditionId, Date.now() + blMs)
        s.fillHistory.delete(pos.conditionId)
        s.marketPnlHistory.delete(pos.conditionId)
        s.inventoryBias.delete(pos.conditionId)
        void this.alloc.closePosition(s, pos.conditionId)
        notifyTelegram(
          `⛔ MTM stop-loss: ${side} posted at ${ourPrice.toFixed(3)}, mid=${view.mid.toFixed(3)} (>${(mtmStop * 100).toFixed(0)}% move)\n${pos.question}\nOrders cancelled. Blacklisted ${s.config?.blacklistMinutes ?? 60}m.`,
        )
        return
      }
    }

    // C5b: Inventory MTM stop-loss — one side already filled (holding inventory),
    // mid has moved far enough against our fill price that carrying the position
    // is worse than closing now. Complements C5 which only fires on open orders.
    // Uses pendingPairFill (not order presence) so it also fires when both orders
    // are gone but inventory is still held (e.g. hedge order expired/cancelled).
    const longInventory = pos.pendingPairFill === 'bid'
    const shortInventory = pos.pendingPairFill === 'ask'
    if (mtmStop > 0 && view.mid !== null && (longInventory || shortInventory)) {
      const longBreached = longInventory && view.mid < pos.bidPrice * (1 - mtmStop)
      const shortBreached = shortInventory && view.mid > pos.askPrice * (1 + mtmStop)
      if (longBreached || shortBreached) {
        const inventorySide = longBreached ? 'long' : 'short'
        const fillPrice = longBreached ? pos.bidPrice : pos.askPrice
        const tag = pos.conditionId.slice(0, 8)
        this.logger.log(
          `C5b inventory MTM stop ${tag} — ${inventorySide} filled@${fillPrice.toFixed(3)} mid=${view.mid.toFixed(3)} threshold=${(mtmStop * 100).toFixed(0)}%`,
        )
        const blMs = (s.config?.blacklistMinutes ?? 60) * 60_000
        s.blacklist.set(pos.conditionId, Date.now() + blMs)
        s.fillHistory.delete(pos.conditionId)
        s.marketPnlHistory.delete(pos.conditionId)
        s.inventoryBias.delete(pos.conditionId)
        void this.alloc.closePosition(s, pos.conditionId)
        notifyTelegram(
          `⛔ Inventory MTM stop-loss: ${inventorySide} filled@${fillPrice.toFixed(3)}, mid=${view.mid.toFixed(3)} (>${(mtmStop * 100).toFixed(0)}% against)\n${pos.question}\nRemaining order cancelled. Blacklisted ${s.config?.blacklistMinutes ?? 60}m.`,
        )
        return
      }
    }

    // C4: drift-cancel — fire whenever market has moved ≥ DRIFT_CANCEL_TICKS away,
    //     not just within 1 tick, so large jumps don't leave capital stranded.
    const bidDrift =
      pos.bidOrderId &&
      view.bestBid !== null &&
      view.bestBid >= pos.bidPrice + DRIFT_CANCEL_TICKS * TICK
    const askDrift =
      pos.askOrderId &&
      view.bestAsk !== null &&
      view.bestAsk <= pos.askPrice - DRIFT_CANCEL_TICKS * TICK
    if (bidDrift || askDrift) {
      const tag = pos.conditionId.slice(0, 8)
      this.logger.log(
        `C4 drift-cancel ${tag} — bestBid=${view.bestBid?.toFixed(3)} ourBid=${pos.bidPrice.toFixed(3)} bestAsk=${view.bestAsk?.toFixed(3)} ourAsk=${pos.askPrice.toFixed(3)}`,
      )
      const cidToRepost = pos.conditionId
      // Mark BEFORE deleting so a concurrent reallocate() will not see the
      // empty slot and double-open while the cancel/repost is still racing.
      s.pendingRepostMarkets.add(cidToRepost)
      s.positions.delete(cidToRepost)
      const toCancel = [pos.bidOrderId, pos.askOrderId].filter((x): x is string => !!x)
      const now = Date.now()
      const decisionIdToCancel = pos.decisionId
      Promise.all(toCancel.map((id) => this.broker.cancelOrder(id)))
        .then(async () => {
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
        .catch((err: unknown) => {
          // Cancel chain failed before reposition was scheduled — clear the
          // marker so the market is eligible for re-entry on next reallocate.
          s.pendingRepostMarkets.delete(cidToRepost)
          this.logger.warn(
            `drift-cancel ${tag} cancel chain failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      return
    }

    if (pos.bidOrderId && view.bestAsk !== null && view.bestAsk <= pos.bidPrice) {
      void this.handleFill(s, pos, 'bid', view)
    }
    if (pos.askOrderId && view.bestBid !== null && view.bestBid >= pos.askPrice) {
      void this.handleFill(s, pos, 'ask', view)
    }
  }

  // Periodic sweep — fires on a timer independent of book ticks. Catches the case
  // where the WS goes quiet (illiquid or resolved market) but midPrice was last
  // updated while the book was still live and already reflects the collapsed price.
  sweepMtm(s: EngineRuntimeState): void {
    if (s.state !== 'running') return
    const mtmStop = s.config?.mtmStopLossPct ?? 0
    for (const pos of s.positions.values()) {
      if (pos.midPrice === null) continue
      const mid = pos.midPrice

      // C5-sweep: open order MTM (only when mtmStop is configured)
      const bidBreached = mtmStop > 0 && !!pos.bidOrderId && mid < pos.bidPrice * (1 - mtmStop)
      const askBreached = mtmStop > 0 && !!pos.askOrderId && mid > pos.askPrice * (1 + mtmStop)
      if (bidBreached || askBreached) {
        const side = bidBreached ? 'bid' : 'ask'
        const ourPrice = bidBreached ? pos.bidPrice : pos.askPrice
        const tag = pos.conditionId.slice(0, 8)
        this.logger.log(
          `C5-sweep MTM stop ${tag} — mid=${mid.toFixed(3)} ${side}Price=${ourPrice.toFixed(3)} threshold=${(mtmStop * 100).toFixed(0)}%`,
        )
        const blMs = (s.config?.blacklistMinutes ?? 60) * 60_000
        s.blacklist.set(pos.conditionId, Date.now() + blMs)
        s.fillHistory.delete(pos.conditionId)
        s.marketPnlHistory.delete(pos.conditionId)
        s.inventoryBias.delete(pos.conditionId)
        void this.alloc.closePosition(s, pos.conditionId)
        notifyTelegram(
          `⛔ MTM stop-loss (sweep): ${side} posted at ${ourPrice.toFixed(3)}, mid=${mid.toFixed(3)} (>${(mtmStop * 100).toFixed(0)}% move)\n${pos.question}\nOrders cancelled. Blacklisted ${s.config?.blacklistMinutes ?? 60}m.`,
        )
        continue
      }

      // C5b-sweep: inventory MTM — uses pendingPairFill so it fires even when
      // both orders are gone but the filled inventory is still being held.
      const longInventory = pos.pendingPairFill === 'bid'
      const shortInventory = pos.pendingPairFill === 'ask'
      if (longInventory || shortInventory) {
        const longBreached = mtmStop > 0 && longInventory && mid < pos.bidPrice * (1 - mtmStop)
        const shortBreached = mtmStop > 0 && shortInventory && mid > pos.askPrice * (1 + mtmStop)
        if (longBreached || shortBreached) {
          const inventorySide = longBreached ? 'long' : 'short'
          const fillPrice = longBreached ? pos.bidPrice : pos.askPrice
          const tag = pos.conditionId.slice(0, 8)
          this.logger.log(
            `C5b-sweep inventory MTM stop ${tag} — ${inventorySide} filled@${fillPrice.toFixed(3)} mid=${mid.toFixed(3)} threshold=${(mtmStop * 100).toFixed(0)}%`,
          )
          const blMs = (s.config?.blacklistMinutes ?? 60) * 60_000
          s.blacklist.set(pos.conditionId, Date.now() + blMs)
          s.fillHistory.delete(pos.conditionId)
          s.marketPnlHistory.delete(pos.conditionId)
          s.inventoryBias.delete(pos.conditionId)
          void this.alloc.closePosition(s, pos.conditionId)
          notifyTelegram(
            `⛔ Inventory MTM stop-loss (sweep): ${inventorySide} filled@${fillPrice.toFixed(3)}, mid=${mid.toFixed(3)} (>${(mtmStop * 100).toFixed(0)}% against)\n${pos.question}\nRemaining order cancelled. Blacklisted ${s.config?.blacklistMinutes ?? 60}m.`,
          )
          continue
        }

        // C6: max inventory hold time — force-liquidate if opposing leg hasn't
        // filled within the configured window. Prevents dead capital when the
        // market stalls after a one-sided fill.
        const maxHoldMs = (s.config?.maxInventoryHoldMinutes ?? 5) * 60_000
        if (pos.pendingPairFillAt && Date.now() - pos.pendingPairFillAt > maxHoldMs) {
          const inventorySide = longInventory ? 'long' : 'short'
          const fillPrice = longInventory ? pos.bidPrice : pos.askPrice
          const heldMin = ((Date.now() - pos.pendingPairFillAt) / 60_000).toFixed(1)
          const tag = pos.conditionId.slice(0, 8)
          this.logger.log(
            `C6 max-hold liquidation ${tag} — ${inventorySide} held ${heldMin}m (>${s.config?.maxInventoryHoldMinutes ?? 5}m limit)`,
          )
          s.fillHistory.delete(pos.conditionId)
          s.marketPnlHistory.delete(pos.conditionId)
          s.inventoryBias.delete(pos.conditionId)
          void this.alloc.closePosition(s, pos.conditionId)
          notifyTelegram(
            `⏱ Max-hold liquidation: ${inventorySide} filled@${fillPrice.toFixed(3)} held ${heldMin}m without opposing fill\n${pos.question}\nForce-liquidating.`,
          )
        }
      }
    }
  }

  // Adopts real_positions (from the reconciler) that are not yet tracked in
  // s.positions. This catches orphan inventory: fills that happened while the
  // engine was down, or pair-hedges where both legs completed externally. Once
  // adopted, C5b and sweepMtm can fire on them like any other held position.
  async sweepOrphans(s: EngineRuntimeState): Promise<void> {
    if (s.state !== 'running') return
    let realPositions: import('../real-execution/real-position.repo').RealPositionRow[]
    try {
      realPositions = await this.realPositionRepo.readAll()
    } catch {
      return
    }
    const COOLDOWN_MS = 15 * 60 * 1000
    for (const rp of realPositions) {
      if (s.positions.has(rp.conditionId)) continue
      const liquidatedAt = s.liquidationCooldown.get(rp.conditionId)
      if (liquidatedAt && Date.now() - liquidatedAt < COOLDOWN_MS) continue
      const netLong = rp.bidSize - rp.askSize
      if (netLong < 1) continue
      const tag = rp.conditionId.slice(0, 8)
      this.logger.log(`sweepOrphans: adopting orphan position ${tag} netLong=${netLong.toFixed(2)}`)
      const orphan: InternalPosition = {
        conditionId: rp.conditionId,
        question: rp.question,
        tokenId: rp.tokenId,
        outcome: rp.outcome,
        decisionId: rp.decisionId,
        bidOrderId: null,
        askOrderId: null,
        bidPrice: rp.bidPrice,
        askPrice: rp.askPrice,
        bidSize: netLong,
        askSize: rp.askSize,
        maxSpreadDollars: 0,
        dailyPool: 0,
        midPrice: null,
        bestBid: null,
        bestAsk: null,
        rewardSharePct: 0,
        expectedRatePerDay: 0,
        capitalUsd: rp.capitalUsd,
        totalEarnedUsd: 0,
        earnedSinceLastSnapshot: 0,
        ourScore: 0,
        totalScore: 0,
        latestBook: null,
        pendingPairFill: 'bid',
        pendingPairFillAt: Date.now(),
      }
      s.positions.set(rp.conditionId, orphan)
      notifyTelegram(
        `⚠️ Orphan position adopted: ${tag}\nNet long ${netLong.toFixed(2)} shares @ avg ${rp.bidPrice.toFixed(3)}\nLiquidating immediately.`,
      )
      // Liquidate immediately — don't wait for a WS tick (illiquid markets never get one).
      await this.alloc.closePosition(s, rp.conditionId)
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

    const oppositeOrderId = side === 'bid' ? pos.askOrderId : pos.bidOrderId
    const oppositeAlreadyPending = pos.pendingPairFill && pos.pendingPairFill !== side

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
    // Pair-hedge: opposing GTC order is the natural hedge — skip FOK to capture full spread.
    const usePairHedge = !isPassiveHedge && (oppositeOrderId || oppositeAlreadyPending)
    const hedgePrice = isPassiveHedge || usePairHedge ? orderPrice : rawHedgePrice
    const hedgeSide = side === 'bid' ? 'sell' : 'buy'
    if (isPassiveHedge) {
      const reason =
        tripAbs && !tripPct
          ? `abs slip $${fillTimeSlipAbs.toFixed(3)} > $${MAX_HEDGE_SLIPPAGE_ABS}`
          : `slip ${(fillTimeSlip * 100).toFixed(1)}% > ${(MAX_HEDGE_SLIPPAGE * 100).toFixed(0)}%`
      this.logger.log(`fill-time ${reason} on ${pos.conditionId.slice(0, 8)} — passive hedge at ${orderPrice}`)
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
    } else if (usePairHedge) {
      // Mark the pair leg so the second fill (or shutdown) knows not to externally hedge.
      pos.pendingPairFill = oppositeAlreadyPending ? undefined : side
      pos.pendingPairFillAt = pos.pendingPairFill ? Date.now() : undefined
      this.logger.log(
        `pair-hedge ${pos.conditionId.slice(0, 8)} — ${side} filled at ${orderPrice}, ${
          oppositeAlreadyPending ? 'closing pair' : 'awaiting opposite leg'
        }`,
      )
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
      noTokenId: pos.noTokenId,
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

    if (usePairHedge) {
      // Opposing GTC order is the hedge — no external dispatch needed.
      await this.fillRepo.updateHedge(fillId, null, 'not-applicable')
    } else {
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
        // Mark inventory so C5b MTM and closePosition can see and liquidate it.
        // The reconciler's retryUnhedgedFills will also retry the hedge.
        pos.pendingPairFill = side
        pos.pendingPairFillAt = Date.now()
      }
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
