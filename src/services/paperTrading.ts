// Paper-trading engine.
//
// Lifecycle:
//   1. User picks an allocation set (output of runSimulation).
//   2. Engine asks the broker to "place" two phantom limit orders per market
//      (bid + ask) at the prices the strategy chose.
//   3. WS book updates feed evaluateBook(). When a phantom order's price is
//      crossed by the new top of book we mark it filled — same fill detection
//      a real maker would experience.
//   4. On fill we immediately ask the broker to market-hedge the inventory
//      back to flat (cross the new spread). Realised P&L = fill price − hedge
//      price ± fees.
//   5. While orders are resting we accrue rewards proportional to our share
//      of the qualifying score on each side, integrated over wall time.
//
// Swapping to live is a one-line change: pass a LiveBroker instead of
// PaperBroker. All the fill detection / hedging / reward accrual logic is
// shared; only the actual venue I/O differs.

import type { BookView } from '../api/polymarket'
import type {
  Broker,
  MarketHedgeResult,
  PlaceOrderRequest,
  PlaceOrderResult,
} from './broker'
import { PaperBroker } from './broker'
import type {
  RewardsRow,
  StrategyAllocation,
  StrategyConfig,
} from '../types'

const STORAGE_KEY = 'polymarket.paperTrading.v1'
const REWARD_TICK_MS = 1_000

export type EngineState = 'idle' | 'running' | 'stopping'

export interface PhantomOrder {
  id: string
  conditionId: string
  tokenId: string
  outcome: string
  side: 'bid' | 'ask'
  /** Our resting price. */
  price: number
  size: number
  postedAt: number
  status: 'resting' | 'filled' | 'cancelled'
  // Snapshot of the book state at posting time — used as a sanity reference
  // when reasoning about adverse moves.
  postedBestBid: number | null
  postedBestAsk: number | null
}

export interface FillEvent {
  id: string
  orderId: string
  conditionId: string
  question: string
  side: 'bid' | 'ask'
  /** Price our resting order filled at. */
  fillPrice: number
  size: number
  /** Top of book on the opposite side at the moment of fill — what we have to
   *  pay to immediately hedge. */
  hedgePrice: number
  /** Realised P&L from the fill+hedge cycle in USD (negative = adverse). */
  realisedPnlUsd: number
  /** Maker fee charged at fill. */
  makerFeeUsd: number
  /** Taker fee charged at hedge. */
  takerFeeUsd: number
  filledAt: number
  hedgeOrderId: string | null
  hedgeStatus: 'pending' | 'done' | 'failed'
}

export interface RewardAccrual {
  /** USDC of reward our score has earned since the engine started, integrated
   *  over time. Updated once per REWARD_TICK_MS. */
  totalEarnedUsd: number
  /** Last instantaneous earning rate ($/day) we observed. */
  lastRatePerDay: number
  lastUpdatedAt: number
}

export interface EngineSnapshot {
  state: EngineState
  startedAt: number | null
  brokerKind: 'paper' | 'live'
  config: StrategyConfig
  /** All phantom orders the engine has ever placed (resting + closed). */
  orders: PhantomOrder[]
  /** All fills the engine has detected, newest first in the UI. */
  fills: FillEvent[]
  reward: RewardAccrual
  /** Per-allocation latest stats (current quote, current share). */
  positions: PaperPosition[]
}

export interface PaperPosition {
  conditionId: string
  question: string
  bidOrderId: string | null
  askOrderId: string | null
  midPrice: number | null
  bestBid: number | null
  bestAsk: number | null
  rewardSharePct: number
  expectedRatePerDay: number
}

interface InternalPosition extends PaperPosition {
  tokenId: string
  outcome: string
  bidPrice: number
  askPrice: number
  bidSize: number
  askSize: number
  maxSpreadDollars: number
  dailyPool: number
  // Live numerator + denominator for proportional reward attribution.
  ourScore: number
  totalScore: number
}

type Listener = () => void

interface EngineDeps {
  broker?: Broker
}

function persisted(): Pick<EngineSnapshot, 'fills' | 'reward'> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Pick<EngineSnapshot, 'fills' | 'reward'>
    return parsed
  } catch {
    return null
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

export class PaperTradingEngine {
  private state: EngineState = 'idle'
  private startedAt: number | null = null
  private orders: PhantomOrder[] = []
  private fills: FillEvent[] = []
  private positions = new Map<string, InternalPosition>()
  private reward: RewardAccrual = { totalEarnedUsd: 0, lastRatePerDay: 0, lastUpdatedAt: Date.now() }
  private config: StrategyConfig | null = null
  private rewardTimer: number | null = null
  private listeners = new Set<Listener>()
  private readonly broker: Broker

  constructor(deps: EngineDeps = {}) {
    this.broker = deps.broker ?? new PaperBroker()
    const stored = persisted()
    if (stored) {
      this.fills = stored.fills ?? []
      this.reward = stored.reward ?? this.reward
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  snapshot(): EngineSnapshot {
    return {
      state: this.state,
      startedAt: this.startedAt,
      brokerKind: this.broker.kind,
      config: this.config ?? ({} as StrategyConfig),
      orders: [...this.orders],
      fills: [...this.fills],
      reward: { ...this.reward },
      positions: [...this.positions.values()].map((p) => ({
        conditionId: p.conditionId,
        question: p.question,
        bidOrderId: p.bidOrderId,
        askOrderId: p.askOrderId,
        midPrice: p.midPrice,
        bestBid: p.bestBid,
        bestAsk: p.bestAsk,
        rewardSharePct: p.rewardSharePct,
        expectedRatePerDay: p.expectedRatePerDay,
      })),
    }
  }

  async start(
    allocations: StrategyAllocation[],
    rows: RewardsRow[],
    config: StrategyConfig,
  ): Promise<void> {
    if (this.state === 'running') return
    this.state = 'running'
    this.startedAt = Date.now()
    this.config = config
    this.positions.clear()
    this.orders = []
    this.notify()

    const rowsById = new Map(rows.map((r) => [r.conditionId, r]))

    for (const a of allocations) {
      const row = rowsById.get(a.conditionId)
      if (!row || a.bidPrice === null || a.askPrice === null) continue
      const yesBook = row.books[0]
      if (!yesBook) continue

      const halfCapital = config.perMarketCapitalUsd / 2
      const bidSize = Math.max(row.rewardMinSize, halfCapital / Math.max(a.bidPrice, 0.01))
      const askSize = Math.max(row.rewardMinSize, halfCapital / Math.max(a.askPrice, 0.01))

      const bidReq: PlaceOrderRequest = {
        conditionId: a.conditionId,
        tokenId: yesBook.tokenId,
        side: 'buy',
        price: a.bidPrice,
        size: bidSize,
        clientTag: 'paper-mm-bid',
      }
      const askReq: PlaceOrderRequest = {
        conditionId: a.conditionId,
        tokenId: yesBook.tokenId,
        side: 'sell',
        price: a.askPrice,
        size: askSize,
        clientTag: 'paper-mm-ask',
      }
      const [bidRes, askRes] = await Promise.all([
        this.broker.placeOrder(bidReq),
        this.broker.placeOrder(askReq),
      ])

      const bidOrder = this.recordOrder(bidRes, 'bid', yesBook.outcome, yesBook.bestBid, yesBook.bestAsk)
      const askOrder = this.recordOrder(askRes, 'ask', yesBook.outcome, yesBook.bestBid, yesBook.bestAsk)

      this.positions.set(a.conditionId, {
        conditionId: a.conditionId,
        question: a.question,
        tokenId: yesBook.tokenId,
        outcome: yesBook.outcome,
        bidOrderId: bidOrder.id,
        askOrderId: askOrder.id,
        bidPrice: a.bidPrice,
        askPrice: a.askPrice,
        bidSize,
        askSize,
        maxSpreadDollars: row.rewardMaxSpread / 100,
        dailyPool: row.dailyRate,
        midPrice: yesBook.mid,
        bestBid: yesBook.bestBid,
        bestAsk: yesBook.bestAsk,
        rewardSharePct: 0,
        expectedRatePerDay: 0,
        ourScore: 0,
        totalScore: 0,
      })
    }

    this.scheduleRewardTick()
    this.notify()
  }

  async stop(): Promise<void> {
    if (this.state !== 'running') return
    this.state = 'stopping'
    this.notify()

    if (this.rewardTimer !== null) {
      window.clearInterval(this.rewardTimer)
      this.rewardTimer = null
    }
    // Cancel all resting orders.
    const restingIds = this.orders.filter((o) => o.status === 'resting').map((o) => o.id)
    await Promise.all(restingIds.map((id) => this.broker.cancelOrder(id)))
    for (const id of restingIds) {
      const idx = this.orders.findIndex((o) => o.id === id)
      if (idx >= 0) this.orders[idx] = { ...this.orders[idx], status: 'cancelled' }
    }
    this.positions.clear()
    this.state = 'idle'
    this.startedAt = null
    this.persist()
    this.notify()
  }

  /**
   * Feed a fresh book snapshot into the engine. Call this from the same
   * onBook hook that updates the UI.
   */
  evaluateBook(tokenId: string, view: BookView): void {
    if (this.state !== 'running') return
    // Find the position whose tokenId matches.
    let pos: InternalPosition | undefined
    for (const p of this.positions.values()) {
      if (p.tokenId === tokenId) {
        pos = p
        break
      }
    }
    if (!pos) return

    pos.midPrice = view.mid
    pos.bestBid = view.bestBid
    pos.bestAsk = view.bestAsk

    // ── Reward share recompute ───────────────────────────────────────
    if (view.mid !== null && this.config) {
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
    }

    // ── Fill detection ───────────────────────────────────────────────
    // A bid is "filled" when the book's best bid drops to or below our resting
    // bid (someone took out the levels above us, the touch reached our level).
    // An ask is filled when best ask rises to or above our resting ask.
    if (pos.bidOrderId && view.bestBid !== null && view.bestBid <= pos.bidPrice) {
      void this.handleFill(pos, 'bid', view)
    }
    if (pos.askOrderId && view.bestAsk !== null && view.bestAsk >= pos.askPrice) {
      void this.handleFill(pos, 'ask', view)
    }
  }

  // ── Internals ──────────────────────────────────────────────────────

  private recordOrder(
    res: PlaceOrderResult,
    side: 'bid' | 'ask',
    outcome: string,
    bestBid: number | null,
    bestAsk: number | null,
  ): PhantomOrder {
    const order: PhantomOrder = {
      id: res.id,
      conditionId: res.request.conditionId,
      tokenId: res.request.tokenId,
      outcome,
      side,
      price: res.request.price,
      size: res.request.size,
      postedAt: res.acceptedAt,
      status: 'resting',
      postedBestBid: bestBid,
      postedBestAsk: bestAsk,
    }
    this.orders.push(order)
    return order
  }

  private async handleFill(
    pos: InternalPosition,
    side: 'bid' | 'ask',
    view: BookView,
  ): Promise<void> {
    const orderId = side === 'bid' ? pos.bidOrderId : pos.askOrderId
    if (!orderId) return
    const order = this.orders.find((o) => o.id === orderId)
    if (!order || order.status !== 'resting') return

    // Mark resting order filled before any awaits to prevent re-entrancy.
    order.status = 'filled'
    if (side === 'bid') pos.bidOrderId = null
    else pos.askOrderId = null

    // Hedge price: cross the opposite side. If we got hit on bid (long YES),
    // sell at current best_bid; if lifted on ask (short YES), buy at best_ask.
    const hedgePrice =
      side === 'bid'
        ? (view.bestBid ?? order.price)
        : (view.bestAsk ?? order.price)
    const hedgeSize = order.size
    const hedgeSide = side === 'bid' ? 'sell' : 'buy'

    const config = this.config ?? ({ takerFeePct: 0, makerFeePct: 0 } as StrategyConfig)

    // P&L. For a bid fill: bought at order.price, sell hedge at hedgePrice.
    //   gross = (hedgePrice − order.price) · size   (typically negative)
    // For an ask fill: sold at order.price, buy hedge at hedgePrice.
    //   gross = (order.price − hedgePrice) · size  (typically negative)
    const gross =
      side === 'bid'
        ? (hedgePrice - order.price) * hedgeSize
        : (order.price - hedgePrice) * hedgeSize
    const makerFee = order.price * order.size * (config.makerFeePct ?? 0)
    const takerFee = hedgePrice * hedgeSize * (config.takerFeePct ?? 0)
    const realisedPnl = gross - makerFee - takerFee

    const fill: FillEvent = {
      id: `fill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      orderId: order.id,
      conditionId: pos.conditionId,
      question: pos.question,
      side,
      fillPrice: order.price,
      size: order.size,
      hedgePrice,
      realisedPnlUsd: realisedPnl,
      makerFeeUsd: makerFee,
      takerFeeUsd: takerFee,
      filledAt: Date.now(),
      hedgeOrderId: null,
      hedgeStatus: 'pending',
    }
    this.fills = [fill, ...this.fills].slice(0, 200)
    this.persist()
    this.notify()

    // Fire the hedge through the broker. PaperBroker resolves immediately,
    // LiveBroker would actually submit a market order on the CLOB.
    let hedgeRes: MarketHedgeResult | null = null
    try {
      hedgeRes = await this.broker.marketHedge({
        conditionId: pos.conditionId,
        tokenId: pos.tokenId,
        side: hedgeSide,
        size: hedgeSize,
        expectedPrice: order.price,
        fillPrice: hedgePrice,
      })
    } catch {
      const idx = this.fills.findIndex((f) => f.id === fill.id)
      if (idx >= 0) this.fills[idx] = { ...this.fills[idx], hedgeStatus: 'failed' }
      this.notify()
      return
    }
    const idx = this.fills.findIndex((f) => f.id === fill.id)
    if (idx >= 0) {
      this.fills[idx] = {
        ...this.fills[idx],
        hedgeOrderId: hedgeRes.id,
        hedgeStatus: 'done',
      }
    }
    this.persist()
    this.notify()

    // After a fill we *don't* automatically repost — that's a strategy decision
    // worth surfacing, not silently doing. Future: a "auto-repost on fill"
    // toggle that places a fresh resting order at the new strategy price.
  }

  private scheduleRewardTick(): void {
    if (this.rewardTimer !== null) window.clearInterval(this.rewardTimer)
    this.rewardTimer = window.setInterval(() => this.accrueRewards(), REWARD_TICK_MS)
  }

  private accrueRewards(): void {
    if (this.state !== 'running') return
    const now = Date.now()
    const elapsedDays = (now - this.reward.lastUpdatedAt) / (24 * 60 * 60 * 1000)
    let totalRate = 0
    for (const p of this.positions.values()) totalRate += p.expectedRatePerDay
    this.reward.totalEarnedUsd += totalRate * elapsedDays
    this.reward.lastRatePerDay = totalRate
    this.reward.lastUpdatedAt = now
    this.persist()
    this.notify()
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ fills: this.fills, reward: this.reward }),
      )
    } catch {
      // localStorage full / disabled — non-fatal.
    }
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  /** Wipe persisted fills + reward accrual. Engine state untouched. */
  resetHistory(): void {
    this.fills = []
    this.reward = { totalEarnedUsd: 0, lastRatePerDay: 0, lastUpdatedAt: Date.now() }
    this.persist()
    this.notify()
  }
}

let singleton: PaperTradingEngine | null = null
export function getPaperEngine(): PaperTradingEngine {
  if (!singleton) singleton = new PaperTradingEngine()
  return singleton
}
