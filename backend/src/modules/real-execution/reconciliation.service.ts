import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common'

import { ClobBroker } from './clob-broker'
import type { RealOrderRow } from './real-order.repo'
import { RealOrderRepo } from './real-order.repo'
import { RealFillRepo } from './real-fill.repo'
import { RealPositionRepo } from './real-position.repo'
import { RealStateRepo } from './real-state.repo'

// Every RECONCILE_TICK_MS we poll the CLOB for each still-live real order and
// for any trades that landed since the last run. Keeps real_orders.filled_size
// + status in lockstep with the exchange's view, and ingests orphan trades
// (CLOB filled us but paper never told us — e.g. late fill after drift-cancel)
// as reconciler-sourced RealFill rows. When ENABLE_REAL_EXECUTION is false the
// loop still ticks but short-circuits: there's nothing real to reconcile.
const RECONCILE_TICK_MS = 30_000

// Price divergence threshold between paper's expected fill and CLOB's actual
// avg execution. One cent is wide enough to tolerate normal book jitter but
// narrow enough to catch real divergence worth a human look.
const PRICE_DIV_THRESHOLD = 0.01

// Floating-point tolerance when comparing filled size vs order size — CLOB
// decimal math can leave ~1e-9 residue on "fully filled" orders.
const SIZE_EPSILON = 1e-6

// After this many consecutive hedge failures a fill is marked 'abandoned' and
// permanently removed from the retry queue. Protects against infinite loops on
// unhedgeable fills (balance=0, market resolved, notional cap, etc.).
const HEDGE_MAX_RETRIES = 5

// syncWalletFills runs every reconciler tick using a persistent cursor stored
// in real_execution_state.wallet_sync_cursor_at, so it survives restarts and
// never misses trades even after extended downtime. On first boot the cursor
// defaults to WALLET_SYNC_DEFAULT_LOOKBACK_MS ago.
const WALLET_SYNC_DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
// Keep the cursor 60 minutes behind wall-clock. Polymarket data-api indexing
// lag can exceed 5 min; a 60 min window ensures trades are visible before the
// cursor advances past them. Dedup via clob_trade_id UNIQUE constraint prevents
// re-ingestion of already-recorded fills.
const WALLET_SYNC_CURSOR_LAG_MS = 60 * 60 * 1000 // 60 minutes

export interface ReconciliationStatus {
  enabled: boolean
  running: boolean
  lastTickAt: number | null
  lastTickDurationMs: number | null
  lastTickError: string | null
  totalTicks: number
  totalOrdersReconciled: number
  totalFillsIngested: number
  totalDiscrepancies: number
  totalErrors: number
  openOrders: number
  discrepancyOrders: number
}

interface ClobOrderView {
  matchedSize: number
  status: string
  avgPrice: number | null
}

@Injectable()
export class ReconciliationService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReconciliationService.name)

  private timer: NodeJS.Timeout | null = null
  private running = false
  private lastTickAt: number | null = null
  private lastTickDurationMs: number | null = null
  private lastTickError: string | null = null
  private totalTicks = 0
  private totalOrdersReconciled = 0
  private totalFillsIngested = 0
  private totalDiscrepancies = 0
  private totalErrors = 0

  constructor(
    private readonly broker: ClobBroker,
    private readonly orderRepo: RealOrderRepo,
    private readonly fillRepo: RealFillRepo,
    private readonly stateRepo: RealStateRepo,
    private readonly positionRepo: RealPositionRepo,
  ) {}

  onModuleInit(): void {
    // The timer ticks even when disabled — runOnce short-circuits early. That
    // way flipping ENABLE_REAL_EXECUTION at runtime doesn't need a restart.
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error(
          `reconciler tick crashed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }, RECONCILE_TICK_MS)
    this.logger.log(`Reconciler armed — ticking every ${RECONCILE_TICK_MS}ms`)
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async getStatus(): Promise<ReconciliationStatus> {
    const [openOrders, discrepancyOrders] = await Promise.all([
      this.orderRepo.readOpen(),
      this.orderRepo.countDiscrepancies(),
    ])
    return {
      enabled: this.broker.isEnabled(),
      running: this.running,
      lastTickAt: this.lastTickAt,
      lastTickDurationMs: this.lastTickDurationMs,
      lastTickError: this.lastTickError,
      totalTicks: this.totalTicks,
      totalOrdersReconciled: this.totalOrdersReconciled,
      totalFillsIngested: this.totalFillsIngested,
      totalDiscrepancies: this.totalDiscrepancies,
      totalErrors: this.totalErrors,
      openOrders: openOrders.length,
      discrepancyOrders,
    }
  }

  async runOnce(): Promise<ReconciliationStatus> {
    if (this.running) {
      // A tick is already in flight — skip rather than stack. Force-run from
      // the admin endpoint will just return current status.
      return this.getStatus()
    }
    this.running = true
    const startedAt = Date.now()
    this.lastTickError = null
    try {
      // syncWalletFills runs every tick using a durable cursor — cheap when idle,
      // guaranteed not to miss fills due to eventual-consistency delays on the CLOB.
      await this.syncWalletFills()
      await this.rebuildPositions()
      // Short-circuit order reconciliation when real dispatch is off. We still
      // advance totalTicks so the status view shows the loop is alive.
      if (!this.broker.isEnabled()) {
        this.totalTicks++
        return this.getStatus()
      }
      // Reconciliation always runs regardless of pause state — pausing only
      // prevents new order placement (handled in ClobBroker.dispatchAllowed).
      // We still need to track fills and update statuses while paused.
      await this.reconcileOpenOrders()
      await this.retryUnhedgedFills()
      this.totalTicks++
    } catch (err) {
      this.lastTickError = err instanceof Error ? err.message : String(err)
      this.totalErrors++
      this.logger.error(`runOnce failed: ${this.lastTickError}`)
    } finally {
      this.lastTickAt = Date.now()
      this.lastTickDurationMs = this.lastTickAt - startedAt
      this.running = false
    }
    return this.getStatus()
  }

  private async reconcileOpenOrders(): Promise<void> {
    const openOrders = await this.orderRepo.readOpen()
    for (const row of openOrders) {
      // Synthetic IDs (prepost-*) were never posted to CLOB — skip CLOB
      // lookup and mark them rejected so they don't pollute KPIs forever.
      if (row.id.startsWith('prepost-')) {
        this.logger.warn(`order ${row.id} has synthetic ID — marking rejected`)
        await this.orderRepo.patchReconcile(row.id, {
          status: 'rejected',
          closedAt: Date.now(),
          discrepancy: 'synthetic ID — CLOB order ID was not captured at placement',
          lastReconciledAt: Date.now(),
        })
        this.totalOrdersReconciled++
        continue
      }
      try {
        const raw = await this.broker.fetchOrder(row.id)
        if (!raw || Object.keys(raw).length === 0) {
          this.logger.warn(`order ${row.id} not found on CLOB — marking cancelled`)
          await this.orderRepo.patchReconcile(row.id, {
            status: 'cancelled',
            closedAt: Date.now(),
            discrepancy: 'not found on CLOB during reconciliation',
            lastReconciledAt: Date.now(),
          })
          this.totalOrdersReconciled++
          continue
        }
        const view = this.parseClobOrder(raw)
        await this.applyOrderPatch(row, view)
        this.totalOrdersReconciled++
      } catch (err) {
        this.totalErrors++
        this.logger.warn(
          `reconcile order ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  private async retryUnhedgedFills(): Promise<void> {
    const fills = await this.fillRepo.readUnhedged()
    if (fills.length === 0) return
    this.logger.log(`retryUnhedgedFills: ${fills.length} fill(s) to retry`)
    // Cap at 10 per tick so a backlog doesn't hold up the rest of the reconciler.
    const batch = fills.slice(0, 10)
    for (const fill of batch) {
      try {
        // Resolve tokenId: stored directly on the fill (reconciler fills), then
        // via order lookup (paper fills), last-resort via clobTradeId extraction.
        let tokenId = fill.tokenId ?? undefined
        if (!tokenId) {
          const order =
            (await this.orderRepo.findByDecisionId(fill.decisionId)) ??
            (await this.orderRepo.findById(fill.realOrderId))
          tokenId = order?.tokenId
        }
        if (!tokenId && fill.clobTradeId) {
          const lastSegment = fill.clobTradeId.split('-').pop()
          if (lastSegment && /^\d{10,}$/.test(lastSegment)) tokenId = lastSegment
        }
        if (!tokenId) {
          this.logger.warn(`retryUnhedgedFills: no tokenId for fill ${fill.id}, skipping`)
          continue
        }
        // Ask-side fills need noTokenId to sell the NO tokens held in real wallet.
        let noTokenId: string | undefined
        if (fill.side === 'ask' && fill.conditionId) {
          noTokenId = (await this.broker.getNoTokenId(fill.conditionId, tokenId)) ?? undefined
          if (!noTokenId) {
            this.logger.warn(
              `retryUnhedgedFills: could not resolve noTokenId for ask fill ${fill.id} (condition ${fill.conditionId})`,
            )
          }
        }
        await this.broker.retryHedge(fill, tokenId, noTokenId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.warn(`retryUnhedgedFills error for fill ${fill.id}: ${msg}`)
        const newCount = await this.fillRepo.incrementRetryCount(fill.id)
        if (newCount >= HEDGE_MAX_RETRIES) {
          await this.fillRepo.updateHedge(fill.id, null, 'abandoned')
          this.logger.warn(
            `retryUnhedgedFills: fill ${fill.id} abandoned after ${newCount} failures (last: ${msg})`,
          )
        }
      }
    }
  }

  // Recomputes real_positions from all real_fills with a confirmed clobTradeId.
  // Runs after every syncWalletFills so positions always reflect on-chain reality.
  private async rebuildPositions(): Promise<void> {
    const allFills = await this.fillRepo.readAll(50_000)
    const realFills = allFills.filter((f) => f.clobTradeId !== null)
    if (realFills.length === 0) return

    const byCondition = new Map<string, typeof realFills>()
    for (const f of realFills) {
      const arr = byCondition.get(f.conditionId) ?? []
      arr.push(f)
      byCondition.set(f.conditionId, arr)
    }

    for (const [conditionId, fills] of byCondition) {
      const bidFills = fills.filter((f) => f.side === 'bid')
      const askFills = fills.filter((f) => f.side === 'ask')
      const bidSize = bidFills.reduce((s, f) => s + f.size, 0)
      const askSize = askFills.reduce((s, f) => s + f.size, 0)
      const bidPrice =
        bidSize > 0 ? bidFills.reduce((s, f) => s + f.fillPrice * f.size, 0) / bidSize : 0
      const askPrice =
        askSize > 0 ? askFills.reduce((s, f) => s + f.fillPrice * f.size, 0) / askSize : 0

      const latest = fills.reduce((a, b) => (a.filledAt > b.filledAt ? a : b))
      const order =
        (await this.orderRepo.findById(latest.realOrderId).catch(() => null)) ??
        (await this.orderRepo.findByDecisionId(latest.decisionId).catch(() => null))

      await this.positionRepo.upsert({
        conditionId,
        decisionId: latest.decisionId,
        question: latest.question,
        tokenId: order?.tokenId ?? '',
        outcome: order?.outcome ?? '',
        bidOrderId: bidFills.length > 0 ? bidFills[bidFills.length - 1].realOrderId : null,
        askOrderId: askFills.length > 0 ? askFills[askFills.length - 1].realOrderId : null,
        bidPrice,
        askPrice,
        bidSize,
        askSize,
        capitalUsd: bidSize * bidPrice + askSize * askPrice,
        updatedAt: Date.now(),
      })
    }
  }

  // Fetches all CLOB trades for the wallet from the persistent cursor forward
  // and upserts any that are missing from real_fills. Uses a durable cursor in
  // real_execution_state.wallet_sync_cursor_at so no fills are ever lost across
  // restarts or extended downtime.
  private async syncWalletFills(): Promise<void> {
    const state = await this.stateRepo.read()
    const sinceMs = state.walletSyncCursorAt ?? Date.now() - WALLET_SYNC_DEFAULT_LOOKBACK_MS

    let trades: Array<Record<string, unknown>>
    try {
      trades = await this.broker.fetchTrades(sinceMs)
    } catch (err) {
      this.logger.warn(
        `syncWalletFills fetchTrades failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }

    let ingested = 0
    for (const t of trades) {
      const tradeId = asString(t['id']) ?? asString(t['trade_id'])
      if (!tradeId) continue
      if (await this.fillRepo.findByClobTradeId(tradeId)) continue

      const orderId = asString(t['order_id']) ?? asString(t['maker_order_id'])
      const price = asNumber(t['price'])
      const size = asNumber(t['size']) ?? asNumber(t['match_size'])
      const side = asString(t['side'])?.toLowerCase()
      const tokenId = asString(t['asset_id']) ?? asString(t['token_id'])
      const filledAt = asNumber(t['timestamp'])
      if (price === null || size === null || filledAt === null) continue

      let decisionId = 'wallet-sync-' + tradeId
      let realOrderId = orderId ?? tradeId
      let conditionId = asString(t['market']) ?? ''
      let resolvedSide: 'bid' | 'ask' = side === 'sell' ? 'ask' : 'bid'

      if (orderId) {
        const parentOrder = await this.orderRepo.findByPaperId(orderId).catch(() => null)
        const fallback = parentOrder ?? (await this.findOrderById(orderId))
        if (fallback) {
          decisionId = fallback.decisionId
          realOrderId = fallback.id
          conditionId = fallback.conditionId
          resolvedSide = fallback.side
        }
      }

      // SELL trades from our wallet are closing/hedge trades — they don't need
      // a hedge themselves. Mark as not-applicable so retryUnhedgedFills ignores
      // them. Only BUY trades (opening positions) need a hedge.
      const isSell = side === 'sell'
      const hedgeStatus = isSell ? 'not-applicable' : 'skipped'

      try {
        await this.fillRepo.insert({
          id: `wallet-sync-${tradeId}`,
          decisionId,
          paperFillId: null,
          realOrderId,
          conditionId,
          question: '',
          side: resolvedSide,
          fillPrice: price,
          size,
          hedgePrice: price,
          realisedPnlUsd: 0,
          makerFeeUsd: 0,
          takerFeeUsd: 0,
          filledAt: filledAt > 1e12 ? filledAt : filledAt * 1000,
          hedgeOrderId: null,
          hedgeStatus,
          txHash: asString(t['transaction_hash']) ?? null,
          clobTradeId: tradeId,
          tokenId: tokenId ?? null,
          source: 'reconciler',
          hedgeRetryCount: 0,
        })
        ingested++
        if (tokenId) this.logger.debug(`wallet-sync ingested trade ${tradeId} token=${tokenId}`)
      } catch (err) {
        this.logger.warn(
          `wallet-sync insert trade ${tradeId} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // Advance cursor to 5 minutes behind now. The CLOB/data-api can reflect
    // fills with a delay; if we advance to Date.now() immediately we can race
    // past a fill before it becomes visible and lose it permanently.
    await this.stateRepo.write({ walletSyncCursorAt: Date.now() - WALLET_SYNC_CURSOR_LAG_MS })
    if (ingested > 0) {
      this.logger.log(`syncWalletFills: ingested ${ingested} previously-missed fill(s)`)
      this.totalFillsIngested += ingested
    } else {
      this.logger.debug(`syncWalletFills: no new fills since ${new Date(sinceMs).toISOString()}`)
    }
  }

  private async findOrderById(orderId: string): Promise<RealOrderRow | null> {
    // readOpen is already indexed; fall back to paperOrder lookup for covered
    // cases, then give up. We intentionally don't add a generic findById repo
    // method here — the reconciler is the only caller that needs it.
    const open = await this.orderRepo.readOpen()
    const hit = open.find((o) => o.id === orderId)
    if (hit) return hit
    return this.orderRepo.findByPaperId(orderId)
  }

  private parseClobOrder(raw: Record<string, unknown>): ClobOrderView {
    const matchedSize =
      asNumber(raw['size_matched']) ??
      asNumber(raw['filled_size']) ??
      asNumber(raw['matched']) ??
      0
    const status = (asString(raw['status']) ?? '').toUpperCase()
    const avgPrice =
      asNumber(raw['average_price']) ??
      asNumber(raw['avg_price']) ??
      asNumber(raw['price']) ??
      null
    return { matchedSize, status, avgPrice }
  }

  private async applyOrderPatch(row: RealOrderRow, view: ClobOrderView): Promise<void> {
    const now = Date.now()
    let nextStatus = row.status
    let discrepancy: string | null = row.discrepancy

    // CLOB matched more than we ever posted — either CLOB mis-reported or two
    // orders share an id. Either way, flag it and let status follow the data.
    if (view.matchedSize > row.size + SIZE_EPSILON) {
      discrepancy = `matched ${view.matchedSize.toFixed(4)} > size ${row.size.toFixed(4)}`
    }

    if (view.matchedSize >= row.size - SIZE_EPSILON) {
      nextStatus = 'filled'
    } else if (view.matchedSize > SIZE_EPSILON) {
      nextStatus = 'partial'
    } else if (view.status === 'CANCELLED' || view.status === 'CANCELED') {
      nextStatus = 'cancelled'
    } else if (view.status === 'LIVE' || view.status === 'OPEN') {
      // Stay in current status. Don't flip accepted→resting artificially.
    }

    // Price divergence check — only once we actually have some fill to compare
    // against. Skip pre-fill rows since avg_price is noise there.
    if (
      view.matchedSize > SIZE_EPSILON &&
      view.avgPrice !== null &&
      Math.abs(view.avgPrice - row.price) > PRICE_DIV_THRESHOLD
    ) {
      const delta = (view.avgPrice - row.price).toFixed(4)
      discrepancy = discrepancy ?? `price div ${delta}`
    }

    const closedAt =
      nextStatus === 'filled' || nextStatus === 'cancelled'
        ? (row.closedAt ?? now)
        : null

    const discrepancyChanged = discrepancy !== row.discrepancy
    if (discrepancyChanged && discrepancy !== null) {
      this.totalDiscrepancies++
      this.logger.warn(`order ${row.id}: ${discrepancy}`)
    }

    // Fill rows are recorded exclusively by syncWalletFills (which dedupes
    // via clobTradeId). Writing fills here with clobTradeId=null would cause
    // double-fills because the dedup check can never match a null clobTradeId
    // against a real trade ID.

    await this.orderRepo.patchReconcile(row.id, {
      status: nextStatus,
      filledSize: view.matchedSize,
      closedAt,
      discrepancy,
      lastReconciledAt: now,
    })
  }
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}
