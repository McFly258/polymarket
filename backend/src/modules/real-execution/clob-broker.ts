import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import { ClobClient, Chain, AssetType, OrderType, Side } from '@polymarket/clob-client'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'

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

// ClobBroker — real-execution bridge driven by post-persist engine events.
// All methods are no-ops unless ENABLE_REAL_EXECUTION=true AND state.paused=false.
// Every call persists to the real_* tables, so paper↔real joins via decisionId
// work even when dispatch is disabled (real rows are recorded as 'skipped').
export interface BalanceSnapshot {
  balanceUsdc: number
  allowances: Record<string, number>
  checkedAt: number
}

@Injectable()
export class ClobBroker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ClobBroker.name)
  private _client: ClobClient | null = null
  private _balanceTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly orderRepo: RealOrderRepo,
    private readonly fillRepo: RealFillRepo,
    private readonly stateRepo: RealStateRepo,
  ) {}

  onModuleInit(): void {
    if (!this.isRealEnabled()) return
    const missing: string[] = []
    if (!this.walletPrivateKey) missing.push('CLOB_WALLET_PRIVATE_KEY')
    if (!this.apiKey) missing.push('CLOB_API_KEY')
    if (!this.apiSecret) missing.push('CLOB_API_SECRET')
    if (!this.apiPassphrase) missing.push('CLOB_API_PASSPHRASE')
    if (missing.length > 0) {
      throw new Error(
        `ENABLE_REAL_EXECUTION=true but required env vars are missing: ${missing.join(', ')}`,
      )
    }
    this.logger.log('Real execution enabled — credentials verified at startup')
    this._balanceTimer = setInterval(() => {
      void this.checkBalance().catch((err) => {
        this.logger.warn(
          `balance check failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }, this.balanceCheckIntervalMs)
    this.logger.log(
      `Balance watch armed — checking every ${this.balanceCheckIntervalMs / 1000}s, min $${this.minBalanceUsdc}`,
    )
  }

  onApplicationShutdown(): void {
    if (this._balanceTimer) {
      clearInterval(this._balanceTimer)
      this._balanceTimer = null
    }
  }

  private get walletPrivateKey(): string {
    return env('CLOB_WALLET_PRIVATE_KEY', '')
  }
  private get apiKey(): string {
    return env('CLOB_API_KEY', '')
  }
  private get apiSecret(): string {
    return env('CLOB_API_SECRET', '')
  }
  private get apiPassphrase(): string {
    return env('CLOB_API_PASSPHRASE', '')
  }
  private get maxDailyLoss(): number {
    return envNum('REAL_MAX_DAILY_LOSS_USD', 100)
  }
  private get maxNotional(): number {
    return envNum('REAL_MAX_NOTIONAL_USD', 5000)
  }
  private get minBalanceUsdc(): number {
    return envNum('REAL_MIN_BALANCE_USD', 10)
  }
  private get balanceCheckIntervalMs(): number {
    return envNum('REAL_BALANCE_CHECK_INTERVAL_MS', 300_000)
  }
  // Polymarket signature type: 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE.
  // Default 2 because deposits via the Polymarket UI / MetaMask park USDC in a
  // Gnosis Safe controlled by the EOA, not the EOA itself.
  private get polySignatureType(): number {
    return envNum('POLY_SIGNATURE_TYPE', 2)
  }
  private get funderAddress(): string | undefined {
    return env('CLOB_FUNDER_ADDRESS', '') || undefined
  }

  private isRealEnabled(): boolean {
    return envBool('ENABLE_REAL_EXECUTION', false)
  }

  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10)
  }

  // Lazily constructs the SDK client on first dispatch. Throws if private key
  // is missing — caller is responsible for only calling this when dispatch is
  // allowed (i.e. isRealEnabled() === true).
  private getClient(): ClobClient {
    if (this._client) return this._client
    const pk = this.walletPrivateKey
    if (!pk) {
      throw new Error(
        'CLOB_WALLET_PRIVATE_KEY is required when ENABLE_REAL_EXECUTION=true',
      )
    }
    const account = privateKeyToAccount(pk as `0x${string}`)
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    })
    this._client = new ClobClient(
      CLOB_BASE,
      Chain.POLYGON,
      walletClient,
      { key: this.apiKey, secret: this.apiSecret, passphrase: this.apiPassphrase },
      this.polySignatureType,
      this.funderAddress,
    )
    return this._client
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

  async getBalance(): Promise<BalanceSnapshot> {
    // USDC has 6 decimals; CLOB returns raw integer strings.
    const USDC_DECIMALS = 1_000_000
    const raw = (await this.getClient().getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
      signature_type: this.polySignatureType,
    } as unknown as { asset_type: AssetType })) as unknown as Record<string, unknown>
    const balanceUsdc = Number(raw['balance'] ?? 0) / USDC_DECIMALS
    const rawAllowances = (raw['allowances'] ?? {}) as Record<string, unknown>
    const allowances: Record<string, number> = {}
    for (const [addr, val] of Object.entries(rawAllowances)) {
      allowances[addr] = Number(val) / USDC_DECIMALS
    }
    return { balanceUsdc, allowances, checkedAt: Date.now() }
  }

  private async checkBalance(): Promise<void> {
    const state = await this.stateRepo.read()
    if (state.paused) return
    const { balanceUsdc } = await this.getBalance()
    if (balanceUsdc < this.minBalanceUsdc) {
      const reason = `balance too low: $${balanceUsdc.toFixed(2)} < min $${this.minBalanceUsdc}`
      this.logger.warn(`Auto-pausing real execution: ${reason}`)
      await this.stateRepo.write({ paused: true, pauseReason: reason })
    } else {
      this.logger.debug(`Balance OK: $${balanceUsdc.toFixed(2)} USDC`)
    }
  }

  // Public GET helpers exposed for the reconciler. Only called when real
  // execution is enabled (reconciler short-circuits otherwise).
  async fetchOrder(orderId: string): Promise<Record<string, unknown>> {
    const order = await this.getClient().getOrder(orderId)
    return order as unknown as Record<string, unknown>
  }

  async fetchTrades(sinceMs: number): Promise<Array<Record<string, unknown>>> {
    const client = this.getClient()
    // We pass a viem WalletClient which has no getAddress(); derive address from
    // the private key directly — same key used to create the client.
    const pk = this.walletPrivateKey
    const makerAddress = pk ? privateKeyToAccount(pk as `0x${string}`).address : undefined
    const trades = await client.getTrades({
      maker_address: makerAddress,
      after: Math.floor(sinceMs / 1000).toString(),
    })
    // Normalize SDK Trade shape → reconciler-compatible shape.
    // SDK uses match_time (ISO string) and maker_orders[]; reconciler expects
    // timestamp (unix seconds), order_id, maker_order_id, token_id.
    return trades.map((t) => ({
      ...(t as unknown as Record<string, unknown>),
      timestamp: Math.floor(new Date(t.match_time).getTime() / 1000),
      token_id: t.asset_id,
      order_id: t.maker_orders?.[0]?.order_id ?? null,
      maker_order_id: t.maker_orders?.[0]?.order_id ?? null,
    }))
  }

  isEnabled(): boolean {
    return this.isRealEnabled()
  }

  async onOrderPlaced(evt: OrderPlacedEvent): Promise<void> {
    const { decisionId, paperOrder, noTokenId } = evt
    const postedAt = paperOrder.postedAt
    // Ask-side orders are flipped to buy-NO when noTokenId is available:
    // sell YES @ P ≡ buy NO @ (1-P) — both require only USDC, no inventory.
    const useNoBuy = paperOrder.side === 'ask' && !!noTokenId
    const realTokenId = useNoBuy ? noTokenId! : paperOrder.tokenId
    const realSide = useNoBuy ? Side.BUY : (paperOrder.side === 'bid' ? Side.BUY : Side.SELL)
    const realPrice = useNoBuy ? 1 - paperOrder.price : paperOrder.price
    const notional = realPrice * paperOrder.size
    const dispatch = await this.dispatchAllowed()

    let clobOrderId = `real-${paperOrder.id}`
    let status: RealOrderRow['status'] = dispatch ? 'pending' : 'skipped'
    let rejectReason: string | null = null

    const CLOB_MIN_SIZE = 5
    if (dispatch && paperOrder.size < CLOB_MIN_SIZE) {
      status = 'rejected'
      rejectReason = `size ${paperOrder.size} < CLOB minimum ${CLOB_MIN_SIZE}`
      this.logger.warn(`onOrderPlaced rejected: ${rejectReason} (decision ${decisionId})`)
    } else if (dispatch && notional > this.maxNotional) {
      status = 'rejected'
      rejectReason = `notional $${notional} > max $${this.maxNotional}`
      this.logger.warn(`onOrderPlaced rejected: ${rejectReason} (decision ${decisionId})`)
    } else if (dispatch) {
      try {
        const resp = await this.getClient().createAndPostOrder(
          {
            tokenID: realTokenId,
            price: realPrice,
            size: paperOrder.size,
            side: realSide,
          },
          undefined,
          OrderType.GTC,
        )
        const r = resp as Record<string, unknown>
        if (!r['success']) {
          throw new Error(String(r['errorMsg'] ?? r['error'] ?? 'Polymarket rejected order'))
        }
        const rawId = r['orderID'] ?? r['order_id'] ?? r['id']
        if (!rawId) {
          throw new Error(`CLOB accepted order but returned no order ID (resp: ${JSON.stringify(r)})`)
        }
        clobOrderId = String(rawId)
        status = 'accepted'
        const label = useNoBuy ? `buy-NO @ ${realPrice.toFixed(3)}` : `${paperOrder.side} @ ${realPrice.toFixed(3)}`
        this.logger.log(`CLOB order placed: ${clobOrderId} [${label}] (decision ${decisionId})`)
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
      filledSize: 0,
      status,
      rejectReason,
      postedAt,
      closedAt: null,
      txHash: null,
      lastReconciledAt: null,
      discrepancy: null,
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
      await this.getClient().cancelOrder({ orderID: real.id })
      await this.orderRepo.updateStatusByPaperId(paperOrderId, 'cancelled', at)
      this.logger.log(`CLOB order cancelled: ${real.id}`)
    } catch (err) {
      this.logger.error(
        `CLOB cancelOrder failed for ${real.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async onOrderFilled(evt: OrderFilledEvent): Promise<void> {
    const {
      decisionId,
      paperFill,
      hedgeSide,
      hedgeExpectedPrice,
      hedgeFillPrice,
      tokenId,
      noTokenId,
      isPassiveHedge,
    } = evt
    const filledAt = paperFill.filledAt
    const dispatch = await this.dispatchAllowed()
    const realFillId = `rfill-${paperFill.id}`

    let hedgeOrderId: string | null = null
    let actualHedgePrice = hedgeFillPrice
    let hedgeStatus: RealFillRow['hedgeStatus']
    let txHash: string | null = null

    if (isPassiveHedge) {
      // Paper decided the fill was un-hedgeable (slip > cap). The real side must
      // mirror that decision — blasting a market order here would take unbounded
      // slippage and break the paper↔real comparison.
      hedgeStatus = 'skipped'
      this.logger.log(
        `Passive hedge mirrored (decision ${decisionId}) — no real hedge dispatched`,
      )
    } else if (!dispatch) {
      hedgeStatus = 'skipped'
    } else {
      hedgeStatus = 'pending'
      // Ask-side fills: the real position is buy-NO, so unwind by selling NO.
      // sell YES @ P (paper hedge buy) ≡ sell NO @ (1-P) (real unwind).
      const useNoSell = hedgeSide === 'buy' && !!noTokenId
      const realTokenId = useNoSell ? noTokenId! : tokenId
      const realHedgeSide = useNoSell ? Side.SELL : (hedgeSide === 'buy' ? Side.BUY : Side.SELL)
      const realHedgePrice = useNoSell ? 1 - hedgeFillPrice : hedgeFillPrice
      const notional = realHedgePrice * paperFill.size
      if (notional > this.maxNotional) {
        hedgeStatus = 'failed'
        this.logger.warn(
          `onOrderFilled hedge rejected: notional $${notional} > max $${this.maxNotional}`,
        )
      } else {
        try {
          // SDK semantics: BUY amount = USDC to spend; SELL amount = shares to sell.
          const hedgeAmount =
            realHedgeSide === Side.BUY
              ? realHedgePrice * paperFill.size
              : paperFill.size
          const resp = await this.getClient().createAndPostMarketOrder(
            {
              tokenID: realTokenId,
              amount: hedgeAmount,
              side: realHedgeSide,
              price: realHedgePrice,
            },
            undefined,
            OrderType.FOK,
          )
          const r = resp as Record<string, unknown>
          if (!r['success']) {
            throw new Error(String(r['errorMsg'] ?? r['error'] ?? 'Polymarket rejected hedge'))
          }
          hedgeOrderId = String(r['orderID'] ?? r['id'] ?? realFillId)
          if (typeof r['price'] === 'number') {
            actualHedgePrice = r['price'] as number
          } else if (typeof r['avgPrice'] === 'number') {
            actualHedgePrice = r['avgPrice'] as number
          }
          // API returns transactionsHashes (plural, array)
          const hashes = r['transactionsHashes'] as string[] | undefined
          txHash = hashes?.[0] ?? null
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
      clobTradeId: null,
      source: 'paper',
    })

    if (dispatch && hedgeStatus === 'done') {
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
