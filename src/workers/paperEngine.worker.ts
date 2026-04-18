/**
 * Paper-trading engine Web Worker.
 *
 * Receives batched book updates from the main thread via postMessage, runs
 * fill detection + reward accrual entirely off the main thread, and sends back
 * summary state at most every SUMMARY_INTERVAL_MS (2 s).
 *
 * Message protocol (main → worker):
 *   { type: 'start',   payload: StartPayload  }
 *   { type: 'stop'                            }
 *   { type: 'reset'                           }
 *   { type: 'books',   payload: BooksBatch    }  ← batched WS updates
 *
 * Message protocol (worker → main):
 *   { type: 'summary', payload: WorkerSummary }  ← at most every 2 s
 *   { type: 'fill',    payload: FillEvent     }  ← immediately on fill
 */

import type { StrategyAllocation, StrategyConfig, RewardsRow } from '../types'

// ── Types shared with the main thread ─────────────────────────────────────

export interface BookLevel {
  price: number
  size: number
}

export interface BookView {
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  spread: number | null
  bids: BookLevel[]
  asks: BookLevel[]
}

export interface BooksBatch {
  /** tokenId → BookView for all updates accumulated in this batch window */
  updates: Record<string, BookView>
}

export interface StartPayload {
  allocations: StrategyAllocation[]
  rows: RewardsRow[]
  config: StrategyConfig
}

export interface FillEvent {
  id: string
  orderId: string
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
  hedgeStatus: 'pending' | 'done' | 'failed'
}

export interface WorkerPosition {
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

export interface WorkerSummary {
  state: 'idle' | 'running' | 'stopping'
  startedAt: number | null
  positions: WorkerPosition[]
  fills: FillEvent[]
  reward: { totalEarnedUsd: number; lastRatePerDay: number; lastUpdatedAt: number }
  netPnl: number
}

// ── Internal engine state ──────────────────────────────────────────────────

const REWARD_TICK_MS = 1_000
const SUMMARY_INTERVAL_MS = 2_000

let engineState: 'idle' | 'running' | 'stopping' = 'idle'
let startedAt: number | null = null
let engineConfig: StrategyConfig | null = null

interface InternalOrder {
  id: string
  conditionId: string
  tokenId: string
  side: 'bid' | 'ask'
  price: number
  size: number
  status: 'resting' | 'filled' | 'cancelled'
}

interface InternalPosition {
  conditionId: string
  question: string
  tokenId: string
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
  ourScore: number
  totalScore: number
  latestBook: BookView | null
}

const orders = new Map<string, InternalOrder>()
const positions = new Map<string, InternalPosition>() // keyed by conditionId
const tokenToCondition = new Map<string, string>()    // tokenId → conditionId
let fills: FillEvent[] = []
let reward = { totalEarnedUsd: 0, lastRatePerDay: 0, lastUpdatedAt: Date.now() }

let rewardTimer: ReturnType<typeof setInterval> | null = null
let summaryTimer: ReturnType<typeof setInterval> | null = null

// ── ID generation ──────────────────────────────────────────────────────────

let idCounter = 0
function genId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

// ── Score helpers ──────────────────────────────────────────────────────────

function levelScore(d: number, sizeUsd: number, maxSpreadDollars: number): number {
  if (d < 0 || d > maxSpreadDollars) return 0
  return (1 - d / maxSpreadDollars) * sizeUsd
}

function competingScore(
  levels: BookLevel[],
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

// ── Engine lifecycle ───────────────────────────────────────────────────────

function startEngine(payload: StartPayload): void {
  if (engineState === 'running') return

  engineState = 'running'
  startedAt = Date.now()
  engineConfig = payload.config
  orders.clear()
  positions.clear()
  tokenToCondition.clear()

  const rowsById = new Map(payload.rows.map((r) => [r.conditionId, r]))

  for (const a of payload.allocations) {
    const row = rowsById.get(a.conditionId)
    if (!row || a.bidPrice === null || a.askPrice === null) continue
    const yesBook = row.books[0]
    if (!yesBook) continue

    const halfCapital = payload.config.perMarketCapitalUsd / 2
    const bidSize = Math.max(row.rewardMinSize, halfCapital / Math.max(a.bidPrice, 0.01))
    const askSize = Math.max(row.rewardMinSize, halfCapital / Math.max(a.askPrice, 0.01))

    const bidOrderId = genId('paper-ord')
    const askOrderId = genId('paper-ord')

    orders.set(bidOrderId, {
      id: bidOrderId,
      conditionId: a.conditionId,
      tokenId: yesBook.tokenId,
      side: 'bid',
      price: a.bidPrice,
      size: bidSize,
      status: 'resting',
    })
    orders.set(askOrderId, {
      id: askOrderId,
      conditionId: a.conditionId,
      tokenId: yesBook.tokenId,
      side: 'ask',
      price: a.askPrice,
      size: askSize,
      status: 'resting',
    })

    const pos: InternalPosition = {
      conditionId: a.conditionId,
      question: a.question,
      tokenId: yesBook.tokenId,
      bidOrderId,
      askOrderId,
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
      latestBook: null,
    }
    positions.set(a.conditionId, pos)
    tokenToCondition.set(yesBook.tokenId, a.conditionId)
  }

  rewardTimer = setInterval(accrueRewardsAndScores, REWARD_TICK_MS)
  summaryTimer = setInterval(sendSummary, SUMMARY_INTERVAL_MS)

  sendSummary()
}

function stopEngine(): void {
  if (engineState !== 'running') return
  engineState = 'stopping'

  if (rewardTimer !== null) { clearInterval(rewardTimer); rewardTimer = null }
  if (summaryTimer !== null) { clearInterval(summaryTimer); summaryTimer = null }

  // Cancel all resting orders
  for (const order of orders.values()) {
    if (order.status === 'resting') order.status = 'cancelled'
  }

  positions.clear()
  tokenToCondition.clear()
  engineState = 'idle'
  startedAt = null

  sendSummary()
}

function resetHistory(): void {
  fills = []
  reward = { totalEarnedUsd: 0, lastRatePerDay: 0, lastUpdatedAt: Date.now() }
  sendSummary()
}

// ── Book update processing ─────────────────────────────────────────────────

function processBooks(batch: BooksBatch): void {
  if (engineState !== 'running') return

  for (const [tokenId, view] of Object.entries(batch.updates)) {
    const conditionId = tokenToCondition.get(tokenId)
    if (!conditionId) continue
    const pos = positions.get(conditionId)
    if (!pos) continue

    pos.latestBook = view
    pos.midPrice = view.mid
    pos.bestBid = view.bestBid
    pos.bestAsk = view.bestAsk

    // Fill detection: cheap — two comparisons
    if (pos.bidOrderId && view.bestBid !== null && view.bestBid <= pos.bidPrice) {
      handleFill(pos, 'bid', view)
    }
    if (pos.askOrderId && view.bestAsk !== null && view.bestAsk >= pos.askPrice) {
      handleFill(pos, 'ask', view)
    }
  }
}

function handleFill(pos: InternalPosition, side: 'bid' | 'ask', view: BookView): void {
  const orderId = side === 'bid' ? pos.bidOrderId : pos.askOrderId
  if (!orderId) return
  const order = orders.get(orderId)
  if (!order || order.status !== 'resting') return

  // Mark filled immediately to prevent re-entrancy
  order.status = 'filled'
  if (side === 'bid') pos.bidOrderId = null
  else pos.askOrderId = null

  const hedgePrice = side === 'bid'
    ? (view.bestBid ?? order.price)
    : (view.bestAsk ?? order.price)

  const config = engineConfig ?? ({ takerFeePct: 0, makerFeePct: 0 } as StrategyConfig)
  const gross = side === 'bid'
    ? (hedgePrice - order.price) * order.size
    : (order.price - hedgePrice) * order.size
  const makerFee = order.price * order.size * (config.makerFeePct ?? 0)
  const takerFee = hedgePrice * order.size * (config.takerFeePct ?? 0)
  const realisedPnl = gross - makerFee - takerFee

  const hedgeOrderId = genId('paper-hedge')
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
    hedgeOrderId,
    hedgeStatus: 'done',
  }
  fills = [fill, ...fills].slice(0, 200)

  // Notify main thread immediately on fill (not throttled)
  self.postMessage({ type: 'fill', payload: fill })
}

function accrueRewardsAndScores(): void {
  if (engineState !== 'running') return
  const now = Date.now()

  // Recompute scores for all positions
  for (const pos of positions.values()) {
    const view = pos.latestBook
    if (!view || view.mid === null) continue
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

  // Accrue rewards
  const elapsedDays = (now - reward.lastUpdatedAt) / (24 * 60 * 60 * 1000)
  let totalRate = 0
  for (const p of positions.values()) totalRate += p.expectedRatePerDay
  reward.totalEarnedUsd += totalRate * elapsedDays
  reward.lastRatePerDay = totalRate
  reward.lastUpdatedAt = now
}

function sendSummary(): void {
  const positionSnapshots: WorkerPosition[] = [...positions.values()].map((p) => ({
    conditionId: p.conditionId,
    question: p.question,
    bidOrderId: p.bidOrderId,
    askOrderId: p.askOrderId,
    midPrice: p.midPrice,
    bestBid: p.bestBid,
    bestAsk: p.bestAsk,
    rewardSharePct: p.rewardSharePct,
    expectedRatePerDay: p.expectedRatePerDay,
  }))

  const totalPnl = fills.reduce((s, f) => s + f.realisedPnlUsd, 0)
  const netPnl = totalPnl + reward.totalEarnedUsd

  const summary: WorkerSummary = {
    state: engineState,
    startedAt,
    positions: positionSnapshots,
    fills: fills.slice(0, 200),
    reward: { ...reward },
    netPnl,
  }

  self.postMessage({ type: 'summary', payload: summary })
}

// ── Message handler ────────────────────────────────────────────────────────

self.addEventListener('message', (evt: MessageEvent<{ type: string; payload?: unknown }>) => {
  const { type, payload } = evt.data
  switch (type) {
    case 'start':
      startEngine(payload as StartPayload)
      break
    case 'stop':
      stopEngine()
      break
    case 'reset':
      resetHistory()
      break
    case 'books':
      processBooks(payload as BooksBatch)
      break
    default:
      break
  }
})
