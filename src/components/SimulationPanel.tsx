import { memo, useMemo, useState } from 'react'
import { formatPrice, formatUsd } from '../constants'
import { runSimulation, DEFAULT_STRATEGY } from '../services/strategy'
import type { MarketVolatility, RewardsRow, StrategyAllocation, StrategyConfig } from '../types'

type Props = {
  rows: RewardsRow[]
  config: StrategyConfig
  onConfigChange: (c: StrategyConfig) => void
  volatility: Record<string, MarketVolatility>
}

const ROWS_PER_PAGE = 100

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min = 0,
  max,
  suffix = '',
  width = 100,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  suffix?: string
  width?: number
}) {
  return (
    <label className="helper-text" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        style={{ width }}
      />
      {suffix ? <span className="dim">{suffix}</span> : null}
    </label>
  )
}

const SimRow = memo(function SimRow({ a, i }: { a: StrategyAllocation; i: number }) {
  return (
    <tr>
      <td className="dim">{i + 1}</td>
      <td className="question-cell">
        <a href={`https://polymarket.com/event/${a.slug}`} target="_blank" rel="noreferrer">
          {a.question}
        </a>
      </td>
      <td className="num">{formatUsd(a.dailyPool)}</td>
      <td className="num">±{a.maxSpreadCents}¢</td>
      <td className="num dim">{a.midPrice !== null ? formatPrice(a.midPrice) : '—'}</td>
      <td className="num">{a.bidPrice !== null ? formatPrice(a.bidPrice) : '—'}</td>
      <td className="num">{a.askPrice !== null ? formatPrice(a.askPrice) : '—'}</td>
      <td className="num dim">
        {a.bidDistanceFromTopCents.toFixed(1)} / {a.askDistanceFromTopCents.toFixed(1)}
      </td>
      <td className="num dim">
        {a.dailyVolUsd > 0 ? `±${(a.dailyVolUsd * 100).toFixed(2)}¢` : '—'}
      </td>
      <td className="num dim">{a.expectedRepricesPerDay.toFixed(1)}</td>
      <td className="num dim">{(a.expectedFillsPerDayPerSide * 100).toFixed(1)}%</td>
      <td className="num dim">{formatUsd(a.expectedFillCostUsd + a.expectedRepriceCostUsd)}</td>
      <td className="num">{formatUsd(a.grossDailyUsd)}</td>
      <td className="num kpi-green">{formatUsd(a.expectedDailyUsd)}</td>
      <td className="num kpi-green">{a.yieldPctDaily.toFixed(2)}%</td>
      <td className="dim" style={{ fontSize: '0.8rem' }}>
        {a.warnings.length > 0 ? a.warnings.join(' · ') : '—'}
      </td>
    </tr>
  )
})

export function SimulationPanel({ rows, config, onConfigChange, volatility }: Props) {
  const result = useMemo(() => runSimulation(rows, config, volatility), [rows, config, volatility])
  const [shown, setShown] = useState(ROWS_PER_PAGE)

  const maxMarkets = config.perMarketCapitalUsd > 0
    ? Math.floor(config.totalCapitalUsd / config.perMarketCapitalUsd)
    : 0

  const avgBidDistance = result.allocations.length > 0
    ? result.allocations.reduce((s, a) => s + a.bidDistanceFromTopCents, 0) / result.allocations.length
    : 0
  const avgAskDistance = result.allocations.length > 0
    ? result.allocations.reduce((s, a) => s + a.askDistanceFromTopCents, 0) / result.allocations.length
    : 0

  const coveragePct = result.allocations.length > 0
    ? (result.allocations.filter((a) => a.dailyVolUsd > 0).length / result.allocations.length) * 100
    : 0

  const visible = result.allocations.slice(0, shown)

  return (
    <article className="panel sim-panel">
      <div className="panel-header">
        <div>
          <h2>Strategy simulation</h2>
          <p>
            Passive two-sided market making. Each market gets{' '}
            <strong>{formatUsd(config.perMarketCapitalUsd)}</strong> ({formatUsd(config.perMarketCapitalUsd / 2)}{' '}
            per side) anchored at <strong>{(config.postingDistancePct * 100).toFixed(0)}%</strong> of the way
            from mid to the outer reward edge. Gross reward is netted against expected{' '}
            <strong>fill cost</strong> (adverse-selection loss + maker fee + hedge slippage) and{' '}
            <strong>reprice gas</strong>, both derived from 24h mid volatility in the collector DB.
          </p>
        </div>
      </div>

      <section className="sim-controls">
        <NumberField
          label="Total capital"
          value={config.totalCapitalUsd}
          onChange={(v) => onConfigChange({ ...config, totalCapitalUsd: v })}
          step={50}
          suffix="$"
          width={110}
        />
        <NumberField
          label="Per market"
          value={config.perMarketCapitalUsd}
          onChange={(v) => onConfigChange({ ...config, perMarketCapitalUsd: v })}
          step={10}
          suffix="$"
          width={90}
        />
        <NumberField
          label="Posting depth"
          value={Math.round(config.postingDistancePct * 100)}
          onChange={(v) => onConfigChange({ ...config, postingDistancePct: Math.max(0, Math.min(1, v / 100)) })}
          min={0}
          max={100}
          step={5}
          suffix="% of zone"
          width={70}
        />
        <NumberField
          label="Min behind top"
          value={config.minTicksBehindTop}
          onChange={(v) => onConfigChange({ ...config, minTicksBehindTop: Math.max(0, v) })}
          min={0}
          step={1}
          suffix="ticks"
          width={70}
        />
        <NumberField
          label="Min yield"
          value={config.minYieldPct}
          onChange={(v) => onConfigChange({ ...config, minYieldPct: v })}
          step={0.05}
          suffix="%/day"
          width={70}
        />
        <NumberField
          label="Min TTR"
          value={config.minDaysToResolution}
          onChange={(v) => onConfigChange({ ...config, minDaysToResolution: v })}
          step={1}
          suffix="days"
          width={70}
        />
        <NumberField
          label="Maker fee"
          value={config.makerFeePct * 100}
          onChange={(v) => onConfigChange({ ...config, makerFeePct: Math.max(0, v / 100) })}
          step={0.05}
          suffix="%"
          width={70}
        />
        <NumberField
          label="Taker fee"
          value={config.takerFeePct * 100}
          onChange={(v) => onConfigChange({ ...config, takerFeePct: Math.max(0, v / 100) })}
          step={0.05}
          suffix="%"
          width={70}
        />
        <NumberField
          label="Gas/order"
          value={config.gasCostPerOrderUsd}
          onChange={(v) => onConfigChange({ ...config, gasCostPerOrderUsd: Math.max(0, v) })}
          step={0.001}
          suffix="$"
          width={70}
        />
        <NumberField
          label="Reprice trigger"
          value={config.repriceThresholdCents}
          onChange={(v) => onConfigChange({ ...config, repriceThresholdCents: Math.max(0, v) })}
          step={0.1}
          suffix="¢ mid move"
          width={70}
        />
        <label className="helper-text" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={config.hedgeFillsOnBook}
            onChange={(e) => onConfigChange({ ...config, hedgeFillsOnBook: e.target.checked })}
          />
          Hedge fills on book
        </label>
        <button
          type="button"
          className="refresh-button"
          onClick={() => onConfigChange(DEFAULT_STRATEGY)}
        >
          Reset
        </button>
      </section>

      <section className="sim-summary">
        <div className="sim-kpi">
          <div className="kpi-label">Markets allocated</div>
          <div className="kpi-value">{result.allocations.length}<span className="dim"> / {maxMarkets} max</span></div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Capital deployed</div>
          <div className="kpi-value">{formatUsd(result.deployedCapital)}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Gross daily</div>
          <div className="kpi-value">{formatUsd(result.grossDailyUsd)}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Expected costs</div>
          <div className="kpi-value" style={{ color: '#ef4444' }}>−{formatUsd(result.totalCostUsd)}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Net daily</div>
          <div className="kpi-value kpi-green">{formatUsd(result.expectedDailyUsd)}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Net yield</div>
          <div className="kpi-value kpi-green">{result.portfolioYieldPctDaily.toFixed(2)}%/day</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Annualised (simple)</div>
          <div className="kpi-value kpi-green">{(result.portfolioYieldPctDaily * 365).toFixed(0)}%/yr</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Avg buffer</div>
          <div className="kpi-value">
            {avgBidDistance.toFixed(1)}¢ / {avgAskDistance.toFixed(1)}¢
            <span className="dim"> bid/ask</span>
          </div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Vol coverage</div>
          <div className="kpi-value">{coveragePct.toFixed(0)}%<span className="dim"> of allocs</span></div>
        </div>
      </section>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Market</th>
              <th>Pool/day</th>
              <th>Max spr</th>
              <th>Mid</th>
              <th>Bid post</th>
              <th>Ask post</th>
              <th>Buffer (¢)</th>
              <th>Vol (24h)</th>
              <th>Repr/d</th>
              <th>Fill%</th>
              <th>Cost/d</th>
              <th>Gross/d</th>
              <th>Net/d</th>
              <th>Yield</th>
              <th>Warnings</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a, i) => (
              <SimRow key={a.conditionId} a={a} i={i} />
            ))}
            {result.allocations.length === 0 ? (
              <tr>
                <td colSpan={16} className="dim" style={{ textAlign: 'center', padding: 40 }}>
                  No markets meet the current thresholds. Try lowering Min yield or Min TTR.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {result.allocations.length > visible.length ? (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: 12 }}>
            <button
              type="button"
              className="refresh-button"
              onClick={() => setShown((n) => n + ROWS_PER_PAGE)}
            >
              Show next {Math.min(ROWS_PER_PAGE, result.allocations.length - visible.length)}
            </button>
            <button
              type="button"
              className="refresh-button"
              onClick={() => setShown(result.allocations.length)}
            >
              Show all ({result.allocations.length})
            </button>
          </div>
        ) : null}
      </div>

      <p className="helper-text" style={{ marginTop: 12 }}>
        Fill cost uses a Brownian approximation: P(hit) ≈ 2·Φ(−d/σ<sub>24h</sub>) per side, expected loss ≈
        shares · d + (if hedging) shares · ½·spread + taker fee. Reprice frequency ≈ σ<sub>24h</sub> / trigger,
        each reprice = 4 order operations (2 cancels + 2 reposts). Markets with no volatility history fall back
        to 0 cost and get a warning — they're least reliable until the collector has 3+ snapshots.
      </p>
    </article>
  )
}
