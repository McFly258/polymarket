import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { formatPrice, formatUsd } from '../constants'
import { getBackendEngine, type BackendEngineClient } from '../services/backendEngine'
import { getPaperEngine, type EngineSnapshot } from '../services/paperTrading'
import type { RewardsRow, SimulationResult, StrategyConfig } from '../types'
import { PnLChart } from './PnLChart'

interface Props {
  rows: RewardsRow[]
  config: StrategyConfig
  sim: SimulationResult
}

type EngineSource = 'backend' | 'browser'

interface EngineFacade {
  subscribe: (fn: () => void) => () => void
  snapshot: () => EngineSnapshot
  start: () => Promise<void>
  stop: () => Promise<void>
  resetHistory: () => void | Promise<void>
  errorMessage: () => string | null
}

function backendFacade(client: BackendEngineClient, config: StrategyConfig): EngineFacade {
  return {
    subscribe: (fn) => client.subscribe(fn),
    snapshot: () => client.snapshot(),
    start: () => client.start(config),
    stop: () => client.stop(),
    resetHistory: () => client.resetHistory(),
    errorMessage: () => client.lastError(),
  }
}

function browserFacade(
  engine: ReturnType<typeof getPaperEngine>,
  allocations: RewardsRow[],
  sim: SimulationResult,
  config: StrategyConfig,
): EngineFacade {
  return {
    subscribe: (fn) => engine.subscribe(fn),
    snapshot: () => engine.snapshot(),
    start: () => engine.start(sim.allocations, allocations, config),
    stop: () => engine.stop(),
    resetHistory: () => engine.resetHistory(),
    errorMessage: () => null,
  }
}

function useFacadeSnapshot(facade: EngineFacade): EngineSnapshot {
  return useSyncExternalStore(
    (cb) => facade.subscribe(cb),
    () => facade.snapshot(),
    () => facade.snapshot(),
  )
}

function shortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function durationSince(ts: number | null): string {
  if (!ts) return '—'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function PaperTradingPanel({ rows, config, sim }: Props) {
  const browserEngine = getPaperEngine()
  const backendClient = getBackendEngine()
  // Default to the backend engine — it's the one that keeps trading across
  // tab closes, reloads, and EC2 process restarts. "Browser" is kept around
  // as a quick local test mode.
  const [source, setSource] = useState<EngineSource>('backend')
  const facade = useMemo(
    () => source === 'backend'
      ? backendFacade(backendClient, config)
      : browserFacade(browserEngine, rows, sim, config),
    [source, backendClient, browserEngine, rows, sim, config],
  )
  const snap = useFacadeSnapshot(facade)
  const [busy, setBusy] = useState(false)
  // Re-render every second while running so the "uptime" + accrual stays live
  // even when no WS events arrive.
  const [, setNow] = useState(0)
  useEffect(() => {
    if (snap.state !== 'running') return
    const id = window.setInterval(() => setNow((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [snap.state])

  // Bump chart refresh key every 5 minutes so the PnL chart re-fetches
  // hourly snapshots + fills history without thrashing the backend.
  const [chartRefreshKey, setChartRefreshKey] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setChartRefreshKey((n) => n + 1), 5 * 60_000)
    return () => window.clearInterval(id)
  }, [])

  const totalPnl = useMemo(
    () => snap.fills.reduce((s, f) => s + f.realisedPnlUsd, 0),
    [snap.fills],
  )
  const netPnl = totalPnl + snap.reward.totalEarnedUsd
  const fillsCount = snap.fills.length
  const restingCount = snap.orders.filter((o) => o.status === 'resting').length
  const portfolioRate = snap.positions.reduce((s, p) => s + p.expectedRatePerDay, 0)

  async function handleStart() {
    if (sim.allocations.length === 0) return
    setBusy(true)
    try {
      await engine.start(sim.allocations, rows, config)
    } finally {
      setBusy(false)
    }
  }

  async function handleStop() {
    setBusy(true)
    try {
      await engine.stop()
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="panel sim-panel">
      <div className="panel-header">
        <div>
          <h2>
            Paper trading{' '}
            <span className="dim" style={{ fontSize: '0.8rem' }}>
              ({snap.brokerKind})
            </span>
          </h2>
          <p>
            Tracks the strategy's quotes against live WS books. When a book crosses one of our
            phantom orders we record the fill and immediately submit a market hedge through the
            broker. Same fill-detection + hedge logic the live driver will use — just no real money
            placed. Swap in a credentialed CLOB broker later to go live.
          </p>
        </div>
      </div>

      <section className="sim-controls" style={{ alignItems: 'center' }}>
        <span className="kpi-label" style={{ marginRight: 8 }}>
          Status:{' '}
          <strong style={{ color: snap.state === 'running' ? '#4ade80' : '#94a3b8' }}>
            {snap.state}
          </strong>
        </span>
        <span className="helper-text">
          Uptime: <strong>{durationSince(snap.startedAt)}</strong>
        </span>
        <button
          type="button"
          className="refresh-button"
          onClick={() => void handleStart()}
          disabled={busy || snap.state === 'running' || sim.allocations.length === 0}
        >
          {sim.allocations.length > 0
            ? `Start paper trading (${sim.allocations.length} markets)`
            : 'Start (no allocations)'}
        </button>
        <button
          type="button"
          className="refresh-button"
          onClick={() => void handleStop()}
          disabled={busy || snap.state !== 'running'}
        >
          Stop & cancel all
        </button>
        <button
          type="button"
          className="refresh-button"
          onClick={() => engine.resetHistory()}
          disabled={busy || snap.state === 'running'}
        >
          Clear history
        </button>
      </section>

      <section className="sim-summary">
        <div className="sim-kpi">
          <div className="kpi-label">Resting orders</div>
          <div className="kpi-value">{restingCount}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Live $/day rate</div>
          <div className="kpi-value">{formatUsd(portfolioRate)}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Reward accrued</div>
          <div className="kpi-value kpi-green">{formatUsd(snap.reward.totalEarnedUsd)}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Fills</div>
          <div className="kpi-value">{fillsCount}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Realised hedge P&amp;L</div>
          <div className="kpi-value" style={{ color: totalPnl >= 0 ? '#4ade80' : '#ef4444' }}>
            {totalPnl >= 0 ? '+' : ''}
            {formatUsd(totalPnl)}
          </div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Net P&amp;L</div>
          <div className="kpi-value" style={{ color: netPnl >= 0 ? '#4ade80' : '#ef4444' }}>
            {netPnl >= 0 ? '+' : ''}
            {formatUsd(netPnl)}
          </div>
        </div>
      </section>

      <PnLChart refreshKey={chartRefreshKey} />

      <h3 className="panel-subhead">Active positions</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th>Mid</th>
              <th>Best bid / ask</th>
              <th>Bid resting</th>
              <th>Ask resting</th>
              <th>Reward share</th>
              <th>$/day</th>
            </tr>
          </thead>
          <tbody>
            {snap.positions.length === 0 ? (
              <tr>
                <td colSpan={7} className="dim" style={{ textAlign: 'center', padding: 24 }}>
                  Engine is idle. Click Start to post phantom quotes for the current allocation set.
                </td>
              </tr>
            ) : (
              snap.positions.map((p) => {
                const bidOrder = snap.orders.find((o) => o.id === p.bidOrderId)
                const askOrder = snap.orders.find((o) => o.id === p.askOrderId)
                return (
                  <tr key={p.conditionId}>
                    <td className="question-cell" title={p.question}>
                      {p.question.length > 70 ? p.question.slice(0, 70) + '…' : p.question}
                    </td>
                    <td className="num dim">{p.midPrice !== null ? formatPrice(p.midPrice) : '—'}</td>
                    <td className="num dim">
                      {p.bestBid !== null ? formatPrice(p.bestBid) : '—'} /{' '}
                      {p.bestAsk !== null ? formatPrice(p.bestAsk) : '—'}
                    </td>
                    <td className="num">
                      {bidOrder ? `${formatPrice(bidOrder.price)} × ${bidOrder.size.toFixed(0)}` : <span className="dim">filled</span>}
                    </td>
                    <td className="num">
                      {askOrder ? `${formatPrice(askOrder.price)} × ${askOrder.size.toFixed(0)}` : <span className="dim">filled</span>}
                    </td>
                    <td className="num">{p.rewardSharePct.toFixed(1)}%</td>
                    <td className="num kpi-green">{formatUsd(p.expectedRatePerDay)}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <h3 className="panel-subhead">Recent fills + hedges</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Market</th>
              <th>Side</th>
              <th>Fill px</th>
              <th>Size</th>
              <th>Hedge px</th>
              <th>Slip (¢)</th>
              <th>Maker fee</th>
              <th>Taker fee</th>
              <th>Realised P&amp;L</th>
              <th>Hedge</th>
            </tr>
          </thead>
          <tbody>
            {snap.fills.length === 0 ? (
              <tr>
                <td colSpan={11} className="dim" style={{ textAlign: 'center', padding: 24 }}>
                  No fills yet. Quotes are posted deep behind top-of-book — fills here mean a real adverse move.
                </td>
              </tr>
            ) : (
              snap.fills.slice(0, 50).map((f) => {
                const slipCents =
                  (f.side === 'bid' ? f.fillPrice - f.hedgePrice : f.hedgePrice - f.fillPrice) * 100
                return (
                  <tr key={f.id}>
                    <td className="dim">{shortTime(f.filledAt)}</td>
                    <td className="question-cell" title={f.question}>
                      {f.question.length > 50 ? f.question.slice(0, 50) + '…' : f.question}
                    </td>
                    <td>{f.side}</td>
                    <td className="num">{formatPrice(f.fillPrice)}</td>
                    <td className="num">{f.size.toFixed(0)}</td>
                    <td className="num">{formatPrice(f.hedgePrice)}</td>
                    <td className="num dim">{slipCents.toFixed(2)}</td>
                    <td className="num dim">{formatUsd(f.makerFeeUsd)}</td>
                    <td className="num dim">{formatUsd(f.takerFeeUsd)}</td>
                    <td
                      className="num"
                      style={{ color: f.realisedPnlUsd >= 0 ? '#4ade80' : '#ef4444' }}
                    >
                      {f.realisedPnlUsd >= 0 ? '+' : ''}
                      {formatUsd(f.realisedPnlUsd)}
                    </td>
                    <td className="dim">{f.hedgeStatus}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="helper-text" style={{ marginTop: 12 }}>
        Fill detection: a resting bid is marked filled when best_bid ≤ our price (the touch crossed
        through us); same logic mirrored on the ask. Hedge price = current best on the opposite
        side — what a market order would actually pay. Reward accrual integrates per-second using
        the position's instantaneous reward share, not a static estimate.
      </p>
    </article>
  )
}
