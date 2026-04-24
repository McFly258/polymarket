import { createHmac } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'

import type {
  OrderCancelledEvent,
  OrderFilledEvent,
  OrderPlacedEvent,
} from '../../domain/events'

import type { RealFillRow } from './real-fill.repo'
import type { RealOrderRow } from './real-order.repo'
import { RealFillRepo } from './real-fill.repo'
import { RealOrderRepo } from './real-order.repo'
import { RealStateRepo } from './real-state.repo'

const CLOB_BASE = 'https://clob.polymarket.com'

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v === undefined) return fallback
  return v.toLowerCase() === 'true' || v === '1'
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key]
  return v !== undefined && v !== '' ? Number(v) : fallback
}

type L2Headers = Record<string, string>

function buildL2Headers(
  method: string,
  path: string,
  body: string,
  walletAddress: string,
  secret: string,
  passphrase: string,
): L2Headers {
  const timestamp = Math.floor(Date.now() / 1000)
  const msg = `${timestamp}${method}${path}${body}`
  const signature = createHmac('sha256', secret).update(msg).digest('hex')
  return {
    POLY_ADDRESS: walletAddress,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp.toString(),
    POLY_NONCE: '0',
    POLY_PASSPHRASE: passphrase,
    'Content-Type': 'application/json',
  }
}

// ClobBroker — real-execution bridge driven by post-persist engine events.
// All methods are no-ops unless ENABLE_REAL_EXECUTION=true AND state.paused=false.
// Every call persists to the real_* tables, so paper↔real joins via decisionId
// work even when dispatch is disabled (real rows are recorded as 'skipped').
@Injectable()
export class ClobBroker {
  private readonly logger = new Logger(ClobBroker.name)

  constructor(
    private readonly orderRepo: RealOrderRepo,
    private readonly fillRepo: RealFillRepo,
    private readonly stateRepo: RealStateRepo,
  ) {}

  private get walletAddress(): string {
    return env('CLOB_WALLET_ADDRESS', 'your-wallet-address-here')
  }
  private get apiKey(): string {
    return env('CLOB_API_KEY', 'your-api-key-here')
  }
  private get apiSecret(): string {
    return env('CLOB_API_SECRET', 'your-api-secret-here')
  }
  private get apiPassphrase(): string {
    return env('CLOB_API_PASSPHRASE', 'your-passphrase-here')
  }
  private get maxDailyLoss(): number {
    return envNum('REAL_MAX_DAILY_LOSS_USD', 100)
  }
  private get maxNotional(): number {
    return envNum('REAL_MAX_NOTIONAL_USD', 5000)
  }

  private isRealEnabled(): boolean {
    return envBool('ENABLE_REAL_EXECUTION', false)
  }

  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10)
  }

  private async dispatchAllowed(): Promise<boolean> {
    if (!this.isRealEnabled()) return false
    const state = await this.stateRepo.read()
    return !state.paused
  }

  private async checkAndUpdateDailyLoss(lossDelta: number): Promise<void> {
    const state = await this.stateRepo.read()
    const today = this.todayUtc()
    let dailyLoss = state.dailyLossDayUtc === today ? state.dailyLossUsd : 0
    dailyLoss += lossDelta
    if (dailyLoss > this.maxDailyLoss) {
      await this.stateRepo.write({
        paused: true,
        pauseReason: `daily loss cap hit: $${dailyLoss.toFixed(2)} > $${this.maxDailyLoss}`,
        dailyLossUsd: dailyLoss,
        dailyLossDayUtc: today,
      })
      throw new Error(
        `Real-execution paused: daily loss $${dailyLoss.toFixed(2)} exceeds cap $${this.maxDailyLoss}`,
      )
    }
    await this.stateRepo.write({ dailyLossUsd: dailyLoss, dailyLossDayUtc: today })
  }

  private async clobPost(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload)
    const headers = buildL2Headers(
      'POST',
      path,
      body,
      this.walletAddress,
      this.apiSecret,
      this.apiPassphrase,
    )
    const res = await fetch(`${CLOB_BASE}${path}`, { method: 'POST', headers, body })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`CLOB POST ${path} → ${res.status}: ${text}`)
    }
    return (await res.json()) as Record<string, unknown>
  }

  private async clobDelete(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload)
    const headers = buildL2Headers(
      'DELETE',
      path,
      body,
      this.walletAddress,
      this.apiSecret,
      this.apiPassphrase,
    )
    const res = await fetch(`${CLOB_BASE}${path}`, { method: 'DELETE', headers, body })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`CLOB DELETE ${path} → ${res.status}: ${text}`)
    }
    return (await res.json()) as Record<string, unknown>
  }

  async onOrderPlaced(evt: OrderPlacedEvent): Promise<void> {
    const { decisionId, paperOrder } = evt
    const postedAt = paperOrder.postedAt
    const notional = paperOrder.price * paperOrder.size
    const dispatch = await this.dispatchAllowed()

    let clobOrderId = `real-${paperOrder.id}`
    let status: RealOrderRow['status'] = dispatch ? 'pending' : 'skipped'
    let rejectReason: string | null = null

    if (dispatch && notional > this.maxNotional) {
      status = 'rejected'
      rejectReason = `notional $${notional} > max $${this.maxNotional}`
      this.logger.warn(`onOrderPlaced rejected: ${rejectReason} (decision ${decisionId})`)
    } else if (dispatch) {
      try {
        const resp = await this.clobPost('/order', {
          tokenID: paperOrder.tokenId,
          price: paperOrder.price,
          side: paperOrder.side === 'bid' ? 'BUY' : 'SELL',
          size: paperOrder.size,
          type: 'LIMIT',
          feeRateBps: '0',
          expiration: '0',
          nonce: '0',
        })
        clobOrderId = String(resp['orderID'] ?? resp['id'] ?? clobOrderId)
        status = 'accepted'
        this.logger.log(`CLOB order placed: ${clobOrderId} (decision ${decisionId})`)
      } catch (err) {
        rejectReason = err instanceof Error ? err.message : String(err)
        status = 'rejected'
        this.logger.error(`CLOB placeOrder failed: ${rejectReason}`)
      }
    }

    await this.orderRepo.insert({
      id: clobOrderId,
      decisionId,
      paperOrderId: paperOrder.id,
      conditionId: paperOrder.conditionId,
      tokenId: paperOrder.tokenId,
      outcome: paperOrder.outcome,
      side: paperOrder.side,
      price: paperOrder.price,
      size: paperOrder.size,
      status,
      rejectReason,
      postedAt,
      closedAt: null,
      txHash: null,
    })
  }

  async onOrderCancelled(evt: OrderCancelledEvent): Promise<void> {
    const { paperOrderId, at } = evt
    const real = await this.orderRepo.findByPaperId(paperOrderId)
    if (!real) return

    const dispatch = await this.dispatchAllowed()
    if (!dispatch || real.status === 'skipped' || real.status === 'rejected') {
      await this.orderRepo.updateStatusByPaperId(paperOrderId, 'cancelled', at)
      return
    }

    try {
      await this.clobDelete('/order', { orderID: real.id })
      await this.orderRepo.updateStatusByPaperId(paperOrderId, 'cancelled', at)
      this.logger.log(`CLOB order cancelled: ${real.id}`)
    } catch (err) {
      this.logger.error(
        `CLOB cancelOrder failed for ${real.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async onOrderFilled(evt: OrderFilledEvent): Promise<void> {
    const { decisionId, paperFill, hedgeSide, hedgeExpectedPrice, hedgeFillPrice, tokenId } =
      evt
    const filledAt = paperFill.filledAt
    const dispatch = await this.dispatchAllowed()
    const realFillId = `rfill-${paperFill.id}`

    let hedgeOrderId: string | null = null
    let actualHedgePrice = hedgeFillPrice
    let hedgeStatus: RealFillRow['hedgeStatus'] = dispatch ? 'pending' : 'pending'
    let txHash: string | null = null

    if (dispatch) {
      const notional = hedgeFillPrice * paperFill.size
      if (notional > this.maxNotional) {
        hedgeStatus = 'failed'
        this.logger.warn(
          `onOrderFilled hedge rejected: notional $${notional} > max $${this.maxNotional}`,
        )
      } else {
        try {
          const resp = await this.clobPost('/order', {
            tokenID: tokenId,
            price: hedgeFillPrice,
            side: hedgeSide === 'buy' ? 'BUY' : 'SELL',
            size: paperFill.size,
            type: 'MARKET',
            feeRateBps: '0',
            expiration: '0',
            nonce: '0',
          })
          hedgeOrderId = String(resp['orderID'] ?? resp['id'] ?? realFillId)
          if (typeof resp['price'] === 'number') {
            actualHedgePrice = resp['price'] as number
          }
          if (typeof resp['transactionHash'] === 'string') {
            txHash = resp['transactionHash'] as string
          }
          hedgeStatus = 'done'
          this.logger.log(`CLOB hedge filled: ${hedgeOrderId} @ ${actualHedgePrice}`)
        } catch (err) {
          hedgeStatus = 'failed'
          this.logger.error(
            `CLOB marketHedge failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }

    await this.fillRepo.insert({
      id: realFillId,
      decisionId: decisionId ?? `unknown-${filledAt}`,
      paperFillId: paperFill.id,
      realOrderId: hedgeOrderId ?? realFillId,
      conditionId: paperFill.conditionId,
      question: paperFill.question,
      side: paperFill.side,
      fillPrice: actualHedgePrice,
      size: paperFill.size,
      hedgePrice: hedgeExpectedPrice,
      realisedPnlUsd: 0,
      makerFeeUsd: paperFill.makerFeeUsd,
      takerFeeUsd: paperFill.takerFeeUsd,
      filledAt,
      hedgeOrderId,
      hedgeStatus,
      txHash,
    })

    if (dispatch && hedgeStatus !== 'pending') {
      const slippageUsd = Math.abs(actualHedgePrice - hedgeExpectedPrice) * paperFill.size
      try {
        await this.checkAndUpdateDailyLoss(slippageUsd)
      } catch (capErr) {
        this.logger.warn(
          `Daily loss cap: ${capErr instanceof Error ? capErr.message : String(capErr)}`,
        )
      }
    }
  }
}
