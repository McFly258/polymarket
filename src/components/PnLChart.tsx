import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { formatUsd } from '../constants'
import {
  getBackendEngine,
  type PositionRewardHourlyPoint,
  type RewardHourlyPoint,
} from '../services/backendEngine'
import type { FillEvent } from '../services/paperTrading'

const HOUR_MS = 3_600_000
const TOP_N_POSITIONS = 8
const POSITION_COLORS = [
  '#4ade80', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa',
  '#f87171', '#34d399', '#22d3ee', '#fb923c', '#c084fc',
]

interface TotalPoint {
  hourEpoch: number
  hourLabel: string
  rewards: number
  realised: number
  net: number
}

interface PositionPoint {
  hourEpoch: number
  hourLabel: string
  [conditionId: string]: number | string
}

function hourLabel(hourEpoch: number): string {
  const d = new Date(hourEpoch)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:00`
}

/** Build cumulative rewards-per-hour series, carrying forward the last value
 *  into any gap hours so the chart stays connected. */
function buildRewardSeries(rewardHistory: RewardHourlyPoint[]): Map<number, number> {
  const out = new Map<number, number>()
  if (rewardHistory.length === 0) return out
  const sorted = [...rewardHistory].sort((a, b) => a.hourEpoch - b.hourEpoch)
  for (const r of sorted) out.set(r.hourEpoch, r.totalEarnedUsd)
  return out
}

/** Bucket fills into hour buckets and compute cumulative realised PnL per hour. */
function buildRealisedSeries(fills: FillEvent[]): Map<number, number> {
  const out = new Map<number, number>()
  if (fills.length === 0) return out
  const sorted = [...fills].sort((a, b) => a.filledAt - b.filledAt)
  let running = 0
  const byHour = new Map<number, number>()
  for (const f of sorted) {
    const hour = Math.floor(f.filledAt / HOUR_MS) * HOUR_MS
    byHour.set(hour, (byHour.get(hour) ?? 0) + f.realisedPnlUsd)
  }
  const hours = [...byHour.keys()].sort((a, b) => a - b)
  for (const h of hours) {
    running += byHour.get(h) ?? 0
    out.set(h, running)
  }
  return out
}

/** Bucket fills per conditionId per hour → cumulative per-position PnL. */
function buildPerPositionRealisedSeries(fills: FillEvent[]): Map<string, Map<number, number>> {
  const byCond = new Map<string, Map<number, number>>()
  for (const f of fills) {
    const hour = Math.floor(f.filledAt / HOUR_MS) * HOUR_MS
    const hourMap = byCond.get(f.conditionId) ?? new Map<number, number>()
    hourMap.set(hour, (hourMap.get(hour) ?? 0) + f.realisedPnlUsd)
    byCond.set(f.conditionId, hourMap)
  }
  const out = new Map<string, Map<number, number>>()
  for (const [cid, hourMap] of byCond) {
    const hours = [...hourMap.keys()].sort((a, b) => a - b)
    const cumul = new Map<number, number>()
    let running = 0
    for (const h of hours) {
      running += hourMap.get(h) ?? 0
      cumul.set(h, running)
    }
    out.set(cid, cumul)
  }
  return out
}

/** Build per-position cumulative reward series from the hourly rows. Each
 *  hourly row carries `earnedThisHourUsd`, so we running-sum by conditionId. */
function buildPerPositionRewardSeries(history: PositionRewardHourlyPoint[]): {
  byCondition: Map<string, Map<number, number>>
  questionByCondition: Map<string, string>
} {
  const byCondRaw = new Map<string, PositionRewardHourlyPoint[]>()
  const questionByCondition = new Map<string, string>()
  for (const r of history) {
    const arr = byCondRaw.get(r.conditionId) ?? []
    arr.push(r)
    byCondRaw.set(r.conditionId, arr)
    if (!questionByCondition.has(r.conditionId)) questionByCondition.set(r.conditionId, r.question)
  }
  const byCondition = new Map<string, Map<number, number>>()
  for (const [cid, rows] of byCondRaw) {
    const sorted = rows.sort((a, b) => a.hourEpoch - b.hourEpoch)
    const cumul = new Map<number, number>()
    let running = 0
    for (const r of sorted) {
      running += r.earnedThisHourUsd
      cumul.set(r.hourEpoch, running)
    }
    byCondition.set(cid, cumul)
  }
  return { byCondition, questionByCondition }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

interface Props {
  refreshKey?: number
}

export function PnLChart({ refreshKey = 0 }: Props) {
  const backend = getBackendEngine()
  const [rewardHistory, setRewardHistory] = useState<RewardHourlyPoint[]>([])
  const [positionHistory, setPositionHistory] = useState<PositionRewardHourlyPoint[]>([])
  const [fills, setFills] = useState<FillEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      backend.fetchRewardHistory(720),
      backend.fetchPositionRewardHistory(undefined, 5000),
      backend.fetchFillsHistory(10_000),
    ])
      .then(([rewards, positions, f]) => {
        if (cancelled) return
        setRewardHistory(rewards)
        setPositionHistory(positions)
        setFills(f)
        setErr(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setErr((e as Error).message)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [backend, refreshKey])

  const { totalSeries, positionSeries, topPositions } = useMemo(() => {
    const rewardByHour = buildRewardSeries(rewardHistory)
    const realisedByHour = buildRealisedSeries(fills)
    const positionRealised = buildPerPositionRealisedSeries(fills)
    const { byCondition: positionReward, questionByCondition } = buildPerPositionRewardSeries(positionHistory)

    // Union of hour buckets from all three sources.
    const hourSet = new Set<number>()
    for (const h of rewardByHour.keys()) hourSet.add(h)
    for (const h of realisedByHour.keys()) hourSet.add(h)
    for (const map of positionRealised.values()) for (const h of map.keys()) hourSet.add(h)
    for (const map of positionReward.values()) for (const h of map.keys()) hourSet.add(h)
    const hours = [...hourSet].sort((a, b) => a - b)

    // ── Total series: rewards, realised, net per hour (cumulative) ───────
    let lastReward = 0
    let lastRealised = 0
    const totalSeries: TotalPoint[] = hours.map((h) => {
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

    // ── Per-position series: cumulative net PnL per conditionId per hour ─
    const allConditions = new Set<string>()
    for (const cid of positionRealised.keys()) allConditions.add(cid)
    for (const cid of positionReward.keys()) allConditions.add(cid)

    const lastPerCond = new Map<string, { realised: number; reward: number }>()
    for (const cid of allConditions) lastPerCond.set(cid, { realised: 0, reward: 0 })

    const positionSeriesFull: Array<{ point: PositionPoint; perCond: Map<string, number> }> = hours.map((h) => {
      const point: PositionPoint = { hourEpoch: h, hourLabel: hourLabel(h) }
      const perCond = new Map<string, number>()
      for (const cid of allConditions) {
        const last = lastPerCond.get(cid)!
        const rMap = positionRealised.get(cid)
        const wMap = positionReward.get(cid)
        if (rMap?.has(h)) last.realised = rMap.get(h) ?? last.realised
        if (wMap?.has(h)) last.reward = wMap.get(h) ?? last.reward
        const net = last.realised + last.reward
        point[cid] = Number(net.toFixed(4))
        perCond.set(cid, net)
      }
      return { point, perCond }
    })

    // Pick top-N conditions by |final net|.
    const finalByCond = new Map<string, number>()
    if (positionSeriesFull.length > 0) {
      const final = positionSeriesFull[positionSeriesFull.length - 1].perCond
      for (const [cid, v] of final) finalByCond.set(cid, v)
    }
    const top = [...allConditions]
      .map((cid) => ({
        conditionId: cid,
        question: questionByCondition.get(cid) ?? fills.find((f) => f.conditionId === cid)?.question ?? cid.slice(0, 8),
        net: finalByCond.get(cid) ?? 0,
      }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .slice(0, TOP_N_POSITIONS)

    const positionSeries = positionSeriesFull.map((x) => x.point)
    return { totalSeries, positionSeries, topPositions: top }
  }, [rewardHistory, positionHistory, fills])

  if (loading && totalSeries.length === 0) {
    return <p className="helper-text">Loading chart data…</p>
  }
  if (err) {
    return <p className="helper-text" style={{ color: '#ef4444' }}>Chart error: {err}</p>
  }
  if (totalSeries.length === 0) {
    return (
      <p className="helper-text">
        No hourly snapshots yet — the first one fires at the top of the next UTC hour after
        the engine starts.
      </p>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h3 className="panel-subhead">Cumulative PnL (hourly)</h3>
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer>
            <LineChart data={totalSeries} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="hourLabel" stroke="#94a3b8" fontSize={11} />
              <YAxis
                stroke="#94a3b8"
                fontSize={11}
                tickFormatter={(v: number) => formatUsd(v)}
                width={70}
              />
              <Tooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}
                labelStyle={{ color: '#e2e8f0' }}
                formatter={(v, name) => [formatUsd(Number(v ?? 0)), String(name)]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="rewards" name="Rewards" stroke="#4ade80" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="realised" name="Realised hedge P&L" stroke="#f87171" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="net" name="Net P&L" stroke="#60a5fa" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <h3 className="panel-subhead">
          Cumulative PnL per position (top {topPositions.length} by |net|)
        </h3>
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={positionSeries} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="hourLabel" stroke="#94a3b8" fontSize={11} />
              <YAxis
                stroke="#94a3b8"
                fontSize={11}
                tickFormatter={(v: number) => formatUsd(v)}
                width={70}
              />
              <Tooltip
                content={(props) => {
                  const { active, payload, label } = props as unknown as {
                    active?: boolean
                    payload?: Array<{ dataKey?: string; value?: number | string; color?: string }>
                    label?: string
                  }
                  if (!active || !payload?.length) return null
                  const sorted = [...payload].sort(
                    (a, b) => Math.abs(Number(b.value ?? 0)) - Math.abs(Number(a.value ?? 0)),
                  )
                  return (
                    <div style={{ background: '#0f172a', border: '1px solid #334155', padding: 8, fontSize: 12, maxWidth: 420 }}>
                      <div style={{ color: '#e2e8f0', marginBottom: 4 }}>{label}</div>
                      {sorted.map((p) => {
                        const cid = String(p.dataKey ?? '')
                        const tp = topPositions.find((t) => t.conditionId === cid)
                        return (
                          <div key={cid} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                            <span>{truncate(tp?.question ?? cid, 50)}</span>
                            <span>{formatUsd(Number(p.value ?? 0))}</span>
                          </div>
                        )
                      })}
                    </div>
                  )
                }}
              />
              {topPositions.map((p, i) => (
                <Line
                  key={p.conditionId}
                  type="monotone"
                  dataKey={p.conditionId}
                  name={truncate(p.question, 40)}
                  stroke={POSITION_COLORS[i % POSITION_COLORS.length]}
                  strokeWidth={1.5}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}
