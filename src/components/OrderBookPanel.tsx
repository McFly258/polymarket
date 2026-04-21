import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis, Legend,
} from 'recharts'
import { fetchBooks, type BookLevel, type BookView } from '../api/polymarket'
import { formatPrice, formatUsd } from '../constants'
import {
  getBackendEngine,
  type PositionRewardHourlyPoint,
} from '../services/backendEngine'
import type {
  FillEvent,
  PaperPosition,
  PhantomOrder,
} from '../services/paperTrading'

const POLL_MS = 1500
const HOUR_MS = 3_600_000

interface Props {
  position: PaperPosition
  bidOrder: PhantomOrder | null
  askOrder: PhantomOrder | null
  slug: string | null
}

interface ChartPoint {
  hourEpoch: number
  hourLabel: string
  rewards: number
  realised: number
  net: number
}

function priceKey(p: number): string {
  return p.toFixed(3)
}

function hourLabel(hourEpoch: number): string {
  const d = new Date(hourEpoch)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:00`
}

function buildSeries(
  rewards: PositionRewardHourlyPoint[],
  fills: FillEvent[],
): ChartPoint[] {
  const rewardByHour = new Map<number, number>()
  let cumReward = 0
  const sortedRewards = [...rewards].sort((a, b) => a.hourEpoch - b.hourEpoch)
  for (const r of sortedRewards) {
    cumReward += r.earnedThisHourUsd
    rewardByHour.set(r.hourEpoch, cumReward)
  }

  const realisedByHour = new Map<number, number>()
  const fillsByHour = new Map<number, number>()
  for (const f of fills) {
    const h = Math.floor(f.filledAt / HOUR_MS) * HOUR_MS
    fillsByHour.set(h, (fillsByHour.get(h) ?? 0) + f.realisedPnlUsd)
  }
  let cumRealised = 0
  for (const h of [...fillsByHour.keys()].sort((a, b) => a - b)) {
    cumRealised += fillsByHour.get(h) ?? 0
    realisedByHour.set(h, cumRealised)
  }

  const hourSet = new Set<number>([...rewardByHour.keys(), ...realisedByHour.keys()])
  const hours = [...hourSet].sort((a, b) => a - b)
  let lastReward = 0
  let lastRealised = 0
  return hours.map((h) => {
    if (rewardByHour.has(h)) lastReward = rewardByHour.get(h) ?? lastReward
    if (realisedByHour.has(h)) lastRealised = realisedByHour.get(h) ?? lastRealised
    return {
      hourEpoch: h,
      hourLabel: hourLabel(h),
      rewards: Number(lastReward.toFixed(4)),
      realised: Number(lastRealised.toFixed(4)),
      net: Number((lastReward + lastRealised).toFixed(4)),
    }
  })
}

export function OrderBookPanel({ position, bidOrder, askOrder, slug }: Props) {
  const [book, setBook] = useState<BookView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Per-position chart state
  const backend = getBackendEngine()
  const [rewards, setRewards] = useState<PositionRewardHourlyPoint[]>([])
  const [fills, setFills] = useState<FillEvent[]>([])
  const [chartLoading, setChartLoading] = useState(true)
  const [chartError, setChartError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function tick() {
      try {
        const map = await fetchBooks([position.tokenId])
        const view = map.get(position.tokenId)
        if (cancelled) return
        if (view) {
          setBook(view)
          setError(null)
        } else {
          setError('no book returned')
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void tick()
    const id = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [position.tokenId])

  // Fetch per-position history once on mount + every 5 min while expanded.
  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [r, f] = await Promise.all([
          backend.fetchPositionRewardHistory(position.conditionId, 720),
          backend.fetchFillsHistory(10_000),
        ])
        if (cancelled) return
        setRewards(r)
        setFills(f.filter((x) => x.conditionId === position.conditionId))
        setChartError(null)
      } catch (e) {
        if (!cancelled) setChartError((e as Error).message)
      } finally {
        if (!cancelled) setChartLoading(false)
      }
    }

    void load()
    const id = window.setInterval(() => void load(), 5 * 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [backend, position.conditionId])

  const series = useMemo(() => buildSeries(rewards, fills), [rewards, fills])
  const finalNet = series.length > 0 ? series[series.length - 1].net : 0
  const finalRewards = series.length > 0 ? series[series.length - 1].rewards : 0
  const finalRealised = series.length > 0 ? series[series.length - 1].realised : 0

  function mergeOurOrder(
    levels: BookLevel[],
    ourPrice: number | null,
    ourSize: number | null,
    sort: 'asc' | 'desc',
  ): BookLevel[] {
    if (ourPrice === null || ourSize === null) return levels
    const key = priceKey(ourPrice)
    if (levels.some((l) => priceKey(l.price) === key)) return levels
    const merged = [...levels, { price: ourPrice, size: 0 }]
    merged.sort((a, b) => (sort === 'asc' ? a.price - b.price : b.price - a.price))
    return merged
  }

  const ourBidPrice = bidOrder ? bidOrder.price : null
  const ourAskPrice = askOrder ? askOrder.price : null

  const asks = book
    ? mergeOurOrder(book.asks, ourAskPrice, askOrder?.size ?? null, 'asc').slice(0, 12)
    : []
  const bids = book
    ? mergeOurOrder(book.bids, ourBidPrice, bidOrder?.size ?? null, 'desc').slice(0, 12)
    : []

  const maxSize = Math.max(
    0,
    ...asks.map((l) => l.size),
    ...bids.map((l) => l.size),
  )

  function row(
    level: BookLevel,
    side: 'bid' | 'ask',
    ours: boolean,
    ourSize: number | null,
  ) {
    const barPct = maxSize > 0 ? Math.min(100, (level.size / maxSize) * 100) : 0
    const barColor = side === 'ask' ? 'rgba(239,68,68,0.18)' : 'rgba(74,222,128,0.18)'
    return (
      <tr key={`${side}-${priceKey(level.price)}`} style={ours ? { background: 'rgba(59,130,246,0.18)' } : undefined}>
        <td className="num" style={{ color: side === 'ask' ? '#ef4444' : '#4ade80', fontWeight: ours ? 600 : 400 }}>
          {formatPrice(level.price)}
        </td>
        <td className="num" style={{ position: 'relative' }}>
          <div style={{
            position: 'absolute', inset: 0, width: `${barPct}%`,
            background: barColor, zIndex: 0, pointerEvents: 'none',
          }} />
          <span style={{ position: 'relative', zIndex: 1 }}>
            {level.size.toFixed(0)}
          </span>
        </td>
        <td className="num dim" style={{ minWidth: 110 }}>
          {ours && ourSize !== null
            ? <span style={{ color: '#60a5fa' }}>◀ ours {ourSize.toFixed(0)}</span>
            : ''}
        </td>
      </tr>
    )
  }

  return (
    <div
      style={{
        background: 'rgba(15,23,42,0.55)',
        border: '1px solid rgba(148,163,184,0.18)',
        borderRadius: 10,
        padding: 14,
        margin: '4px 0',
      }}
    >
      <div style={{ marginBottom: 10 }}>
        {slug ? (
          <a
            href={`https://polymarket.com/market/${slug}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontWeight: 600, color: '#60a5fa', textDecoration: 'none' }}
          >
            {position.question} ↗
          </a>
        ) : (
          <span style={{ fontWeight: 600 }}>{position.question}</span>
        )}
      </div>

      <div style={{ marginBottom: 10 }}>
        <div className="helper-text" style={{ fontSize: '0.78rem', marginBottom: 6 }}>
          PnL: rewards{' '}
          <strong style={{ color: '#4ade80' }}>{formatUsd(finalRewards)}</strong>
          {' · '}realised{' '}
          <strong style={{ color: finalRealised >= 0 ? '#4ade80' : '#ef4444' }}>
            {finalRealised >= 0 ? '+' : ''}{formatUsd(finalRealised)}
          </strong>
          {' · '}net{' '}
          <strong style={{ color: finalNet >= 0 ? '#4ade80' : '#ef4444' }}>
            {finalNet >= 0 ? '+' : ''}{formatUsd(finalNet)}
          </strong>
        </div>
        {chartError && (
          <p style={{ color: '#ef4444', fontSize: '0.8rem', margin: '4px 0' }}>
            Chart error: {chartError}
          </p>
        )}
        {chartLoading && series.length === 0 ? (
          <p className="dim" style={{ fontSize: '0.8rem', margin: '8px 0' }}>Loading PnL history…</p>
        ) : series.length === 0 ? (
          <p className="dim" style={{ fontSize: '0.8rem', margin: '8px 0' }}>
            No hourly snapshots yet for this position.
          </p>
        ) : (
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
              <LineChart data={series} margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="hourLabel" stroke="#94a3b8" fontSize={10} />
                <YAxis
                  stroke="#94a3b8"
                  fontSize={10}
                  tickFormatter={(v: number) => formatUsd(v)}
                  width={60}
                />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}
                  labelStyle={{ color: '#e2e8f0' }}
                  formatter={(v, name) => [formatUsd(Number(v ?? 0)), String(name)]}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="rewards" name="Rewards" stroke="#4ade80" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="realised" name="Realised" stroke="#f87171" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="net" name="Net" stroke="#60a5fa" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="helper-text" style={{ fontSize: '0.78rem', marginBottom: 8 }}>
        mid {position.midPrice !== null ? formatPrice(position.midPrice) : '—'}
        {' · '}spread {book?.spread !== null && book?.spread !== undefined ? (book.spread * 100).toFixed(1) + '¢' : '—'}
        {' · '}refresh {POLL_MS / 1000}s
      </div>

      {error && (
        <p style={{ color: '#ef4444', marginTop: 4, fontSize: '0.85rem' }}>Error: {error}</p>
      )}
      {loading && !book ? (
        <p className="dim" style={{ margin: '12px 0', textAlign: 'center' }}>Loading book…</p>
      ) : book ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', maxWidth: 520 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Price</th>
              <th style={{ textAlign: 'left' }}>Size (shares)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {asks.slice().reverse().map((l) => row(l, 'ask', ourAskPrice !== null && priceKey(l.price) === priceKey(ourAskPrice), askOrder?.size ?? null))}
            <tr>
              <td colSpan={3} style={{ padding: '6px 0', borderTop: '1px dashed rgba(148,163,184,0.3)', borderBottom: '1px dashed rgba(148,163,184,0.3)', textAlign: 'center', fontSize: '0.78rem', color: '#94a3b8' }}>
                spread {book.spread !== null ? (book.spread * 100).toFixed(1) + '¢' : '—'}
              </td>
            </tr>
            {bids.map((l) => row(l, 'bid', ourBidPrice !== null && priceKey(l.price) === priceKey(ourBidPrice), bidOrder?.size ?? null))}
          </tbody>
        </table>
      ) : null}

      <div className="helper-text" style={{ marginTop: 10, fontSize: '0.75rem' }}>
        Blue rows are our resting paper orders. If our price sits behind the touch, the row is
        inserted with size 0 from the book (the real resting depth is ours only).
      </div>
    </div>
  )
}
