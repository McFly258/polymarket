// WS book evaluation, drift-cancel, and post-fill handling.
//
// Split from engine.ts for file size / readability. Operates on the
// BackendPaperEngine's public state fields; the engine still owns all state.

import { Opik } from 'opik'
import type { StrategyConfig } from '../src/types.ts'

const opik = new Opik({ apiKey: process.env.OPIK_API_KEY, projectName: 'polymarket-paper' })
import {
  deletePosition,
  insertFill,
  updateFillHedge,
  updateOrderStatus,
  upsertPosition,
  type FillRow,
} from './db.ts'
import {
  DRIFT_CANCEL_TICKS,
  INVENTORY_BIAS_DECAY_MS,
  MAX_HEDGE_SLIPPAGE,
  MAX_HEDGE_SLIPPAGE_ABS,
  REPOSITION_DELAY_MS,
  TICK,
} from './engineConstants.ts'
import { notifyTelegram } from './engineNotify.ts'
import {
  checkAdverseSelection,
  checkMarketDrawdown,
  checkPortfolioDrawdown,
} from './engineRisk.ts'
import type { InternalPosition } from './engineTypes.ts'
import { closePosition, repositionMarket } from './engineAlloc.ts'
import type { BackendPaperEngine } from './engine.ts'
import type { BookView } from './wsClient.ts'

export function evaluateBook(engine: BackendPaperEngine, tokenId: string, view: BookView): void {
  if (engine.state !== 'running') return
  let pos: InternalPosition | undefined
  for (const p of engine.positions.values()) {
    if (p.tokenId === tokenId) { pos = p; break }
  }
  if (!pos) return

  pos.latestBook = view
  pos.midPrice = view.mid
  pos.bestBid = view.bestBid
  pos.bestAsk = view.bestAsk

  // C4: drift-cancel — market has moved within DRIFT_CANCEL_TICKS of our quote
  //     but hasn't filled us yet. Cancel immediately; next realloc will repost.
  const bidDrift = pos.bidOrderId && view.bestBid !== null &&
                   view.bestBid > pos.bidPrice &&
                   view.bestBid <= pos.bidPrice + DRIFT_CANCEL_TICKS * TICK
  const askDrift = pos.askOrderId && view.bestAsk !== null &&
                   view.bestAsk < pos.askPrice &&
                   view.bestAsk >= pos.askPrice - DRIFT_CANCEL_TICKS * TICK
  if (bidDrift || askDrift) {
    const tag = pos.conditionId.slice(0, 8)
    console.log(`[engine] C4 drift-cancel ${tag} — bestBid=${view.bestBid?.toFixed(3)} ourBid=${pos.bidPrice.toFixed(3)} bestAsk=${view.bestAsk?.toFixed(3)} ourAsk=${pos.askPrice.toFixed(3)}`)
    const driftTrace = opik.trace({ name: 'drift-cancel', input: { conditionId: pos.conditionId, question: pos.question, bidDrift, askDrift, bestBid: view.bestBid, bestAsk: view.bestAsk, ourBid: pos.bidPrice, ourAsk: pos.askPrice } })
    driftTrace.update({ output: { cancelled: [pos.bidOrderId, pos.askOrderId].filter(Boolean) } })
    engine.positions.delete(pos.conditionId)
    const toCancel = [pos.bidOrderId, pos.askOrderId].filter((x): x is string => !!x)
    const now = Date.now()
    const cidToRepost = pos.conditionId
    void Promise.all(toCancel.map((id) => engine.broker.cancelOrder(id))).then(() => {
      for (const id of toCancel) updateOrderStatus(id, 'cancelled', now)
      deletePosition(cidToRepost)
      setTimeout(() => { void repositionMarket(engine, cidToRepost) }, REPOSITION_DELAY_MS)
    })
    return
  }

  if (pos.bidOrderId && view.bestBid !== null && view.bestBid <= pos.bidPrice) {
    void handleFill(engine, pos, 'bid', view)
  }
  if (pos.askOrderId && view.bestAsk !== null && view.bestAsk >= pos.askPrice) {
    void handleFill(engine, pos, 'ask', view)
  }
}

export async function handleFill(
  engine: BackendPaperEngine,
  pos: InternalPosition,
  side: 'bid' | 'ask',
  view: BookView,
): Promise<void> {
  const orderId = side === 'bid' ? pos.bidOrderId : pos.askOrderId
  if (!orderId) return
  const config = engine.config ?? ({ makerFeePct: 0, takerFeePct: 0 } as StrategyConfig)

  const fillTrace = opik.trace({
    name: 'fill',
    input: { conditionId: pos.conditionId, question: pos.question, side, orderId, bestBid: view.bestBid, bestAsk: view.bestAsk, capitalUsd: pos.capitalUsd },
  })

  // Clear the side immediately to prevent re-entry.
  if (side === 'bid') pos.bidOrderId = null
  else pos.askOrderId = null

  const orderPrice = side === 'bid' ? pos.bidPrice : pos.askPrice
  const orderSize = side === 'bid' ? pos.bidSize : pos.askSize
  updateOrderStatus(orderId, 'filled', Date.now())

  // Re-check hedge slippage at fill time. The book may have moved significantly
  // since the order was posted. If current slippage exceeds the threshold, clamp
  // the hedge price to the last-known good level (passive limit) rather than
  // crossing the spread and eating a large taker loss.
  const rawHedgePrice = side === 'bid' ? (view.bestBid ?? orderPrice) : (view.bestAsk ?? orderPrice)
  const fillTimeSlip = side === 'bid'
    ? (orderPrice - rawHedgePrice) / orderPrice
    : (rawHedgePrice - orderPrice) / orderPrice
  const fillTimeSlipAbs = Math.abs(orderPrice - rawHedgePrice)
  // Trip on whichever cap is tighter — the % protects low-price markets, the
  // absolute cent cap protects high-price markets where 3% is 2¢+ of drift.
  const tripPct = fillTimeSlip > MAX_HEDGE_SLIPPAGE
  const tripAbs = fillTimeSlipAbs > MAX_HEDGE_SLIPPAGE_ABS
  const isPassiveHedge = tripPct || tripAbs
  const hedgePrice = isPassiveHedge
    ? orderPrice  // passive limit at fill price — zero slippage, waits for a cross
    : rawHedgePrice
  const hedgeSide = side === 'bid' ? 'sell' : 'buy'
  if (isPassiveHedge) {
    const reason = tripAbs && !tripPct
      ? `abs slip $${fillTimeSlipAbs.toFixed(3)} > $${MAX_HEDGE_SLIPPAGE_ABS}`
      : `slip ${(fillTimeSlip * 100).toFixed(1)}% > ${(MAX_HEDGE_SLIPPAGE * 100).toFixed(0)}%`
    console.log(`[engine] fill-time ${reason} on ${pos.conditionId.slice(0, 8)} — passive hedge at ${orderPrice}, cancelling opposite side`)
    // Prevent naked-inventory compounding: cancel the opposite-side resting
    // quote immediately so it cannot be adversely filled while we're waiting
    // for a passive hedge to clear.
    const oppositeOrderId = side === 'bid' ? pos.askOrderId : pos.bidOrderId
    if (oppositeOrderId) {
      if (side === 'bid') pos.askOrderId = null
      else pos.bidOrderId = null
      void engine.broker.cancelOrder(oppositeOrderId).then(() => {
        updateOrderStatus(oppositeOrderId, 'cancelled', Date.now())
      })
    }
  }
  const gross = side === 'bid'
    ? (hedgePrice - orderPrice) * orderSize
    : (orderPrice - hedgePrice) * orderSize
  const makerFee = orderPrice * orderSize * (config.makerFeePct ?? 0)
  const takerFee = hedgePrice * orderSize * (config.takerFeePct ?? 0)
  const realisedPnl = gross - makerFee - takerFee
  const fillId = `fill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  const fill: FillRow = {
    id: fillId, orderId, conditionId: pos.conditionId, question: pos.question, side,
    fillPrice: orderPrice, size: orderSize, hedgePrice, realisedPnlUsd: realisedPnl,
    makerFeeUsd: makerFee, takerFeeUsd: takerFee, filledAt: Date.now(),
    hedgeOrderId: null, hedgeStatus: 'pending',
  }
  insertFill(fill)
  upsertPosition(engine.toRow(pos, Date.now()))

  // Record inventory bias so the next repost skews quotes away from a same-side re-fill.
  engine.inventoryBias.set(pos.conditionId, {
    bias: side === 'bid' ? 'long' : 'short',
    until: Date.now() + INVENTORY_BIAS_DECAY_MS,
  })

  // Notify on every fill so the user can monitor activity in real time.
  const pnlSign = realisedPnl >= 0 ? '+' : ''
  notifyTelegram(`🔔 Fill (${side})\n${pos.question}\nprice=${orderPrice.toFixed(3)} size=${orderSize} pnl=${pnlSign}$${realisedPnl.toFixed(2)}`)

  try {
    const hedgeRes = await engine.broker.marketHedge({
      conditionId: pos.conditionId,
      tokenId: pos.tokenId,
      side: hedgeSide,
      size: orderSize,
      expectedPrice: orderPrice,
      fillPrice: hedgePrice,
    })
    updateFillHedge(fillId, hedgeRes.id, 'done')
    fillTrace.update({ output: { fillId, side, orderPrice, hedgePrice, hedgeSide, isPassiveHedge, realisedPnlUsd: realisedPnl, makerFeeUsd: makerFee, takerFeeUsd: takerFee, hedgeStatus: 'done', hedgeOrderId: hedgeRes.id } })
  } catch {
    updateFillHedge(fillId, null, 'failed')
    fillTrace.update({ output: { fillId, side, orderPrice, hedgePrice, hedgeSide, isPassiveHedge, realisedPnlUsd: realisedPnl, hedgeStatus: 'failed' } })
  }

  // If we had to go passive on the hedge, the market has moved against us
  // and carrying unhedged inventory here is a losing proposition. Close the
  // position and blacklist the market for a cooldown so realloc won't re-enter.
  if (isPassiveHedge) {
    const blMs = (engine.config?.blacklistMinutes ?? 60) * 60_000
    const bl = Date.now() + blMs
    engine.blacklist.set(pos.conditionId, bl)
    engine.fillHistory.delete(pos.conditionId)
    engine.marketPnlHistory.delete(pos.conditionId)
    engine.inventoryBias.delete(pos.conditionId)
    void closePosition(engine, pos.conditionId)

    const slipTxt = tripAbs && !tripPct
      ? `$${fillTimeSlipAbs.toFixed(3)} abs`
      : `${(fillTimeSlip * 100).toFixed(1)}%`
    notifyTelegram(`⚠️ Unhedged fill: ${slipTxt} slippage on ${side}\n${pos.question}\nOpposite side cancelled. Blacklisted ${engine.config?.blacklistMinutes ?? 60}m.`)
    fillTrace.update({ output: { fillId, side, isPassiveHedge: true, slippage: slipTxt, breaker: 'passive-hedge-blacklist', realisedPnlUsd: realisedPnl } })
    return
  }

  const cfg = engine.config ?? ({} as StrategyConfig)
  const condId = pos.conditionId
  const now = Date.now()

  // Breaker 1: adverse selection — same-side fill density over a rolling window.
  const adverse = checkAdverseSelection(engine.fillHistory, condId, side, now, cfg)
  if (adverse) {
    console.log(`[engine] adverse-selection on ${condId.slice(0, 8)} — ${adverse.sameSideFills}× ${side} fills in ${adverse.windowMinutes}m, closing + blacklisting ${adverse.blacklistMinutes}m`)
    engine.blacklist.set(condId, adverse.blacklistUntil)
    engine.fillHistory.delete(condId)
    engine.inventoryBias.delete(condId)
    void closePosition(engine, condId)
    notifyTelegram(`🚨 Adverse selection: ${adverse.sameSideFills}× ${side} fills in ${adverse.windowMinutes}m\n${pos.question}\nPosition closed. Blacklisted ${adverse.blacklistMinutes}m.`)
    fillTrace.update({ output: { fillId, side, breaker: 'adverse-selection', sameSideFills: adverse.sameSideFills, windowMinutes: adverse.windowMinutes, blacklistMinutes: adverse.blacklistMinutes, realisedPnlUsd: realisedPnl } })
  }

  // Breaker 2: per-market rolling drawdown.
  const market = checkMarketDrawdown(engine.marketPnlHistory, engine.blacklist, condId, realisedPnl, now, cfg)
  if (market) {
    console.log(`[engine] 🛑 market drawdown on ${condId.slice(0, 8)} — $${market.windowPnl.toFixed(2)} in ${market.windowHours}h ≤ −$${market.lossLimitUsd}, closing + blacklisting ${market.blacklistMinutes}m`)
    engine.blacklist.set(condId, market.blacklistUntil)
    engine.marketPnlHistory.delete(condId)
    engine.inventoryBias.delete(condId)
    void closePosition(engine, condId)
    notifyTelegram(`🛑 Market drawdown: $${market.windowPnl.toFixed(2)} in ${market.windowHours}h ≤ −$${market.lossLimitUsd}\n${pos.question}\nPosition closed. Blacklisted ${market.blacklistMinutes}m.`)
    fillTrace.update({ output: { fillId, side, breaker: 'market-drawdown', windowPnl: market.windowPnl, windowHours: market.windowHours, lossLimitUsd: market.lossLimitUsd, realisedPnlUsd: realisedPnl } })
  }

  // Breaker 3: portfolio-wide drawdown — pauses the whole engine on hit.
  const portfolio = checkPortfolioDrawdown(engine.portfolioPnlHistory, engine.globalPauseUntil, realisedPnl, now, cfg)
  engine.portfolioPnlHistory = portfolio.history
  if (portfolio.hit) {
    const h = portfolio.hit
    engine.globalPauseUntil = h.globalPauseUntil
    console.log(`[engine] 🛑🛑 PORTFOLIO DRAWDOWN — $${h.windowPnl.toFixed(2)} in ${h.windowHours}h ≤ −$${h.lossLimitUsd}, closing all positions + pausing ${h.pauseMinutes}m`)
    engine.portfolioPnlHistory = []
    for (const heldId of [...engine.positions.keys()]) void closePosition(engine, heldId)
    notifyTelegram(`🛑🛑 PORTFOLIO DRAWDOWN: $${h.windowPnl.toFixed(2)} in ${h.windowHours}h ≤ −$${h.lossLimitUsd}\nAll positions closed. Engine paused ${h.pauseMinutes}m.`)
    fillTrace.update({ output: { fillId, side, breaker: 'portfolio-drawdown', windowPnl: h.windowPnl, windowHours: h.windowHours, lossLimitUsd: h.lossLimitUsd, pauseMinutes: h.pauseMinutes, realisedPnlUsd: realisedPnl } })
  }
}
