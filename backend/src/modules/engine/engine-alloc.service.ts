import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ENGINE_EVENT, newDecisionId, type OrderCancelledEvent, type OrderPlacedEvent } from '../../domain/events'
import {
  INVENTORY_SKEW_TIGHT_TICKS,
  INVENTORY_SKEW_WIDE_TICKS,
  MAX_DAILY_STDDEV,
  MAX_HEDGE_SLIPPAGE,
  MAX_HEDGE_SLIPPAGE_ABS,
  MAX_MID_PRICE,
  MIN_BOOK_DEPTH_SHARES,
  MIN_BOOK_LEVELS,
  MIN_HEDGE_DEPTH_RATIO,
  MIN_MID_PRICE,
  MIN_PRICE_FLOOR,
  TICK,
} from '../../domain/constants'
import type { InternalPosition } from '../../domain/engine.types'
import { notifyTelegram } from '../../domain/notify'
import { daysUntil, runSimulation } from '../../domain/strategy'
import type {
  MarketVolatility,
  RewardsRow,
  StrategyAllocation,
} from '../../domain/strategy.types'
import { BROKER_TOKEN, type Broker, type PlaceOrderRequest } from '../../domain/broker.types'
import { FillRepo } from '../persistence/fill.repo'
import { OrderRepo, type OrderRow } from '../persistence/order.repo'
import { PositionRepo } from '../persistence/position.repo'
import { EngineStateRepo } from '../persistence/engine-state.repo'

import { EngineDataService } from './engine-data.service'
import type { EngineRuntimeState } from './engine-state'
import { positionRowFromInternal } from './engine-state'
import { EngineService } from './engine.service'

@Injectable()
export class EngineAllocService {
  private readonly logger = new Logger('engine.alloc')

  constructor(
    @Inject(forwardRef(() => EngineService)) private readonly engine: EngineService,
    private readonly data: EngineDataService,
    @Inject(BROKER_TOKEN) private readonly broker: Broker,
    private readonly orderRepo: OrderRepo,
    private readonly fillRepo: FillRepo,
    private readonly positionRepo: PositionRepo,
    private readonly stateRepo: EngineStateRepo,
    private readonly events: EventEmitter2,
  ) {}

  async reallocate(s: EngineRuntimeState): Promise<void> {
    if (s.state !== 'running' || !s.config) return
    if (Date.now() < s.globalPauseUntil) {
      this.logger.log(`reallocate skipped — global pause active until ${new Date(s.globalPauseUntil).toISOString()}`)
      return
    }
    this.logger.log('reallocating…')
    let rows: RewardsRow[]
    try {
      rows = await this.data.fetchRewardsRows()
    } catch (err) {
      this.logger.error('fetch failed during realloc, keeping existing positions', err as Error)
      return
    }
    const vol = this.data.loadVolatility()
    const sim = runSimulation(rows, s.config, vol)
    const byCondition = new Map(sim.allocations.map((a) => [a.conditionId, a]))
    const rowsById = new Map(rows.map((r) => [r.conditionId, r]))
    this.logger.log(
      `  allocations: ${sim.allocations.length} markets, deployed=$${sim.deployedCapital.toFixed(0)}, gross=$${sim.grossDailyUsd.toFixed(2)}/day`,
    )

    // 0. Resolution wind-down.
    const closeDays = s.config.closePositionDaysToResolution ?? 2
    if (closeDays > 0) {
      const nowMs = Date.now()
      const blacklistMs = (s.config.blacklistMinutes ?? 60) * 60_000
      for (const conditionId of [...s.positions.keys()]) {
        const row = rowsById.get(conditionId)
        if (!row) continue
        const days = daysUntil(row.endDateIso, nowMs)
        if (days !== null && days < closeDays) {
          const pos = s.positions.get(conditionId)
          this.logger.log(
            `wind-down on ${conditionId.slice(0, 8)} — ${days.toFixed(2)}d < ${closeDays}d, closing + blacklisting ${s.config.blacklistMinutes ?? 60}m`,
          )
          s.blacklist.set(conditionId, nowMs + blacklistMs)
          await this.closePosition(s, conditionId)
          if (pos) {
            notifyTelegram(
              `⏳ Wind-down: ${days.toFixed(2)}d to resolution < ${closeDays}d\n${pos.question}\nPosition closed. Blacklisted ${s.config.blacklistMinutes ?? 60}m.`,
            )
          }
        }
      }
    }

    // 1. Close positions no longer in allocation set.
    for (const conditionId of [...s.positions.keys()]) {
      if (!byCondition.has(conditionId)) {
        await this.closePosition(s, conditionId)
      }
    }

    // 2. Open or refresh positions for each allocation.
    for (const alloc of sim.allocations) {
      const row = rowsById.get(alloc.conditionId)
      if (!row) continue
      const existing = s.positions.get(alloc.conditionId)
      let effectiveAlloc = alloc
      const biasMeta = s.inventoryBias.get(alloc.conditionId)
      if (biasMeta && Date.now() < biasMeta.until && alloc.bidPrice !== null && alloc.askPrice !== null) {
        const wide = INVENTORY_SKEW_WIDE_TICKS * TICK
        const tight = INVENTORY_SKEW_TIGHT_TICKS * TICK
        const bidDelta = biasMeta.bias === 'long' ? -wide : +tight
        const askDelta = biasMeta.bias === 'long' ? -tight : +wide
        effectiveAlloc = {
          ...alloc,
          bidPrice: Math.max(0.01, alloc.bidPrice + bidDelta),
          askPrice: Math.min(0.99, alloc.askPrice + askDelta),
        }
      } else if (biasMeta && Date.now() >= biasMeta.until) {
        s.inventoryBias.delete(alloc.conditionId)
      }

      if (!existing) {
        await this.openPosition(s, effectiveAlloc, row, vol)
      } else if (
        Math.abs(existing.bidPrice - (effectiveAlloc.bidPrice ?? existing.bidPrice)) >= 0.01 ||
        Math.abs(existing.askPrice - (effectiveAlloc.askPrice ?? existing.askPrice)) >= 0.01 ||
        Math.abs(existing.capitalUsd - effectiveAlloc.capitalUsd) >= 1
      ) {
        await this.closePosition(s, effectiveAlloc.conditionId)
        await this.openPosition(s, effectiveAlloc, row, vol)
      }
    }

    // 3. Refresh WS subscription.
    this.engine.restartWs()
    await this.stateRepo.write({
      state: 'running',
      startedAt: s.startedAt,
      config: s.config,
      lastAllocAt: Date.now(),
    })
  }

  async openPosition(
    s: EngineRuntimeState,
    alloc: StrategyAllocation,
    row: RewardsRow,
    _vol: Record<string, MarketVolatility>,
  ): Promise<void> {
    if (alloc.bidPrice === null || alloc.askPrice === null) return
    const yesBook = row.books[0]
    if (!yesBook) return
    const noBook = row.books[1]

    const bestBid = yesBook.bestBid ?? 0
    const bestAsk = yesBook.bestAsk ?? 1
    const tag = alloc.conditionId.slice(0, 8)

    // Adverse-selection blacklist
    const blacklistExpiry = s.blacklist.get(alloc.conditionId)
    if (blacklistExpiry !== undefined) {
      if (Date.now() < blacklistExpiry) {
        this.logger.log(`skip ${tag} — blacklist (expires ${new Date(blacklistExpiry).toISOString()})`)
        return
      }
      s.blacklist.delete(alloc.conditionId)
    }

    // C1: price floor
    if (bestBid < MIN_PRICE_FLOOR || bestAsk < MIN_PRICE_FLOOR) {
      this.logger.log(`skip ${tag} — C1 price floor (bid=${bestBid.toFixed(3)} ask=${bestAsk.toFixed(3)})`)
      return
    }

    const bidCapital = alloc.bidCapitalUsd ?? alloc.capitalUsd / 2
    const askCapital = alloc.askCapitalUsd ?? alloc.capitalUsd / 2
    const bidSize = Math.floor(bidCapital / Math.max(alloc.bidPrice, 0.01))
    const askSize = Math.floor(askCapital / Math.max(alloc.askPrice, 0.01))
    const CLOB_MIN_ORDER_SIZE = 5
    if (bidSize < CLOB_MIN_ORDER_SIZE || askSize < CLOB_MIN_ORDER_SIZE) {
      this.logger.log(`skip ${tag} — size below CLOB min ${CLOB_MIN_ORDER_SIZE} (bid=${bidSize} ask=${askSize})`)
      return
    }

    // C2a: hedge slippage
    const bidHedgeSlip = alloc.bidPrice > 0 ? (alloc.bidPrice - bestBid) / alloc.bidPrice : 1
    const askHedgeSlip = alloc.askPrice > 0 ? (bestAsk - alloc.askPrice) / alloc.askPrice : 1
    const bidSlipAbs = alloc.bidPrice - bestBid
    const askSlipAbs = bestAsk - alloc.askPrice
    const bidTrip = bidHedgeSlip > MAX_HEDGE_SLIPPAGE || bidSlipAbs > MAX_HEDGE_SLIPPAGE_ABS
    const askTrip = askHedgeSlip > MAX_HEDGE_SLIPPAGE || askSlipAbs > MAX_HEDGE_SLIPPAGE_ABS
    if (bidTrip || askTrip) {
      this.logger.log(
        `skip ${tag} — C2a hedge slippage (bid=${(bidHedgeSlip * 100).toFixed(1)}%/$${bidSlipAbs.toFixed(3)} ask=${(askHedgeSlip * 100).toFixed(1)}%/$${askSlipAbs.toFixed(3)} caps=${MAX_HEDGE_SLIPPAGE * 100}%/$${MAX_HEDGE_SLIPPAGE_ABS})`,
      )
      return
    }

    // C2b: depth
    const bidDepth = yesBook.bids.slice(0, 10).reduce((x, l) => x + l.size, 0)
    const askDepth = yesBook.asks.slice(0, 10).reduce((x, l) => x + l.size, 0)
    if (bidDepth < MIN_HEDGE_DEPTH_RATIO * bidSize) {
      this.logger.log(`skip ${tag} — C2b bid depth ${bidDepth.toFixed(0)} < ${(MIN_HEDGE_DEPTH_RATIO * bidSize).toFixed(0)}`)
      return
    }
    if (askDepth < MIN_HEDGE_DEPTH_RATIO * askSize) {
      this.logger.log(`skip ${tag} — C2b ask depth ${askDepth.toFixed(0)} < ${(MIN_HEDGE_DEPTH_RATIO * askSize).toFixed(0)}`)
      return
    }

    // C5: book activity
    if (yesBook.bids.length < MIN_BOOK_LEVELS || yesBook.asks.length < MIN_BOOK_LEVELS) {
      this.logger.log(`skip ${tag} — C5 book levels (bids=${yesBook.bids.length} asks=${yesBook.asks.length})`)
      return
    }
    const totalBid = yesBook.bids.reduce((x, l) => x + l.size, 0)
    const totalAsk = yesBook.asks.reduce((x, l) => x + l.size, 0)
    if (totalBid < MIN_BOOK_DEPTH_SHARES || totalAsk < MIN_BOOK_DEPTH_SHARES) {
      this.logger.log(`skip ${tag} — C5 total depth (bids=${totalBid.toFixed(0)} asks=${totalAsk.toFixed(0)})`)
      return
    }

    // C6: volatility (skipped if no vol data)
    const marketVol = _vol[alloc.conditionId]
    if (marketVol && marketVol.dailyStddevDollars > MAX_DAILY_STDDEV) {
      this.logger.log(`skip ${tag} — C6 volatility (stddev=${marketVol.dailyStddevDollars.toFixed(4)})`)
      return
    }

    // C7: binary extreme
    const mid = yesBook.mid
    if (mid !== null && (mid < MIN_MID_PRICE || mid > MAX_MID_PRICE)) {
      this.logger.log(`skip ${tag} — C7 binary extreme (mid=${mid.toFixed(3)})`)
      return
    }

    const bidReq: PlaceOrderRequest = {
      conditionId: alloc.conditionId,
      tokenId: yesBook.tokenId,
      side: 'buy',
      price: alloc.bidPrice,
      size: bidSize,
      clientTag: 'paper-mm-bid',
    }
    const askReq: PlaceOrderRequest = {
      conditionId: alloc.conditionId,
      tokenId: yesBook.tokenId,
      side: 'sell',
      price: alloc.askPrice,
      size: askSize,
      clientTag: 'paper-mm-ask',
    }
    const [bidRes, askRes] = await Promise.all([
      this.broker.placeOrder(bidReq),
      this.broker.placeOrder(askReq),
    ])
    const now = Date.now()
    const decisionId = newDecisionId()

    const bidOrder: OrderRow = {
      id: bidRes.id,
      decisionId,
      conditionId: alloc.conditionId,
      tokenId: yesBook.tokenId,
      outcome: yesBook.outcome,
      side: 'bid',
      price: alloc.bidPrice,
      size: bidSize,
      status: 'resting',
      postedAt: bidRes.acceptedAt,
      postedBestBid: yesBook.bestBid,
      postedBestAsk: yesBook.bestAsk,
      closedAt: null,
    }
    const askOrder: OrderRow = {
      id: askRes.id,
      decisionId,
      conditionId: alloc.conditionId,
      tokenId: yesBook.tokenId,
      outcome: yesBook.outcome,
      side: 'ask',
      price: alloc.askPrice,
      size: askSize,
      status: 'resting',
      postedAt: askRes.acceptedAt,
      postedBestBid: yesBook.bestBid,
      postedBestAsk: yesBook.bestAsk,
      closedAt: null,
    }
    await this.orderRepo.insert(bidOrder)
    await this.orderRepo.insert(askOrder)
    this.events.emit(ENGINE_EVENT.ORDER_PLACED, { decisionId, paperOrder: bidOrder } satisfies OrderPlacedEvent)
    this.events.emit(ENGINE_EVENT.ORDER_PLACED, { decisionId, paperOrder: askOrder, noTokenId: noBook?.tokenId } satisfies OrderPlacedEvent)

    const pos: InternalPosition = {
      conditionId: alloc.conditionId,
      question: alloc.question,
      tokenId: yesBook.tokenId,
      noTokenId: noBook?.tokenId,
      outcome: yesBook.outcome,
      decisionId,
      bidOrderId: bidRes.id,
      askOrderId: askRes.id,
      bidPrice: alloc.bidPrice,
      askPrice: alloc.askPrice,
      bidSize,
      askSize,
      maxSpreadDollars: row.rewardMaxSpread / 100,
      dailyPool: row.dailyRate,
      midPrice: yesBook.mid,
      bestBid: yesBook.bestBid,
      bestAsk: yesBook.bestAsk,
      rewardSharePct: 0,
      expectedRatePerDay: 0,
      capitalUsd: alloc.capitalUsd,
      totalEarnedUsd: 0,
      earnedSinceLastSnapshot: 0,
      ourScore: 0,
      totalScore: 0,
      latestBook: null,
    }
    s.positions.set(alloc.conditionId, pos)
    await this.positionRepo.upsert(positionRowFromInternal(pos, now))
  }

  async closePosition(s: EngineRuntimeState, conditionId: string): Promise<void> {
    const pos = s.positions.get(conditionId)
    if (!pos) return
    const now = Date.now()
    const toCancel = [pos.bidOrderId, pos.askOrderId].filter((x): x is string => !!x)
    await Promise.all(toCancel.map((id) => this.broker.cancelOrder(id)))
    for (const id of toCancel) await this.orderRepo.updateStatus(id, 'cancelled', now)
    for (const id of toCancel) {
      this.events.emit(ENGINE_EVENT.ORDER_CANCELLED, {
        decisionId: pos.decisionId,
        paperOrderId: id,
        at: now,
      } satisfies OrderCancelledEvent)
    }
    s.positions.delete(conditionId)
    await this.positionRepo.delete(conditionId)
  }

  async repositionMarket(s: EngineRuntimeState, conditionId: string): Promise<void> {
    if (s.state !== 'running' || !s.config) return
    if (s.positions.has(conditionId)) return
    const tag = conditionId.slice(0, 8)
    let rows: RewardsRow[]
    try {
      rows = await this.data.fetchRewardsRows()
    } catch (err) {
      this.logger.error(`reposition ${tag} — fetch failed`, err as Error)
      return
    }
    const vol = this.data.loadVolatility()
    const sim = runSimulation(rows, s.config, vol)
    const alloc = sim.allocations.find((a) => a.conditionId === conditionId)
    const row = rows.find((r) => r.conditionId === conditionId)
    if (!alloc || !row) {
      this.logger.log(`reposition ${tag} — dropped by allocator, skip`)
      return
    }
    if (s.state !== 'running' || s.positions.has(conditionId)) return
    this.logger.log(`reposition ${tag} — post-drift repost`)
    await this.openPosition(s, alloc, row, vol)
  }
}
