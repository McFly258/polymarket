// Allocation & position reconciliation.
//
// Split from engine.ts for file size / readability. Operates on the
// BackendPaperEngine's public state fields; the engine is the owner of all
// state — these are just the allocation algorithms living in their own module.

import type { PlaceOrderRequest } from '../src/services/broker.ts'
import { runSimulation, daysUntil } from '../src/services/strategy.ts'
import type {
  MarketVolatility,
  RewardsRow,
  StrategyAllocation,
} from '../src/types.ts'
import {
  deletePosition,
  insertOrder,
  updateOrderStatus,
  upsertPosition,
  writeEngineState,
  type OrderRow,
} from './db.ts'
import {
  MIN_PRICE_FLOOR,
  MAX_HEDGE_SLIPPAGE,
  MAX_HEDGE_SLIPPAGE_ABS,
  MIN_HEDGE_DEPTH_RATIO,
  MIN_BOOK_LEVELS,
  MIN_BOOK_DEPTH_SHARES,
  MAX_DAILY_STDDEV,
  MIN_MID_PRICE,
  MAX_MID_PRICE,
  INVENTORY_SKEW_WIDE_TICKS,
  INVENTORY_SKEW_TIGHT_TICKS,
  TICK,
} from './engineConstants.ts'
import { fetchRewardsRows, loadVolatility } from './engineData.ts'
import { notifyTelegram } from './engineNotify.ts'
import type { InternalPosition } from './engineTypes.ts'
import type { BackendPaperEngine } from './engine.ts'

export async function reallocate(engine: BackendPaperEngine): Promise<void> {
  if (engine.state !== 'running' || !engine.config) return
  if (Date.now() < engine.globalPauseUntil) {
    console.log(`[engine] reallocate skipped — global pause active until ${new Date(engine.globalPauseUntil).toISOString()}`)
    return
  }
  console.log('[engine] reallocating…')
  let rows: RewardsRow[]
  try {
    rows = await fetchRewardsRows()
  } catch (err) {
    console.error('[engine] fetch failed during realloc, keeping existing positions:', err)
    return
  }
  const vol = loadVolatility()
  const sim = runSimulation(rows, engine.config, vol)
  const byCondition = new Map(sim.allocations.map((a) => [a.conditionId, a]))
  const rowsById = new Map(rows.map((r) => [r.conditionId, r]))
  console.log(`  allocations: ${sim.allocations.length} markets, deployed=$${sim.deployedCapital.toFixed(0)}, gross=$${sim.grossDailyUsd.toFixed(2)}/day`)

  // 0. Resolution wind-down. Close any held position whose market has drifted
  //    into the danger window (< closePositionDaysToResolution). Adverse
  //    selection spikes near resolution as counterparties with resolution info
  //    pick off our quotes; entry is gated by minDaysToResolution but once in,
  //    the market's TTR decays — this sweep protects us on the way out.
  const closeDays = engine.config.closePositionDaysToResolution ?? 2
  if (closeDays > 0) {
    const nowMs = Date.now()
    const blacklistMs = (engine.config.blacklistMinutes ?? 60) * 60_000
    for (const conditionId of [...engine.positions.keys()]) {
      const row = rowsById.get(conditionId)
      if (!row) continue
      const days = daysUntil(row.endDateIso, nowMs)
      if (days !== null && days < closeDays) {
        const pos = engine.positions.get(conditionId)
        console.log(`[engine] wind-down on ${conditionId.slice(0, 8)} — ${days.toFixed(2)}d to resolution < ${closeDays}d, closing + blacklisting ${engine.config.blacklistMinutes ?? 60}m`)
        engine.blacklist.set(conditionId, nowMs + blacklistMs)
        await closePosition(engine, conditionId)
        if (pos) {
          notifyTelegram(`⏳ Wind-down: ${days.toFixed(2)}d to resolution < ${closeDays}d\n${pos.question}\nPosition closed. Blacklisted ${engine.config.blacklistMinutes ?? 60}m.`)
        }
      }
    }
  }

  // 1. Close positions no longer in the allocation set.
  for (const conditionId of [...engine.positions.keys()]) {
    if (!byCondition.has(conditionId)) {
      await closePosition(engine, conditionId)
    }
  }

  // 2. Open or refresh positions for each allocation.
  for (const alloc of sim.allocations) {
    const row = rowsById.get(alloc.conditionId)
    if (!row) continue
    const existing = engine.positions.get(alloc.conditionId)
    // Apply inventory skew: if we had a recent fill on this market, shift quotes
    // away from the filled side to reduce same-side re-fill risk.
    let effectiveAlloc = alloc
    const biasMeta = engine.inventoryBias.get(alloc.conditionId)
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
      const tag = alloc.conditionId.slice(0, 8)
      console.log(`[engine] inventory skew ${tag} — bias=${biasMeta.bias} bid=${alloc.bidPrice.toFixed(3)}→${effectiveAlloc.bidPrice?.toFixed(3)} ask=${alloc.askPrice.toFixed(3)}→${effectiveAlloc.askPrice?.toFixed(3)}`)
    } else if (biasMeta && Date.now() >= biasMeta.until) {
      engine.inventoryBias.delete(alloc.conditionId)
    }

    if (!existing) {
      await openPosition(engine, effectiveAlloc, row, vol)
    } else if (Math.abs(existing.bidPrice - (effectiveAlloc.bidPrice ?? existing.bidPrice)) >= 0.01 ||
               Math.abs(existing.askPrice - (effectiveAlloc.askPrice ?? existing.askPrice)) >= 0.01 ||
               Math.abs(existing.capitalUsd - effectiveAlloc.capitalUsd) >= 1) {
      await closePosition(engine, effectiveAlloc.conditionId)
      await openPosition(engine, effectiveAlloc, row, vol)
    }
  }

  // 3. Refresh WS subscription to the current token set.
  engine.restartWs()
  writeEngineState({
    state: 'running',
    startedAt: engine.startedAt,
    configJson: JSON.stringify(engine.config),
    lastAllocAt: Date.now(),
  })
}

export async function openPosition(
  engine: BackendPaperEngine,
  alloc: StrategyAllocation,
  row: RewardsRow,
  vol: Record<string, MarketVolatility>,
): Promise<void> {
  if (alloc.bidPrice === null || alloc.askPrice === null) return
  const yesBook = row.books[0]
  if (!yesBook) return

  const bestBid = yesBook.bestBid ?? 0
  const bestAsk = yesBook.bestAsk ?? 1
  const tag = alloc.conditionId.slice(0, 8)

  // Adverse-selection blacklist: skip markets closed out for repeated bad fills
  const blacklistExpiry = engine.blacklist.get(alloc.conditionId)
  if (blacklistExpiry !== undefined) {
    if (Date.now() < blacklistExpiry) {
      console.log(`[engine] skip ${tag} — adverse-selection blacklist (expires ${new Date(blacklistExpiry).toISOString()})`)
      return
    }
    engine.blacklist.delete(alloc.conditionId)
  }

  // C1: price floor — skip penny/near-zero books
  if (bestBid < MIN_PRICE_FLOOR || bestAsk < MIN_PRICE_FLOOR) {
    console.log(`[engine] skip ${tag} — C1 price floor (bid=${bestBid.toFixed(3)} ask=${bestAsk.toFixed(3)})`)
    return
  }

  // Use per-side capital from allocation (asymmetric sizing when enabled, else half each).
  const bidCapital = alloc.bidCapitalUsd ?? alloc.capitalUsd / 2
  const askCapital = alloc.askCapitalUsd ?? alloc.capitalUsd / 2
  const bidSize = Math.max(row.rewardMinSize, bidCapital / Math.max(alloc.bidPrice, 0.01))
  const askSize = Math.max(row.rewardMinSize, askCapital / Math.max(alloc.askPrice, 0.01))

  // C2a: simulated hedge slippage at post time.
  //   bid fills → hedge by selling at bestBid. Loss = bidPrice − bestBid.
  //   ask fills → hedge by buying  at bestAsk. Loss = bestAsk − askPrice.
  // Trip on either the % cap (low-price markets) or the absolute cent cap
  // (high-price markets where 3% is 2¢+ of drift) — whichever is tighter.
  const bidHedgeSlip = alloc.bidPrice > 0 ? (alloc.bidPrice - bestBid) / alloc.bidPrice : 1
  const askHedgeSlip = alloc.askPrice > 0 ? (bestAsk - alloc.askPrice) / alloc.askPrice : 1
  const bidSlipAbs = Math.abs(alloc.bidPrice - bestBid)
  const askSlipAbs = Math.abs(bestAsk - alloc.askPrice)
  const bidTrip = bidHedgeSlip > MAX_HEDGE_SLIPPAGE || bidSlipAbs > MAX_HEDGE_SLIPPAGE_ABS
  const askTrip = askHedgeSlip > MAX_HEDGE_SLIPPAGE || askSlipAbs > MAX_HEDGE_SLIPPAGE_ABS
  if (bidTrip || askTrip) {
    console.log(`[engine] skip ${tag} — C2a hedge slippage (bid=${(bidHedgeSlip * 100).toFixed(1)}%/$${bidSlipAbs.toFixed(3)} ask=${(askHedgeSlip * 100).toFixed(1)}%/$${askSlipAbs.toFixed(3)} caps=${MAX_HEDGE_SLIPPAGE * 100}%/$${MAX_HEDGE_SLIPPAGE_ABS})`)
    return
  }

  // C2b: depth check — each side needs MIN_HEDGE_DEPTH_RATIO × our order size.
  //   bid order hedges by selling → need bid depth.
  //   ask order hedges by buying  → need ask depth.
  const bidDepth = yesBook.bids.slice(0, 10).reduce((s, l) => s + l.size, 0)
  const askDepth = yesBook.asks.slice(0, 10).reduce((s, l) => s + l.size, 0)
  if (bidDepth < MIN_HEDGE_DEPTH_RATIO * bidSize) {
    console.log(`[engine] skip ${tag} — C2b bid depth ${bidDepth.toFixed(0)} < ${(MIN_HEDGE_DEPTH_RATIO * bidSize).toFixed(0)}`)
    return
  }
  if (askDepth < MIN_HEDGE_DEPTH_RATIO * askSize) {
    console.log(`[engine] skip ${tag} — C2b ask depth ${askDepth.toFixed(0)} < ${(MIN_HEDGE_DEPTH_RATIO * askSize).toFixed(0)}`)
    return
  }

  // C5: book activity — require enough price levels and total depth as a
  //     proxy for recent trading volume. Ghost markets have 1–2 stale quotes.
  if (yesBook.bids.length < MIN_BOOK_LEVELS || yesBook.asks.length < MIN_BOOK_LEVELS) {
    console.log(`[engine] skip ${tag} — C5 book levels (bids=${yesBook.bids.length} asks=${yesBook.asks.length} min=${MIN_BOOK_LEVELS})`)
    return
  }
  const totalBidShares = yesBook.bids.reduce((s, l) => s + l.size, 0)
  const totalAskShares = yesBook.asks.reduce((s, l) => s + l.size, 0)
  if (totalBidShares < MIN_BOOK_DEPTH_SHARES || totalAskShares < MIN_BOOK_DEPTH_SHARES) {
    console.log(`[engine] skip ${tag} — C5 total depth (bids=${totalBidShares.toFixed(0)} asks=${totalAskShares.toFixed(0)} min=${MIN_BOOK_DEPTH_SHARES})`)
    return
  }

  // C6: volatility gate — skip if daily price stddev exceeds threshold.
  const marketVol = vol[alloc.conditionId]
  if (marketVol && marketVol.dailyStddevDollars > MAX_DAILY_STDDEV) {
    console.log(`[engine] skip ${tag} — C6 volatility (stddev=${marketVol.dailyStddevDollars.toFixed(4)} > ${MAX_DAILY_STDDEV})`)
    return
  }

  // C7: binary-extreme exclusion — near-certain or near-impossible markets
  //     have asymmetric resolution risk that reward accrual can't offset.
  const mid = yesBook.mid
  if (mid !== null && (mid < MIN_MID_PRICE || mid > MAX_MID_PRICE)) {
    console.log(`[engine] skip ${tag} — C7 binary extreme (mid=${mid.toFixed(3)})`)
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
    engine.broker.placeOrder(bidReq),
    engine.broker.placeOrder(askReq),
  ])
  const now = Date.now()

  const bidOrder: OrderRow = {
    id: bidRes.id, conditionId: alloc.conditionId, tokenId: yesBook.tokenId, outcome: yesBook.outcome,
    side: 'bid', price: alloc.bidPrice, size: bidSize, status: 'resting', postedAt: bidRes.acceptedAt,
    postedBestBid: yesBook.bestBid, postedBestAsk: yesBook.bestAsk, closedAt: null,
  }
  const askOrder: OrderRow = {
    id: askRes.id, conditionId: alloc.conditionId, tokenId: yesBook.tokenId, outcome: yesBook.outcome,
    side: 'ask', price: alloc.askPrice, size: askSize, status: 'resting', postedAt: askRes.acceptedAt,
    postedBestBid: yesBook.bestBid, postedBestAsk: yesBook.bestAsk, closedAt: null,
  }
  insertOrder(bidOrder)
  insertOrder(askOrder)

  const pos: InternalPosition = {
    conditionId: alloc.conditionId,
    question: alloc.question,
    tokenId: yesBook.tokenId,
    outcome: yesBook.outcome,
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
  engine.positions.set(alloc.conditionId, pos)
  upsertPosition(engine.toRow(pos, now))
}

export async function closePosition(engine: BackendPaperEngine, conditionId: string): Promise<void> {
  const pos = engine.positions.get(conditionId)
  if (!pos) return
  const now = Date.now()
  const toCancel = [pos.bidOrderId, pos.askOrderId].filter((x): x is string => !!x)
  await Promise.all(toCancel.map((id) => engine.broker.cancelOrder(id)))
  for (const id of toCancel) updateOrderStatus(id, 'cancelled', now)
  engine.positions.delete(conditionId)
  deletePosition(conditionId)
}

/** C4 extension: after a drift-cancel, try to repost on just this market
 *  rather than waiting for the next full realloc cycle. Called on a
 *  REPOSITION_DELAY_MS timer so the book has time to stabilise. Silently
 *  no-ops if the engine stopped, a realloc already repositioned, or the
 *  market no longer passes the risk criteria. */
export async function repositionMarket(engine: BackendPaperEngine, conditionId: string): Promise<void> {
  if (engine.state !== 'running' || !engine.config) return
  if (engine.positions.has(conditionId)) return

  const tag = conditionId.slice(0, 8)
  let rows: RewardsRow[]
  try {
    rows = await fetchRewardsRows()
  } catch (err) {
    console.error(`[engine] reposition ${tag} — fetch failed:`, err)
    return
  }

  const vol = loadVolatility()
  const sim = runSimulation(rows, engine.config, vol)
  const alloc = sim.allocations.find((a) => a.conditionId === conditionId)
  const row = rows.find((r) => r.conditionId === conditionId)
  if (!alloc || !row) {
    console.log(`[engine] reposition ${tag} — dropped by allocator, skip`)
    return
  }

  if (engine.state !== 'running' || engine.positions.has(conditionId)) return

  console.log(`[engine] reposition ${tag} — post-drift repost (10s stabilised)`)
  await openPosition(engine, alloc, row, vol)
}
