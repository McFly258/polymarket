import { useMemo } from 'react'
import { formatPrice, formatUsd } from '../constants'
import { runSimulation, DEFAULT_STRATEGY } from '../services/strategy'
import type { RewardsRow, StrategyConfig } from '../types'

type Props = {
  rows: RewardsRow[]
  config: StrategyConfig
  onConfigChange: (c: StrategyConfig) => void
}

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

export function SimulationPanel({ rows, config, onConfigChange }: Props) {
  const result = useMemo(() => runSimulation(rows, config), [rows, config])

  const maxMarkets = config.perMarketCapitalUsd > 0
    ? Math.floor(config.totalCapitalUsd / config.perMarketCapitalUsd)
    : 0

  const avgBidDistance = result.allocations.length > 0
    ? result.allocations.reduce((s, a) => s + a.bidDistanceFromTopCents, 0) / result.allocations.length
    : 0
  const avgAskDistance = result.allocations.length > 0
    ? result.allocations.reduce((s, a) => s + a.askDistanceFromTopCents, 0) / result.allocations.length
    : 0

  return (
    <article className="panel sim-panel">
      <div className="panel-header">
        <div>
          <h2>Strategy simulation</h2>
          <p>
            Passive two-sided market making. Each market gets{' '}
            <strong>{formatUsd(config.perMarketCapitalUsd)}</strong> ({formatUsd(config.perMarketCapitalUsd / 2)}{' '}
            per side) anchored at <strong>{(config.postingDistancePct * 100).toFixed(0)}%</strong> of the way
            from mid to the outer reward edge, with at least{' '}
            <strong>{config.minTicksBehindTop} tick(s)</strong> of buffer behind top of book — orders sit deep
            in the reward zone but far from the touch price, so fills are rare. Capital is allocated to the
            highest-yield markets first until <strong>{formatUsd(config.totalCapitalUsd)}</strong> is deployed.
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
          <div className="kpi-label">Expected daily</div>
          <div className="kpi-value kpi-green">{formatUsd(result.expectedDailyUsd)}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Portfolio yield</div>
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
              <th>Shares/side</th>
              <th>TTR</th>
              <th>Exp. daily</th>
              <th>Yield/day</th>
              <th>Warnings</th>
            </tr>
          </thead>
          <tbody>
            {result.allocations.map((a, i) => (
              <tr key={a.conditionId}>
                <td className="dim">{i + 1}</td>
                <td className="question-cell">
                  <a
                    href={`https://polymarket.com/event/${a.slug}`}
                    target="_blank"
                    rel="noreferrer"
                  >
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
                <td className="num">{a.sharesPerSide.toFixed(0)}</td>
                <td className="num dim">
                  {a.daysToResolution !== null ? `${a.daysToResolution.toFixed(0)}d` : '—'}
                </td>
                <td className="num kpi-green">{formatUsd(a.expectedDailyUsd)}</td>
                <td className="num kpi-green">{a.yieldPctDaily.toFixed(2)}%</td>
                <td className="dim" style={{ fontSize: '0.8rem' }}>
                  {a.warnings.length > 0 ? a.warnings.join(' · ') : '—'}
                </td>
              </tr>
            ))}
            {result.allocations.length === 0 ? (
              <tr>
                <td colSpan={13} className="dim" style={{ textAlign: 'center', padding: 40 }}>
                  No markets meet the current strategy thresholds. Try lowering Min yield, Min TTR, or Posting depth.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="helper-text" style={{ marginTop: 12 }}>
        Reward estimates use a linear-decay score <code>weight = 1 − d/max_spread</code> assuming quotes stay
        live for the full day. Posting deeper (higher %) reduces fill risk but also reduces your reward weight
        — the simulation already reflects this trade-off in expected daily.
      </p>
    </article>
  )
}
