import { useEffect, useState } from 'react'
import type { BookHistoryPoint, MarketHistoryData, RewardHistoryPoint } from '../types'
import { Sparkline } from './Sparkline'
import { formatUsd } from '../constants'

interface Props {
  conditionId: string
  question: string
  onClose: () => void
}

function formatTs(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function OutcomeHistory({ outcome, points }: { outcome: string; points: BookHistoryPoint[] }) {
  const spreads = points.map((p) => p.spread !== null ? p.spread * 100 : null)
  const qBids = points.map((p) => p.qualifying_bid_size)
  const qAsks = points.map((p) => p.qualifying_ask_size)
  const last = points[points.length - 1]

  return (
    <div className="outcome-history">
      <div className="outcome-history-header">
        <strong>{outcome}</strong>
        <span className="helper-text">{points.length} snapshots</span>
      </div>
      <div className="outcome-history-row">
        <span className="helper-text">Spread (¢)</span>
        <Sparkline values={spreads} color="#f59e0b" />
        {last?.spread !== null && last ? (
          <span className="num dim">{(last.spread! * 100).toFixed(2)}¢</span>
        ) : null}
      </div>
      <div className="outcome-history-row">
        <span className="helper-text">Qual. bid depth</span>
        <Sparkline values={qBids} color="#60a5fa" />
        {last ? <span className="num dim">{last.qualifying_bid_size.toFixed(0)}</span> : null}
      </div>
      <div className="outcome-history-row">
        <span className="helper-text">Qual. ask depth</span>
        <Sparkline values={qAsks} color="#a78bfa" />
        {last ? <span className="num dim">{last.qualifying_ask_size.toFixed(0)}</span> : null}
      </div>
    </div>
  )
}

function RewardHistory({ points }: { points: RewardHistoryPoint[] }) {
  const rates = points.map((p) => p.daily_rate)
  const last = points[points.length - 1]
  const first = points[0]

  return (
    <div className="reward-history">
      <div className="outcome-history-header">
        <strong>Daily reward pool</strong>
        <span className="helper-text">{points.length} snapshots · {formatTs(first.ts)} → {formatTs(last.ts)}</span>
      </div>
      <div className="outcome-history-row">
        <span className="helper-text">Daily USDC</span>
        <Sparkline values={rates} color="#4ade80" width={200} />
        <span className="num dim">{formatUsd(last.daily_rate)}</span>
      </div>
      <div className="history-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Daily</th>
              <th>Max spread (¢)</th>
              <th>Min size</th>
            </tr>
          </thead>
          <tbody>
            {[...points].reverse().slice(0, 48).map((p) => (
              <tr key={p.ts}>
                <td className="dim">{formatTs(p.ts)}</td>
                <td className="num">{formatUsd(p.daily_rate)}</td>
                <td className="num">{p.max_spread.toFixed(2)}</td>
                <td className="num">{p.min_size}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function MarketHistoryPanel({ conditionId, question, onClose }: Props) {
  const [data, setData] = useState<MarketHistoryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/polymarket/market-history?condition_id=${encodeURIComponent(conditionId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<MarketHistoryData>
      })
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load history'))
      .finally(() => setLoading(false))
  }, [conditionId])

  const outcomes = data
    ? [...new Set(data.books.map((b) => b.outcome))].map((outcome) => ({
        outcome,
        points: data.books.filter((b) => b.outcome === outcome),
      }))
    : []

  return (
    <div className="history-panel panel">
      <div className="history-panel-header">
        <div>
          <div className="eyebrow">Historical snapshots</div>
          <h3 className="history-title">{question}</h3>
        </div>
        <button className="close-button" onClick={onClose} aria-label="Close history">✕</button>
      </div>

      {loading && <p className="helper-text">Loading history…</p>}
      {error && <p className="error-banner" style={{ padding: '12px 16px' }}>{error}</p>}

      {!loading && !error && data && data.rewards.length === 0 && (
        <div className="no-history">
          <p>No snapshots collected yet.</p>
          <p className="helper-text">
            Run the collector to start recording history:
          </p>
          <code className="code-block">npm run collect</code>
          <p className="helper-text" style={{ marginTop: 8 }}>
            Or set up a cron job to collect every 5 minutes:
          </p>
          <code className="code-block">
            {'*/5 * * * * cd /home/ubuntu/.openclaw/workspace/polymarket && npm run collect >> collector.log 2>&1'}
          </code>
        </div>
      )}

      {!loading && data && data.rewards.length > 0 && (
        <>
          <RewardHistory points={data.rewards} />
          <div className="outcomes-grid">
            {outcomes.map(({ outcome, points }) => (
              <OutcomeHistory key={outcome} outcome={outcome} points={points} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
