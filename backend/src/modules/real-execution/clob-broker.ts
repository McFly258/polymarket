import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import { ClobClient, Chain, AssetType, OrderType, Side } from '@polymarket/clob-client-v2'
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
const CLOB_MIN_SIZE = 5

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
  private _eoaclient: ClobClient | null = null
  private _balanceTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly orderRepo: RealOrderRepo,
    private readonly fillRepo: RealFillRepo,
    private readonly stateRepo: RealStateRepo,
  ) {}

  async onModuleInit(): Promise<void> {
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
    // Clear any persisted pause from the previous run so restarts always start unpaused.
    await this.stateRepo.write({ paused: false, pauseReason: null })
    this.logger.log('Real execution enabled — credentials verified at startup, pause state cleared')

    // Pre-flight: clean slate before the engine resumes. This guards against
    // stale orders / dangling inventory from a previous run (or a SIGKILL that
    // bypassed the shutdown hook). Engine modules import after this one, so
    // their onModuleInit fires only after these awaits resolve.
    this.logger.log('Startup: cancelling all CLOB orders and liquidating inventory...')
    await this.cancelAllOpenOrders('Startup').catch((err) =>
      this.logger.error(
        `Startup cancel failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
    await this.liquidateAllInventory('Startup').catch((err) =>
      this.logger.error(
        `Startup liquidate failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
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

  async onApplicationShutdown(): Promise<void> {
    if (this._balanceTimer) {
      clearInterval(this._balanceTimer)
      this._balanceTimer = null
    }
    if (!this.isRealEnabled()) return
    this.logger.log('Shutdown: cancelling all CLOB orders and liquidating inventory...')
    await this.cancelAllOpenOrders('Shutdown').catch((err) =>
      this.logger.error(
        `Shutdown cancel failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
    await this.liquidateAllInventory('Shutdown').catch((err) =>
      this.logger.error(
        `Shutdown liquidate failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
  }

  private async cancelAllOpenOrders(phase: 'Startup' | 'Shutdown'): Promise<void> {
    const client = this.getClient()
    const openOrders = (await client.getOpenOrders({})) as unknown as Array<Record<string, unknown>>
    if (!openOrders.length) {
      this.logger.log(`${phase}: no open orders on CLOB`)
    } else {
      this.logger.log(`${phase}: cancelling ${openOrders.length} order(s)`)
      await client.cancelAll()
      this.logger.log(`${phase}: all CLOB orders cancelled`)
    }
    // Mark DB-tracked open orders as cancelled so they don't linger as stale.
    const dbOpen = await this.orderRepo.readOpen()
    const now = Date.now()
    for (const o of dbOpen) {
      await this.orderRepo.patchReconcile(o.id, {
        status: 'cancelled',
        closedAt: now,
        lastReconciledAt: now,
      })
    }
  }

  private async liquidateAllInventory(phase: 'Startup' | 'Shutdown'): Promise<void> {
    const pk = this.walletPrivateKey
    const eoa = pk ? privateKeyToAccount(pk as `0x${string}`).address : undefined
    const userAddress = this.funderAddress ?? eoa
    if (!userAddress) return

    // Polymarket CLOB rejects orders smaller than 5 shares, so positions below
    // that threshold are unliquidatable dust. We surface them once then exclude
    // them from the work list so the retry loop can converge.
    const dustLogged = new Set<string>()
    // Tokens where Polymarket returned balance=0 — the data-API position record
    // is stale; the on-chain wallet holds nothing. Retrying is pointless.
    const ghostTokens = new Set<string>()

    const fetchHeld = async (): Promise<Array<Record<string, unknown>>> => {
      const r = await fetch(
        `https://data-api.polymarket.com/positions?user=${userAddress}&sizeThreshold=0.01`,
      )
      if (!r.ok) {
        this.logger.warn(`${phase}: positions fetch failed (${r.status})`)
        return []
      }
      const positions = (await r.json()) as Array<Record<string, unknown>>
      const live = positions.filter((p) => Number(p['size'] ?? 0) > 0.01)
      const sellable: Array<Record<string, unknown>> = []
      for (const p of live) {
        const tokenId = String(p['asset_id'] ?? p['token_id'] ?? p['asset'] ?? '')
        if (ghostTokens.has(tokenId)) continue
        const size = Number(p['size'] ?? 0)
        if (size < CLOB_MIN_SIZE) {
          if (tokenId && !dustLogged.has(tokenId)) {
            dustLogged.add(tokenId)
            this.logger.warn(
              `${phase}: dust position ${tokenId.slice(0, 8)} size=${size} below CLOB minimum (${CLOB_MIN_SIZE}) — cannot liquidate via orderbook, skipping`,
            )
          }
          continue
        }
        sellable.push(p)
      }
      return sellable
    }

    const sellPosition = async (
      pos: Record<string, unknown>,
      attempt: number,
    ): Promise<void> => {
      const tokenId = String(pos['asset_id'] ?? pos['token_id'] ?? pos['asset'] ?? '')
      const size = Number(pos['size'] ?? 0)
      const curPrice = Number(pos['curPrice'] ?? pos['price'] ?? 0.5)
      if (!tokenId || size < 0.01) {
        this.logger.warn(`${phase}: skipping position — missing tokenId or size too small (size=${size})`)
        return
      }
      // Walk the limit price down 1 cent per attempt — improves FOK fill probability
      // without resorting to GTC (which can partially fill and leave sub-minimum residuals).
      const limitPrice = Math.max(curPrice - 0.01 * attempt, 0.01)
      try {
        // On retries, cancel any existing open orders for this token first
        if (attempt > 1) {
          const openOrders = (await this.getClient().getOpenOrders({ asset_id: tokenId })) as unknown as Array<Record<string, unknown>>
          if (openOrders.length) {
            const ids = openOrders.map((o) => String(o['id'] ?? o['order_id'] ?? '')).filter(Boolean)
            if (ids.length) {
              await this.getClient().cancelOrders(ids)
              this.logger.log(`${phase} sell ${tokenId.slice(0, 8)}: cancelled ${ids.length} stale order(s) before retry`)
            }
          }
        }
        const r = (await this.getClient().createAndPostMarketOrder(
          { tokenID: tokenId, amount: size, side: Side.SELL, price: limitPrice },
          undefined,
          OrderType.FOK,
        )) as Record<string, unknown>
        // FOK-only: no GTC fallback. GTC partial fills can leave sub-minimum residuals
        // that are permanently unliquidatable. If FOK fails, the retry loop will attempt
        // again with a lower price until the position clears or retries are exhausted.
        if (!r['success']) {
          const errMsg = String(r['errorMsg'] ?? r['error'] ?? 'unknown')
          // "balance: 0" means the data-API entry is stale — the wallet genuinely
          // holds zero shares. Retrying will never succeed; mark as ghost and skip.
          if (/balance:\s*0[^.0-9]/i.test(errMsg)) {
            ghostTokens.add(tokenId)
            this.logger.warn(
              `${phase} sell ${tokenId.slice(0, 8)}: wallet balance is 0 — stale data-API record (ghost position), skipping retries`,
            )
          } else {
            this.logger.log(
              `${phase} sell ${tokenId.slice(0, 8)}${attempt > 1 ? ` (attempt ${attempt}, limit ${limitPrice.toFixed(3)})` : ''}: FOK failed — ${errMsg} (will retry)`,
            )
          }
        } else {
          this.logger.log(
            `${phase} sell ${tokenId.slice(0, 8)}${attempt > 1 ? ` (attempt ${attempt}, limit ${limitPrice.toFixed(3)})` : ''}: done`,
          )
        }
      } catch (err) {
        this.logger.error(
          `${phase} liquidate ${tokenId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const held = await fetchHeld()
    if (!held.length) {
      this.logger.log(`${phase}: no inventory to liquidate`)
      return
    }
    this.logger.log(`${phase}: liquidating ${held.length} position(s)`)
    for (const pos of held) await sellPosition(pos, 1)

    // Retry loop: re-check for partial fills and re-post for any remaining shares
    const MAX_RETRIES = 5
    const RETRY_DELAY_MS = 10_000
    for (let attempt = 2; attempt <= MAX_RETRIES + 1; attempt++) {
      await new Promise((res) => setTimeout(res, RETRY_DELAY_MS))
      const remaining = await fetchHeld()
      if (!remaining.length) {
        this.logger.log(`${phase}: all positions liquidated`)
        return
      }
      this.logger.warn(`${phase}: ${remaining.length} position(s) still remain (attempt ${attempt}), re-posting sell orders`)
      for (const pos of remaining) await sellPosition(pos, attempt)
    }
    const stillRemaining = await fetchHeld()
    if (stillRemaining.length) {
      this.logger.warn(`${phase}: ${stillRemaining.length} position(s) still remain after all retries — manual intervention may be needed`)
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
    return envNum('REAL_MAX_NOTIONAL_USD', 10)
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
    this._client = new ClobClient({
      host: CLOB_BASE,
      chain: Chain.POLYGON,
      signer: walletClient,
      creds: { key: this.apiKey, secret: this.apiSecret, passphrase: this.apiPassphrase },
      signatureType: this.polySignatureType,
      funderAddress: this.funderAddress,
    })
    return this._client
  }

  // EOA client (signatureType=0): maker == signer == EOA. Used as a fallback
  // when the primary proxy client reports "not enough balance" — happens for
  // source='paper' fills where the original BUY was placed without a proxy, so
  // YES tokens landed in the signer EOA rather than the Gnosis Safe.
  private getEoaClient(): ClobClient {
    if (this._eoaclient) return this._eoaclient
    const pk = this.walletPrivateKey
    if (!pk) throw new Error('CLOB_WALLET_PRIVATE_KEY required')
    const account = privateKeyToAccount(pk as `0x${string}`)
    const walletClient = createWalletClient({ account, chain: polygon, transport: http() })
    this._eoaclient = new ClobClient({
      host: CLOB_BASE,
      chain: Chain.POLYGON,
      signer: walletClient,
      creds: { key: this.apiKey, secret: this.apiSecret, passphrase: this.apiPassphrase },
      signatureType: 0,
    })
    return this._eoaclient
  }

  private async dispatchAllowed(): Promise<boolean> {
    if (!this.isRealEnabled()) return false
    const state = await this.stateRepo.read()
    return !state.paused
  }

  // Hedge retries are token sells — they don't spend USDC, so the low-balance
  // pause should not block them. We only gate on ENABLE_REAL_EXECUTION.
  private hedgeRetryAllowed(): boolean {
    return this.isRealEnabled()
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
    // Polymarket sigType=2 records the funder (proxy wallet) as maker_address on
    // trades, not the EOA derived from the private key. Filtering by EOA returns
    // zero rows. Prefer the configured funder; fall back to the EOA only when
    // running without a proxy (sigType=0).
    const pk = this.walletPrivateKey
    const eoa = pk ? privateKeyToAccount(pk as `0x${string}`).address : undefined
    const userAddress = this.funderAddress ?? eoa

    // CLOB SDK getTrades only filters by maker_address, so it misses trades where
    // we were the taker (e.g. FOK closes). Combine SDK results (rich fields,
    // CLOB trade IDs) with the data-api /trades endpoint (covers maker AND
    // taker via proxyWallet). Dedup by transaction_hash + asset.
    const sdkTradesRaw = await client
      .getTrades({
        maker_address: userAddress,
        after: Math.floor(sinceMs / 1000).toString(),
      })
      .catch((err) => {
        this.logger.warn(
          `SDK getTrades failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return []
      })
    const sdkTrades: Array<Record<string, unknown>> = sdkTradesRaw.map((t) => ({
      ...(t as unknown as Record<string, unknown>),
      timestamp: Math.floor(new Date(t.match_time).getTime() / 1000),
      token_id: t.asset_id,
      order_id: t.maker_orders?.[0]?.order_id ?? null,
      maker_order_id: t.maker_orders?.[0]?.order_id ?? null,
    }))

    const dataApiTrades = userAddress
      ? await this.fetchDataApiTrades(userAddress, sinceMs).catch((err) => {
          this.logger.warn(
            `data-api fetchTrades failed: ${err instanceof Error ? err.message : String(err)}`,
          )
          return [] as Array<Record<string, unknown>>
        })
      : []

    // Dedup using (transaction_hash + asset_id) — same on-chain settlement of
    // the same outcome token is the same trade regardless of which source
    // returned it. SDK results win when present (they carry the canonical CLOB
    // trade id used elsewhere).
    const seen = new Set<string>()
    const merged: Array<Record<string, unknown>> = []
    for (const t of [...sdkTrades, ...dataApiTrades]) {
      const tx = asString(t['transaction_hash'])
      const asset = asString(t['asset_id']) ?? asString(t['token_id'])
      const key = tx && asset ? `${tx}:${asset}` : asString(t['id']) ?? asString(t['trade_id'])
      if (!key) continue
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(t)
    }
    return merged
  }

  // Pulls trades for a wallet from data-api (covers both maker and taker
  // sides). Used to complement the CLOB SDK which only filters by maker.
  // Uses /activity?type=TRADE instead of /trades because /trades only returns
  // SELL-side (maker) fills — BUY fills as taker are invisible to it.
  // Normalizes the data-api shape into the reconciler-expected fields.
  private async fetchDataApiTrades(
    userAddress: string,
    _sinceMs: number,
  ): Promise<Array<Record<string, unknown>>> {
    const url = `https://data-api.polymarket.com/activity?user=${userAddress}&type=TRADE&limit=500`
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`data-api ${resp.status}`)
    const raw = (await resp.json()) as Array<Record<string, unknown>>
    const out: Array<Record<string, unknown>> = []
    for (const r of raw) {
      const ts = asNumber(r['timestamp'])
      if (ts === null) continue
      // Do not filter by sinceMs here — data-api indexing lag can exceed the
      // cursor window and cause fills to be permanently missed. The
      // clob_trade_id UNIQUE constraint in real_fills handles dedup.
      const tx = asString(r['transactionHash'])
      const asset = asString(r['asset'])
      // Synthetic trade id keyed on the on-chain settlement so dedup works
      // against the unique constraint on real_fills.clob_trade_id.
      const id = tx && asset ? `tx-${tx}-${asset}` : tx ? `tx-${tx}` : null
      if (!id) continue
      out.push({
        id,
        trade_id: id,
        transaction_hash: tx,
        timestamp: ts,
        price: r['price'],
        size: r['size'],
        side: asString(r['side'])?.toLowerCase() ?? null,
        asset_id: asset,
        token_id: asset,
        market: r['conditionId'] ?? null,
      })
    }
    return out
  }

  isEnabled(): boolean {
    return this.isRealEnabled()
  }

  async getTodayEarnings(): Promise<{ totalUsd: number; date: string }> {
    const today = new Date().toISOString().slice(0, 10)
    try {
      const rows = await this.getClient().getTotalEarningsForUserForDay(today)
      const totalUsd = rows.reduce((sum, row) => sum + (isFinite(row.earnings) ? row.earnings : 0), 0)
      return { totalUsd, date: today }
    } catch (err) {
      this.logger.warn(`getTodayEarnings failed: ${(err as Error).message}`)
      return { totalUsd: 0, date: today }
    }
  }

  // Looks up the NO-outcome token for a condition so hedge retries can close
  // ask-side positions (which were opened as buy-NO in real execution).
  async getNoTokenId(conditionId: string, yesTokenId: string): Promise<string | null> {
    try {
      const resp = await fetch(`${CLOB_BASE}/markets/${conditionId}`)
      if (!resp.ok) return null
      const market = (await resp.json()) as {
        tokens?: Array<{ token_id: string; outcome: string }>
      }
      const noToken = market.tokens?.find(
        (t) => t.token_id !== yesTokenId && t.outcome?.toLowerCase() === 'no',
      )
      return noToken?.token_id ?? null
    } catch {
      return null
    }
  }

  // Fetches the actual on-chain token position (size + current price) from the
  // positions API. Used to trim hedge sell amounts and price post-cancel sells.
  // fill.size can exceed actual balance due to CLOB rounding/fees.
  private async fetchPositionData(tokenId: string): Promise<{ size: number; price: number } | null> {
    const pk = this.walletPrivateKey
    const eoa = pk ? privateKeyToAccount(pk as `0x${string}`).address : undefined
    const userAddress = this.funderAddress ?? eoa
    if (!userAddress) return null
    try {
      const resp = await fetch(
        `https://data-api.polymarket.com/positions?user=${userAddress}&sizeThreshold=0`,
      )
      if (!resp.ok) return null
      const positions = (await resp.json()) as Array<Record<string, unknown>>
      const pos = positions.find(
        (p) => String(p['asset_id'] ?? p['token_id'] ?? '') === tokenId,
      )
      if (!pos) return { size: 0, price: 0.5 }
      return {
        size: Number(pos['size'] ?? 0),
        price: Number(pos['curPrice'] ?? pos['price'] ?? 0.5),
      }
    } catch {
      return null
    }
  }

  // Dispatches a closing sell for a fill whose hedge was previously skipped or
  // failed. Ask-side fills used buy-NO at order time, so we sell NO to close;
  // bid-side fills bought YES, so we sell YES. Both are token sells — no USDC
  // spending — which is why these can proceed even at low wallet balances.
  async retryHedge(fill: RealFillRow, tokenId: string, noTokenId?: string): Promise<void> {
    if (!this.hedgeRetryAllowed()) {
      this.logger.debug(`retryHedge: real execution disabled — fill ${fill.id} stays skipped`)
      return
    }

    const useNoSell = fill.side === 'ask' && !!noTokenId
    const realTokenId = useNoSell ? noTokenId! : tokenId
    const realHedgePrice = useNoSell ? 1 - fill.hedgePrice : fill.hedgePrice

    // Trim to actual wallet balance — fill.size can exceed tokens received due
    // to CLOB rounding/fees, causing "not enough balance" rejections on FOK.
    let hedgeAmount = fill.size
    const posData = await this.fetchPositionData(realTokenId)
    const actualBalance = posData?.size ?? null
    if (actualBalance !== null) {
      if (actualBalance <= 0) {
        this.logger.log(
          `retryHedge: fill ${fill.id} — token balance 0, position already cleared`,
        )
        await this.fillRepo.updateHedge(fill.id, null, 'done', null)
        return
      }
      if (actualBalance < hedgeAmount) {
        this.logger.log(
          `retryHedge: trimming fill ${fill.id} hedge ${hedgeAmount} → ${actualBalance} (actual wallet balance)`,
        )
        hedgeAmount = actualBalance
      }
    }

    if (hedgeAmount < CLOB_MIN_SIZE) {
      this.logger.warn(
        `retryHedge: fill ${fill.id} — balance ${hedgeAmount.toFixed(4)} below CLOB min (${CLOB_MIN_SIZE}), dust cannot be hedged — abandoning`,
      )
      await this.fillRepo.updateHedge(fill.id, null, 'abandoned', null)
      return
    }

    const notional = realHedgePrice * hedgeAmount

    if (notional > this.maxNotional) {
      this.logger.warn(
        `retryHedge: notional $${notional.toFixed(2)} > max — fill ${fill.id} skipped`,
      )
      throw new Error(`notional $${notional.toFixed(2)} > max`)
    }

    let hedgeOrderId: string | null = null
    let hedgeStatus: RealFillRow['hedgeStatus'] = 'failed'
    let txHash: string | null = null

    const orderParams = {
      tokenID: realTokenId,
      amount: hedgeAmount,
      side: Side.SELL,
      price: realHedgePrice,
    }

    const trySell = async (client: ClobClient): Promise<{ orderID: string; txHash: string | null }> => {
      const resp = await client.createAndPostMarketOrder(orderParams, undefined, OrderType.FOK)
      const r = resp as Record<string, unknown>
      if (!r['success']) {
        throw new Error(String(r['errorMsg'] ?? r['error'] ?? 'Polymarket rejected hedge retry'))
      }
      const hashes = r['transactionsHashes'] as string[] | undefined
      return {
        orderID: String(r['orderID'] ?? r['id'] ?? fill.id),
        txHash: hashes?.[0] ?? null,
      }
    }

    try {
      let result: { orderID: string; txHash: string | null }
      try {
        result = await trySell(this.getClient())
      } catch (proxyErr) {
        const msg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr)
        if (msg.includes('not enough balance') || msg.includes('not enough allowance')) {
          this.logger.warn(
            `retryHedge proxy balance insufficient for fill ${fill.id}, retrying via EOA client`,
          )
          result = await trySell(this.getEoaClient())
        } else {
          throw proxyErr
        }
      }
      hedgeOrderId = result.orderID
      txHash = result.txHash
      hedgeStatus = 'done'
      this.logger.log(`retryHedge done for fill ${fill.id}: hedge order ${hedgeOrderId}`)
    } catch (err) {
      this.logger.error(
        `retryHedge failed for fill ${fill.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      await this.fillRepo.updateHedge(fill.id, null, 'failed', null)
      throw err
    }

    await this.fillRepo.updateHedge(fill.id, hedgeOrderId, hedgeStatus, txHash)

    if (hedgeStatus === 'done') {
      const slippageUsd = Math.abs(realHedgePrice - fill.hedgePrice) * fill.size
      try {
        await this.checkAndUpdateDailyLoss(slippageUsd)
      } catch (capErr) {
        this.logger.warn(
          `Daily loss cap during hedge retry: ${capErr instanceof Error ? capErr.message : String(capErr)}`,
        )
      }
    }
  }

  async onOrderPlaced(evt: OrderPlacedEvent): Promise<void> {
    const { decisionId, paperOrder, noTokenId, rewardMinSize } = evt
    const postedAt = paperOrder.postedAt
    // Ask-side orders are flipped to buy-NO when noTokenId is available:
    // sell YES @ P ≡ buy NO @ (1-P) — both require only USDC, no inventory.
    const useNoBuy = paperOrder.side === 'ask' && !!noTokenId
    const realTokenId = useNoBuy ? noTokenId! : paperOrder.tokenId
    const realSide = useNoBuy ? Side.BUY : (paperOrder.side === 'bid' ? Side.BUY : Side.SELL)
    const realPrice = useNoBuy ? 1 - paperOrder.price : paperOrder.price
    const notional = realPrice * paperOrder.size
    const dispatch = await this.dispatchAllowed()

    let clobOrderId = `prepost-${paperOrder.id}`
    let status: RealOrderRow['status'] = dispatch ? 'pending' : 'skipped'
    let rejectReason: string | null = null
    let postedSize = paperOrder.size

    if (dispatch && paperOrder.size < CLOB_MIN_SIZE) {
      status = 'rejected'
      rejectReason = `size ${paperOrder.size} < CLOB minimum ${CLOB_MIN_SIZE}`
      this.logger.warn(`onOrderPlaced rejected: ${rejectReason} (decision ${decisionId})`)
    } else if (dispatch) {
      // Cap size to stay within maxNotional; only reject if that still leaves size < CLOB min
      let cappedSize = paperOrder.size
      if (notional > this.maxNotional) {
        cappedSize = Math.floor(this.maxNotional / realPrice)
        postedSize = cappedSize
        this.logger.log(`onOrderPlaced: size capped ${paperOrder.size}→${cappedSize} for notional cap (decision ${decisionId})`)
      }
      if (cappedSize < CLOB_MIN_SIZE) {
        status = 'rejected'
        rejectReason = `size ${cappedSize} < CLOB minimum ${CLOB_MIN_SIZE} after notional cap`
        this.logger.warn(`onOrderPlaced rejected: ${rejectReason} (decision ${decisionId})`)
      } else if (notional > this.maxNotional && cappedSize < rewardMinSize) {
        // Only block dead capital when the notional cap itself shrank the order below reward minimum.
        // If the paper engine natively sized below rewardMinSize, let it through — that's the engine's call.
        status = 'rejected'
        rejectReason = `size capped to ${cappedSize} < reward minimum ${rewardMinSize} — dead capital after cap`
        this.logger.warn(`onOrderPlaced rejected: ${rejectReason} (decision ${decisionId})`)
      } else {
        try {
          const resp = await this.getClient().createAndPostOrder(
            {
              tokenID: realTokenId,
              price: realPrice,
              size: cappedSize,
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
      size: postedSize,
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

    // GTC orders can accumulate partial fills before being cancelled. Sell any
    // residual tokens immediately so they don't build up as unliquidatable dust.
    await this.cleanupResidualAfterCancel(real).catch((err) =>
      this.logger.error(
        `Post-cancel cleanup ${real.id.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
  }

  // After a GTC order cancel, checks the wallet for any partially-filled tokens
  // and posts a GTC sell to clear them. Logs dust (< CLOB_MIN_SIZE) without
  // attempting to sell since the orderbook won't accept sub-minimum orders.
  private async cleanupResidualAfterCancel(order: RealOrderRow): Promise<void> {
    // ASK-side real orders bought NO tokens (sell YES ≡ buy NO). Resolve the NO
    // token ID so we can check and sell the right token.
    const useNoSell = order.side === 'ask'
    let tokenId: string
    if (useNoSell) {
      const noToken = await this.getNoTokenId(order.conditionId, order.tokenId)
      if (!noToken) {
        this.logger.warn(
          `Post-cancel cleanup ${order.id.slice(0, 10)}: cannot resolve NO token for ask residual — skipping`,
        )
        return
      }
      tokenId = noToken
    } else {
      tokenId = order.tokenId
    }
    if (!tokenId) return

    const pos = await this.fetchPositionData(tokenId)
    const size = pos?.size ?? 0
    if (size < 0.01) return

    if (size < CLOB_MIN_SIZE) {
      this.logger.warn(
        `Post-cancel dust: order ${order.id.slice(0, 10)} token ${tokenId.slice(0, 8)} size=${size.toFixed(4)} — below CLOB min (${CLOB_MIN_SIZE}), unliquidatable`,
      )
      return
    }

    const MAX_RETRIES = 5
    const RETRY_DELAY_MS = 3_000
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const curPos = await this.fetchPositionData(tokenId)
      const curSize = curPos?.size ?? 0
      if (curSize < 0.01) return
      if (curSize < CLOB_MIN_SIZE) {
        this.logger.warn(
          `Post-cancel dust: order ${order.id.slice(0, 10)} token ${tokenId.slice(0, 8)} size=${curSize.toFixed(4)} — below CLOB min (${CLOB_MIN_SIZE}), unliquidatable`,
        )
        return
      }
      const limitPrice = Math.max((curPos?.price ?? 0.5) - 0.01 * attempt, 0.01)
      this.logger.log(
        `Post-cancel residual attempt ${attempt}/${MAX_RETRIES}: order ${order.id.slice(0, 10)} token ${tokenId.slice(0, 8)} size=${curSize.toFixed(4)} — FOK sell @ ${limitPrice}`,
      )
      const resp = await this.getClient().createAndPostMarketOrder(
        { tokenID: tokenId, amount: curSize, side: Side.SELL, price: limitPrice },
        undefined,
        OrderType.FOK,
      )
      const r = resp as Record<string, unknown>
      if (r['success']) {
        this.logger.log(`Post-cancel residual cleared: order ${order.id.slice(0, 10)}`)
        return
      }
      this.logger.warn(
        `Post-cancel FOK sell attempt ${attempt} failed: ${String(r['errorMsg'] ?? r['error'] ?? 'unknown')}`,
      )
      if (attempt < MAX_RETRIES) await new Promise((res) => setTimeout(res, RETRY_DELAY_MS))
    }
    this.logger.warn(
      `Post-cancel residual not cleared after ${MAX_RETRIES} attempts: order ${order.id.slice(0, 10)} token ${tokenId.slice(0, 8)}`,
    )
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
    const realOrder = decisionId ? await this.orderRepo.findByDecisionId(decisionId) : null
    // Cap fill size to what was actually posted to CLOB (may be less than paper fill if notional-capped)
    const effectiveFillSize = realOrder ? Math.min(paperFill.size, realOrder.size) : paperFill.size

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
      const notional = realHedgePrice * effectiveFillSize
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
              ? realHedgePrice * effectiveFillSize
              : effectiveFillSize
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
      tokenId: tokenId ?? null,
      source: 'paper',
      hedgeRetryCount: 0,
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
