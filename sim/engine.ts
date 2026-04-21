// Backend paper-trading engine.
//
// Mirrors src/services/paperTrading.ts but runs as a standalone Node process
// so the simulation keeps running when no browser is open.
//
// Lifecycle:
//   1. start(config) — fetch markets, run the allocator, post phantom orders
//      via PaperBroker, open a WS stream for every token we hold.
//   2. WS book updates feed evaluateBook(). If a phantom order's price is
//      crossed by the new top-of-book we mark it filled and market-hedge back
//      to flat.
//   3. Every REWARD_TICK_MS we integrate reward accrual from each position's
//      instantaneous score share.
//   4. Every REALLOC_MS we fetch fresh markets, rebuild allocations, and
//      cancel/replace positions that no longer make the cut (or whose prices
//      have drifted materially).
//
// Everything persists to the existing polymarket.db via sim/db.ts. On restart
// we automatically resume if the last state was 'running'.
//
// Swapping to a live driver is a one-line change: pass a LiveBroker to the
// constructor instead of defaulting to PaperBroker. All fill detection, hedge,
// reward accrual, and re-alloc logic is broker-agnostic.

import { fetchBooks, fetchRewardMarkets, computeBookMetrics, type Market } from '../collector/api.ts'
import { USDC_POLYGON } from '../collector/config.ts'
import { PaperBroker, type Broker, type PlaceOrderRequest } from '../src/services/broker.ts'
import { runSimulation } from '../src/services/strategy.ts'
import type {
  BookSnapshot,
  MarketVolatility,
  RewardsRow,
  StrategyAllocation,
  StrategyConfig,
} from '../src/types.ts'
import { getMarketVolatility } from '../collector/db.ts'
import {
  cancelAllRestingOrders,
  clearAllPositions,
  clearFills,
  deletePosition,
  fullReset,
  insertFill,
  insertOrder,
  insertPositionRewardHourly,
  readEngineState,
  readPositions,
  readRecentFills,
  readRecentOrders,
  readReward,
  resetReward,
  updateFillHedge,
  updateOrderStatus,
  upsertPosition,
  upsertRewardHourly,
  writeEngineState,
  writeReward,
  type FillRow,
  type OrderRow,
  type PositionRow,
} from './db.ts'
import { startMarketStream, type BookView, type WsClient } from './wsClient.ts'

const REWARD_TICK_MS = 1_000
const REALLOC_MS = 5 * 60_000
const VOL_WINDOW_HOURS = 24

// ── Risk criteria ────────────────────────────────────────────────────────────
// C1: skip markets where best bid OR best ask is below this floor.
//     Prevents quoting on penny books where hedge slippage is always extreme.
const MIN_PRICE_FLOOR = 0.05

// C2a: max fraction of fill price we're willing to lose on the instant hedge.
//      At post time: if (fill_price − hedge_price) / fill_price > threshold, skip.
//      Also re-checked at fill time — if the book moved worse than this, we use
//      a passive limit hedge instead of crossing the spread.
const MAX_HEDGE_SLIPPAGE = 0.03

// C2b: the hedge side of the book must hold at least this multiple of our
//      order size in visible depth (top-10 levels). Guards against thin books
//      that pass C1 and C2a but have no real liquidity behind the top quote.
const MIN_HEDGE_DEPTH_RATIO = 5

// C5: minimum book activity — proxy for recent trading volume.
//     Each side needs at least this many price levels AND this many total shares.
//     Markets with 1–2 stale quotes have no real activity.
const MIN_BOOK_LEVELS = 3
const MIN_BOOK_DEPTH_SHARES = 100

// C6: volatility gate — skip markets whose daily price std-dev exceeds this
//     threshold. High-volatility markets resolve adversely faster than reward
//     accrues; the Iran nuclear deal (~0.10/day stddev) is the canonical example.
const MAX_DAILY_STDDEV = 0.04

// C7: binary-extreme exclusion.
//     Markets near certainty (mid > MAX_MID_PRICE) or near-zero (mid < MIN_MID_PRICE)
//     carry asymmetric resolution risk that overwhelms reward accrual.
const MIN_MID_PRICE = 0.05
const MAX_MID_PRICE = 0.95

// C4: mid-drift cancel — if the live best bid/ask drifts within this many ticks
//     of our posted price, cancel immediately rather than waiting for a fill or
//     the next realloc cycle. Prevents adverse fills when markets move toward us.
const DRIFT_CANCEL_TICKS = 1
const TICK = 0.01

// C4+: after a drift-cancel, wait this long before reposting on the same
//      market so the book has a chance to stabilise. Shorter than the realloc
//      cycle, long enough to avoid chasing a momentum move tick-by-tick.
const REPOSITION_DELAY_MS = 10_000

function dailyRateFor(market: Market): number {
  const rates = market.rewards?.rates
  if (!rates?.length) return 0
  const usdc = rates.find((r) => r.asset_address.toLowerCase() === USDC_POLYGON.toLowerCase())
  return (usdc ?? rates[0]).rewards_daily_rate
}

// Build RewardsRow[] straight from CLOB fetchers. The strategy allocator needs
// the same shape the frontend uses; we reconstruct it from the Node-side API.
async function fetchRewardsRows(): Promise<RewardsRow[]> {
  const markets = await fetchRewardMarkets()
  const eligible = markets.filter(
    (m) =>
      m.active && !m.closed && !m.archived && m.accepting_orders && m.enable_order_book &&
      m.rewards && (m.rewards.rates?.length ?? 0) > 0,
  )
  const tokenIds = eligible.flatMap((m) => m.tokens.map((t) => t.token_id))
  const books = await fetchBooks(tokenIds)

  return eligible.map((m) => {
    const maxSpreadDollars = m.rewards.max_spread / 100
    const bookSnapshots: BookSnapshot[] = m.tokens.map((t) => {
      const rawBook = books.get(t.token_id)
      const metrics = computeBookMetrics(rawBook, m.rewards.min_size, m.rewards.max_spread)
      const bids = rawBook?.bids
        .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
        .sort((a, b) => b.price - a.price) ?? []
      const asks = rawBook?.asks
        .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
        .sort((a, b) => a.price - b.price) ?? []
      let qualifyingBidDepthUsd = 0
      let qualifyingAskDepthUsd = 0
      if (metrics.mid !== null) {
        for (const l of bids) if (metrics.mid - l.price <= maxSpreadDollars) qualifyingBidDepthUsd += l.price * l.size
        for (const l of asks) if (l.price - metrics.mid <= maxSpreadDollars) qualifyingAskDepthUsd += l.price * l.size
      }
      return {
        tokenId: t.token_id,
        outcome: t.outcome,
        price: t.price,
        bestBid: metrics.bestBid,
        bestAsk: metrics.bestAsk,
        mid: metrics.mid,
        spread: metrics.spread,
        withinRewardSpread:
          metrics.spread === null ? null : metrics.spread <= 2 * maxSpreadDollars,
        qualifyingBidDepthUsd,
        qualifyingAskDepthUsd,
        bids,
        asks,
      }
    })
    const eligibleSides = bookSnapshots.filter((b) => b.withinRewardSpread === true).length
    return {
      conditionId: m.condition_id,
      slug: m.market_slug,
      question: m.question,
      icon: m.icon,
      endDateIso: m.end_date_iso,
      tags: m.tags ?? [],
      minOrderSize: m.minimum_order_size,
      minTickSize: m.minimum_tick_size,
      rewardMinSize: m.rewards.min_size,
      rewardMaxSpread: m.rewards.max_spread,
      dailyRate: dailyRateFor(m),
      books: bookSnapshots,
      eligibleSides,
    }
  })
}

function loadVolatility(): Record<string, MarketVolatility> {
  try {
    const raw = getMarketVolatility(VOL_WINDOW_HOURS, 400)
    const out: Record<string, MarketVolatility> = {}
    for (const [cid, r] of Object.entries(raw)) {
      out[cid] = {
        conditionId: r.conditionId,
        dailyStddevDollars: r.dailyStddevDollars,
        samples: r.samples,
        hoursCovered: r.hoursCovered,
      }
    }
    return out
  } catch {
    return {}
  }
}

function levelScore(d: number, sizeUsd: number, maxSpreadDollars: number): number {
  if (d < 0 || d > maxSpreadDollars) return 0
  return (1 - d / maxSpreadDollars) * sizeUsd
}

function competingScore(
  levels: { price: number; size: number }[],
  mid: number,
  maxSpreadDollars: number,
  side: 'bid' | 'ask',
): number {
  let total = 0
  for (const lvl of levels) {
    const d = side === 'bid' ? mid - lvl.price : lvl.price - mid
    total += levelScore(d, lvl.price * lvl.size, maxSpreadDollars)
  }
  return total
}

interface InternalPosition {
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
  totalEarnedUsd: number
  earnedSinceLastSnapshot: number
  ourScore: number
  totalScore: number
  latestBook: BookView | null
}

type EngineState = 'idle' | 'running' | 'stopping'

export class BackendPaperEngine {
  private state: EngineState = 'idle'
  private startedAt: number | null = null
  private config: StrategyConfig | null = null
  private positions = new Map<string, InternalPosition>()
  // Adverse-selection detector state
  private fillHistory = new Map<string, Array<{ side: 'bid' | 'ask'; time: number }>>()
  private blacklist = new Map<string, number>() // conditionId → expiry timestamp (ms)
  // Per-market drawdown — rolling realised PnL per fill, keyed by conditionId
  private marketPnlHistory = new Map<string, Array<{ time: number; pnl: number }>>()
  private rewardTotal = 0
  private rewardLastRate = 0
  private rewardLastUpdatedAt = Date.now()
  private rewardTimer: NodeJS.Timeout | null = null
  private reallocTimer: NodeJS.Timeout | null = null
  private hourlySnapshotTimer: NodeJS.Timeout | null = null
  private ws: WsClient | null = null
  private readonly broker: Broker

  constructor(broker: Broker = new PaperBroker()) {
    this.broker = broker
    // Restore reward accrual from DB so the 'running' uptime survives restart.
    const reward = readReward()
    this.rewardTotal = reward.totalEarnedUsd
    this.rewardLastRate = reward.lastRatePerDay
    this.rewardLastUpdatedAt = reward.lastUpdatedAt
  }

  /** Auto-resume if the DB says we were running when the process died. */
  async resumeIfNeeded(): Promise<void> {
    const s = readEngineState()
    if (s.state !== 'running' || !s.configJson) return
    try {
      const config = JSON.parse(s.configJson) as StrategyConfig
      console.log('[engine] resuming previous run from DB…')
      // Cancel any leftover resting orders from the crashed run; we'll rebuild
      // fresh positions from the latest market state.
      cancelAllRestingOrders(Date.now())
      clearAllPositions()
      await this.start(config, { resumed: true, prevStartedAt: s.startedAt })
    } catch (err) {
      console.error('[engine] resume failed, staying idle:', err)
      writeEngineState({ state: 'idle', startedAt: null, configJson: null, lastAllocAt: null })
    }
  }

  async start(config: StrategyConfig, opts: { resumed?: boolean; prevStartedAt?: number | null } = {}): Promise<void> {
    if (this.state === 'running') return
    this.state = 'running'
    this.startedAt = opts.resumed && opts.prevStartedAt ? opts.prevStartedAt : Date.now()
    this.config = config
    this.marketPnlHistory.clear()

    writeEngineState({
      state: 'running',
      startedAt: this.startedAt,
      configJson: JSON.stringify(config),
      lastAllocAt: Date.now(),
    })

    await this.reallocate()
    this.scheduleRewardTick()
    this.scheduleRealloc()
    this.scheduleHourlySnapshot()
    console.log(`[engine] started — ${this.positions.size} positions, uptime anchor ${new Date(this.startedAt).toISOString()}`)
  }

  async stop(): Promise<void> {
    if (this.state !== 'running') return
    this.state = 'stopping'

    if (this.rewardTimer) { clearInterval(this.rewardTimer); this.rewardTimer = null }
    if (this.reallocTimer) { clearInterval(this.reallocTimer); this.reallocTimer = null }
    if (this.hourlySnapshotTimer) { clearInterval(this.hourlySnapshotTimer); this.hourlySnapshotTimer = null }
    if (this.ws) { this.ws.stop(); this.ws = null }

    const now = Date.now()
    const orders = readRecentOrders(2000)
    const resting = orders.filter((o) => o.status === 'resting')
    await Promise.all(resting.map((o) => this.broker.cancelOrder(o.id)))
    cancelAllRestingOrders(now)
    clearAllPositions()
    this.positions.clear()

    this.state = 'idle'
    this.startedAt = null
    writeEngineState({ state: 'idle', startedAt: null, configJson: null, lastAllocAt: null })
    console.log('[engine] stopped')
  }

  resetHistory(): void {
    if (this.state === 'running') throw new Error('stop the engine before resetting history')
    const now = Date.now()
    fullReset(now)
    this.rewardTotal = 0
    this.rewardLastRate = 0
    this.rewardLastUpdatedAt = now
  }

  /** Pull the current engine snapshot straight from SQLite — what the HTTP
   *  server hands to the frontend. Reads are fast thanks to WAL mode. */
  snapshot() {
    const s = readEngineState()
    const reward = readReward()
    return {
      state: s.state,
      startedAt: s.startedAt,
      brokerKind: this.broker.kind,
      config: s.configJson ? JSON.parse(s.configJson) : null,
      orders: readRecentOrders(500),
      fills: readRecentFills(200),
      reward,
      positions: readPositions(),
      lastAllocAt: s.lastAllocAt,
    }
  }

  // ── Reallocation ────────────────────────────────────────────────────
  // Every REALLOC_MS we refresh the market universe, rerun the allocator,
  // and reconcile positions:
  //   – new allocation, no existing position → open one
  //   – existing position, dropped from allocations → cancel + close
  //   – existing position, still allocated but price drifted > 1 tick → replace
  private async reallocate(): Promise<void> {
    if (this.state !== 'running' || !this.config) return
    console.log('[engine] reallocating…')
    let rows: RewardsRow[]
    try {
      rows = await fetchRewardsRows()
    } catch (err) {
      console.error('[engine] fetch failed during realloc, keeping existing positions:', err)
      return
    }
    const vol = loadVolatility()
    const sim = runSimulation(rows, this.config, vol)
    const byCondition = new Map(sim.allocations.map((a) => [a.conditionId, a]))
    const rowsById = new Map(rows.map((r) => [r.conditionId, r]))
    console.log(`  allocations: ${sim.allocations.length} markets, deployed=$${sim.deployedCapital.toFixed(0)}, gross=$${sim.grossDailyUsd.toFixed(2)}/day`)

    // 1. Close positions no longer in the allocation set.
    for (const conditionId of [...this.positions.keys()]) {
      if (!byCondition.has(conditionId)) {
        await this.closePosition(conditionId)
      }
    }

    // 2. Open or refresh positions for each allocation.
    for (const alloc of sim.allocations) {
      const row = rowsById.get(alloc.conditionId)
      if (!row) continue
      const existing = this.positions.get(alloc.conditionId)
      if (!existing) {
        await this.openPosition(alloc, row, vol)
      } else if (Math.abs(existing.bidPrice - (alloc.bidPrice ?? existing.bidPrice)) >= 0.01 ||
                 Math.abs(existing.askPrice - (alloc.askPrice ?? existing.askPrice)) >= 0.01) {
        await this.closePosition(alloc.conditionId)
        await this.openPosition(alloc, row, vol)
      }
    }

    // 3. Refresh WS subscription to the current token set.
    this.restartWs()
    writeEngineState({
      state: 'running',
      startedAt: this.startedAt,
      configJson: JSON.stringify(this.config),
      lastAllocAt: Date.now(),
    })
  }

  private async openPosition(alloc: StrategyAllocation, row: RewardsRow, vol: Record<string, MarketVolatility>): Promise<void> {
    if (alloc.bidPrice === null || alloc.askPrice === null) return
    const yesBook = row.books[0]
    if (!yesBook) return
    const config = this.config!

    const bestBid = yesBook.bestBid ?? 0
    const bestAsk = yesBook.bestAsk ?? 1
    const tag = alloc.conditionId.slice(0, 8)

    // Adverse-selection blacklist: skip markets closed out for repeated bad fills
    const blacklistExpiry = this.blacklist.get(alloc.conditionId)
    if (blacklistExpiry !== undefined) {
      if (Date.now() < blacklistExpiry) {
        console.log(`[engine] skip ${tag} — adverse-selection blacklist (expires ${new Date(blacklistExpiry).toISOString()})`)
        return
      }
      this.blacklist.delete(alloc.conditionId)
    }

    // C1: price floor — skip penny/near-zero books
    if (bestBid < MIN_PRICE_FLOOR || bestAsk < MIN_PRICE_FLOOR) {
      console.log(`[engine] skip ${tag} — C1 price floor (bid=${bestBid.toFixed(3)} ask=${bestAsk.toFixed(3)})`)
      return
    }

    const halfCapital = config.perMarketCapitalUsd / 2
    const bidSize = Math.max(row.rewardMinSize, halfCapital / Math.max(alloc.bidPrice, 0.01))
    const askSize = Math.max(row.rewardMinSize, halfCapital / Math.max(alloc.askPrice, 0.01))

    // C2a: simulated hedge slippage at post time.
    //   bid fills → hedge by selling at bestBid. Loss = bidPrice − bestBid.
    //   ask fills → hedge by buying  at bestAsk. Loss = bestAsk − askPrice.
    const bidHedgeSlip = alloc.bidPrice > 0 ? (alloc.bidPrice - bestBid) / alloc.bidPrice : 1
    const askHedgeSlip = alloc.askPrice > 0 ? (bestAsk - alloc.askPrice) / alloc.askPrice : 1
    if (bidHedgeSlip > MAX_HEDGE_SLIPPAGE || askHedgeSlip > MAX_HEDGE_SLIPPAGE) {
      console.log(`[engine] skip ${tag} — C2a hedge slippage (bid=${(bidHedgeSlip * 100).toFixed(1)}% ask=${(askHedgeSlip * 100).toFixed(1)}% > ${MAX_HEDGE_SLIPPAGE * 100}%)`)
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
      this.broker.placeOrder(bidReq),
      this.broker.placeOrder(askReq),
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
      totalEarnedUsd: 0,
      earnedSinceLastSnapshot: 0,
      ourScore: 0,
      totalScore: 0,
      latestBook: null,
    }
    this.positions.set(alloc.conditionId, pos)
    upsertPosition(this.toRow(pos, now))
  }

  private async closePosition(conditionId: string): Promise<void> {
    const pos = this.positions.get(conditionId)
    if (!pos) return
    const now = Date.now()
    const toCancel = [pos.bidOrderId, pos.askOrderId].filter((x): x is string => !!x)
    await Promise.all(toCancel.map((id) => this.broker.cancelOrder(id)))
    for (const id of toCancel) updateOrderStatus(id, 'cancelled', now)
    this.positions.delete(conditionId)
    deletePosition(conditionId)
  }

  /** C4 extension: after a drift-cancel, try to repost on just this market
   *  rather than waiting for the next full realloc cycle. Called on a
   *  REPOSITION_DELAY_MS timer so the book has time to stabilise. Silently
   *  no-ops if the engine stopped, a realloc already repositioned, or the
   *  market no longer passes the risk criteria. */
  private async repositionMarket(conditionId: string): Promise<void> {
    if (this.state !== 'running' || !this.config) return
    if (this.positions.has(conditionId)) return

    const tag = conditionId.slice(0, 8)
    let rows: RewardsRow[]
    try {
      rows = await fetchRewardsRows()
    } catch (err) {
      console.error(`[engine] reposition ${tag} — fetch failed:`, err)
      return
    }

    const vol = loadVolatility()
    const sim = runSimulation(rows, this.config, vol)
    const alloc = sim.allocations.find((a) => a.conditionId === conditionId)
    const row = rows.find((r) => r.conditionId === conditionId)
    if (!alloc || !row) {
      console.log(`[engine] reposition ${tag} — dropped by allocator, skip`)
      return
    }

    if (this.state !== 'running' || this.positions.has(conditionId)) return

    console.log(`[engine] reposition ${tag} — post-drift repost (10s stabilised)`)
    await this.openPosition(alloc, row, vol)
  }

  private restartWs(): void {
    if (this.ws) { this.ws.stop(); this.ws = null }
    const tokenIds = [...this.positions.values()].map((p) => p.tokenId)
    if (tokenIds.length === 0) return
    this.ws = startMarketStream(tokenIds, {
      onBook: (tokenId, view) => this.evaluateBook(tokenId, view),
      onStatus: (state, info) => {
        if (state === 'open') console.log(`[engine] ws open — streaming ${info.streamed} tokens`)
      },
    })
  }

  private evaluateBook(tokenId: string, view: BookView): void {
    if (this.state !== 'running') return
    let pos: InternalPosition | undefined
    for (const p of this.positions.values()) {
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
      const side = bidDrift ? 'bid' : 'ask'
      console.log(`[engine] C4 drift-cancel ${tag} — bestBid=${view.bestBid?.toFixed(3)} ourBid=${pos.bidPrice.toFixed(3)} bestAsk=${view.bestAsk?.toFixed(3)} ourAsk=${pos.askPrice.toFixed(3)}`)
      const tgToken = process.env.TELEGRAM_BOT_TOKEN
      const tgChat = process.env.TELEGRAM_CHAT_ID
      if (tgToken && tgChat) {
        const msg = `⚡ C4 drift-cancel (${side})\n${pos.question}\nbid=${view.bestBid?.toFixed(3)} ourBid=${pos.bidPrice.toFixed(3)} ask=${view.bestAsk?.toFixed(3)} ourAsk=${pos.askPrice.toFixed(3)}`
        void fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tgChat, text: msg }),
        }).catch(() => {})
      }
      this.positions.delete(pos.conditionId)
      const toCancel = [pos.bidOrderId, pos.askOrderId].filter((x): x is string => !!x)
      const now = Date.now()
      const cidToRepost = pos.conditionId
      void Promise.all(toCancel.map((id) => this.broker.cancelOrder(id))).then(() => {
        for (const id of toCancel) updateOrderStatus(id, 'cancelled', now)
        deletePosition(cidToRepost)
        setTimeout(() => { void this.repositionMarket(cidToRepost) }, REPOSITION_DELAY_MS)
      })
      return
    }

    if (pos.bidOrderId && view.bestBid !== null && view.bestBid <= pos.bidPrice) {
      void this.handleFill(pos, 'bid', view)
    }
    if (pos.askOrderId && view.bestAsk !== null && view.bestAsk >= pos.askPrice) {
      void this.handleFill(pos, 'ask', view)
    }
  }

  private async handleFill(pos: InternalPosition, side: 'bid' | 'ask', view: BookView): Promise<void> {
    const orderId = side === 'bid' ? pos.bidOrderId : pos.askOrderId
    if (!orderId) return
    const config = this.config ?? ({ makerFeePct: 0, takerFeePct: 0 } as StrategyConfig)

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
    const hedgePrice = fillTimeSlip > MAX_HEDGE_SLIPPAGE
      ? orderPrice  // passive limit at fill price — zero slippage, waits for a cross
      : rawHedgePrice
    const hedgeSide = side === 'bid' ? 'sell' : 'buy'
    if (fillTimeSlip > MAX_HEDGE_SLIPPAGE) {
      console.log(`[engine] fill-time slippage ${(fillTimeSlip * 100).toFixed(1)}% > ${(MAX_HEDGE_SLIPPAGE * 100).toFixed(0)}% on ${pos.conditionId.slice(0, 8)} — passive hedge at ${orderPrice}`)
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
    upsertPosition(this.toRow(pos, Date.now()))

    try {
      const hedgeRes = await this.broker.marketHedge({
        conditionId: pos.conditionId,
        tokenId: pos.tokenId,
        side: hedgeSide,
        size: orderSize,
        expectedPrice: orderPrice,
        fillPrice: hedgePrice,
      })
      updateFillHedge(fillId, hedgeRes.id, 'done')
    } catch {
      updateFillHedge(fillId, null, 'failed')
    }

    // Adverse-selection detector: track same-side fills in a rolling window.
    // Too many fills on the same side = a smarter participant has an information
    // edge; cut the position and blacklist the market to stop re-entry.
    const cfg = this.config ?? ({} as StrategyConfig)
    const maxFills = cfg.maxFillsPerWindow ?? 3
    const windowMs = (cfg.fillWindowMinutes ?? 15) * 60_000
    const blacklistMs = (cfg.blacklistMinutes ?? 60) * 60_000
    const condId = pos.conditionId

    if (!this.fillHistory.has(condId)) this.fillHistory.set(condId, [])
    const hist = this.fillHistory.get(condId)!
    const now = Date.now()
    hist.push({ side, time: now })
    // Prune stale entries and keep only same-side fills in the window
    const pruned = hist.filter((e) => e.time >= now - windowMs)
    this.fillHistory.set(condId, pruned)
    const sameSideFills = pruned.filter((e) => e.side === side).length

    if (sameSideFills >= maxFills) {
      console.log(`[engine] adverse-selection on ${condId.slice(0, 8)} — ${sameSideFills}× ${side} fills in ${cfg.fillWindowMinutes ?? 15}m, closing + blacklisting ${cfg.blacklistMinutes ?? 60}m`)
      this.blacklist.set(condId, now + blacklistMs)
      this.fillHistory.delete(condId)
      void this.closePosition(condId)

      const tgToken = process.env.TELEGRAM_BOT_TOKEN
      const tgChat = process.env.TELEGRAM_CHAT_ID
      if (tgToken && tgChat) {
        const msg = `🚨 Adverse selection: ${sameSideFills}× ${side} fills in ${cfg.fillWindowMinutes ?? 15}m\n${pos.question}\nPosition closed. Blacklisted ${cfg.blacklistMinutes ?? 60}m.`
        void fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tgChat, text: msg }),
        }).catch(() => {})
      }
    }

    // Per-market drawdown blacklist. Track each fill's realised PnL keyed by
    // market; if rolling-window losses on a single market breach the limit,
    // close + blacklist that market only — the rest of the engine keeps running.
    const marketLossLimit = cfg.marketLossLimitUsd ?? 5
    const marketLossWindowMs = (cfg.marketLossWindowHours ?? 24) * 60 * 60_000
    if (marketLossLimit > 0 && !this.blacklist.has(condId)) {
      const mhist = this.marketPnlHistory.get(condId) ?? []
      mhist.push({ time: now, pnl: realisedPnl })
      const prunedPnl = mhist.filter((e) => e.time >= now - marketLossWindowMs)
      this.marketPnlHistory.set(condId, prunedPnl)
      const marketWindowPnl = prunedPnl.reduce((s, e) => s + e.pnl, 0)
      if (marketWindowPnl <= -marketLossLimit) {
        const windowH = cfg.marketLossWindowHours ?? 24
        console.log(`[engine] 🛑 market drawdown on ${condId.slice(0, 8)} — $${marketWindowPnl.toFixed(2)} in ${windowH}h ≤ −$${marketLossLimit}, closing + blacklisting ${cfg.blacklistMinutes ?? 60}m`)
        this.blacklist.set(condId, now + blacklistMs)
        this.marketPnlHistory.delete(condId)
        void this.closePosition(condId)

        const tgToken = process.env.TELEGRAM_BOT_TOKEN
        const tgChat = process.env.TELEGRAM_CHAT_ID
        if (tgToken && tgChat) {
          const msg = `🛑 Market drawdown: $${marketWindowPnl.toFixed(2)} in ${windowH}h ≤ −$${marketLossLimit}\n${pos.question}\nPosition closed. Blacklisted ${cfg.blacklistMinutes ?? 60}m.`
          void fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: tgChat, text: msg }),
          }).catch(() => {})
        }
      }
    }
  }

  private scheduleRewardTick(): void {
    if (this.rewardTimer) clearInterval(this.rewardTimer)
    this.rewardTimer = setInterval(() => this.accrueRewards(), REWARD_TICK_MS)
  }

  private scheduleRealloc(): void {
    if (this.reallocTimer) clearInterval(this.reallocTimer)
    this.reallocTimer = setInterval(() => { void this.reallocate() }, REALLOC_MS)
  }

  private scheduleHourlySnapshot(): void {
    if (this.hourlySnapshotTimer) clearInterval(this.hourlySnapshotTimer)
    // Fire once per hour, aligned to the top of the hour.
    const msUntilNextHour = 3_600_000 - (Date.now() % 3_600_000)
    setTimeout(() => {
      this.takeHourlySnapshot()
      this.hourlySnapshotTimer = setInterval(() => this.takeHourlySnapshot(), 3_600_000)
    }, msUntilNextHour)
  }

  private takeHourlySnapshot(): void {
    if (this.state !== 'running') return
    const now = Date.now()
    const hourEpoch = Math.floor(now / 3_600_000) * 3_600_000

    upsertRewardHourly({
      hourEpoch,
      snapshotAt: now,
      totalEarnedUsd: this.rewardTotal,
      ratePerDay: this.rewardLastRate,
    })

    const posRows = Array.from(this.positions.values()).map((pos) => ({
      hourEpoch,
      snapshotAt: now,
      conditionId: pos.conditionId,
      question: pos.question,
      rewardSharePct: pos.rewardSharePct,
      expectedRatePerDay: pos.expectedRatePerDay,
      earnedThisHourUsd: pos.earnedSinceLastSnapshot,
    }))
    if (posRows.length > 0) insertPositionRewardHourly(posRows)

    // Reset per-position incremental counter after snapshot.
    for (const pos of this.positions.values()) pos.earnedSinceLastSnapshot = 0

    console.log(`[engine] hourly snapshot — total earned $${this.rewardTotal.toFixed(4)}, ${posRows.length} positions`)
  }

  private accrueRewards(): void {
    if (this.state !== 'running') return
    // Recompute scores inline so the reward rate we persist is fresh.
    let totalRate = 0
    const now = Date.now()
    const elapsedDays = (now - this.rewardLastUpdatedAt) / (24 * 60 * 60 * 1000)

    for (const pos of this.positions.values()) {
      const view = pos.latestBook
      if (!view || view.mid === null || !this.config) continue
      const mid = view.mid
      const ourBidScore = levelScore(mid - pos.bidPrice, pos.bidPrice * pos.bidSize, pos.maxSpreadDollars)
      const ourAskScore = levelScore(pos.askPrice - mid, pos.askPrice * pos.askSize, pos.maxSpreadDollars)
      const compBid = competingScore(view.bids, mid, pos.maxSpreadDollars, 'bid')
      const compAsk = competingScore(view.asks, mid, pos.maxSpreadDollars, 'ask')
      const bidShare = ourBidScore > 0 ? ourBidScore / (ourBidScore + compBid) : 0
      const askShare = ourAskScore > 0 ? ourAskScore / (ourAskScore + compAsk) : 0
      pos.ourScore = ourBidScore + ourAskScore
      pos.totalScore = pos.ourScore + compBid + compAsk
      pos.rewardSharePct = ((bidShare + askShare) / 2) * 100
      pos.expectedRatePerDay = (pos.dailyPool / 2) * bidShare + (pos.dailyPool / 2) * askShare
      totalRate += pos.expectedRatePerDay

      // Accumulate per-position incremental earned (for hourly snapshot).
      const posIncrement = pos.expectedRatePerDay * elapsedDays
      pos.totalEarnedUsd = (pos.totalEarnedUsd ?? 0) + posIncrement
      pos.earnedSinceLastSnapshot = (pos.earnedSinceLastSnapshot ?? 0) + posIncrement

      upsertPosition(this.toRow(pos, now))
    }

    this.rewardTotal += this.rewardLastRate * elapsedDays
    this.rewardLastRate = totalRate
    this.rewardLastUpdatedAt = now
    writeReward({ totalEarnedUsd: this.rewardTotal, lastRatePerDay: this.rewardLastRate, lastUpdatedAt: now })
  }

  private toRow(pos: InternalPosition, now: number): PositionRow {
    return {
      conditionId: pos.conditionId,
      question: pos.question,
      tokenId: pos.tokenId,
      outcome: pos.outcome,
      bidOrderId: pos.bidOrderId,
      askOrderId: pos.askOrderId,
      bidPrice: pos.bidPrice,
      askPrice: pos.askPrice,
      bidSize: pos.bidSize,
      askSize: pos.askSize,
      maxSpreadDollars: pos.maxSpreadDollars,
      dailyPool: pos.dailyPool,
      midPrice: pos.midPrice,
      bestBid: pos.bestBid,
      bestAsk: pos.bestAsk,
      rewardSharePct: pos.rewardSharePct,
      expectedRatePerDay: pos.expectedRatePerDay,
      updatedAt: now,
    }
  }
}
