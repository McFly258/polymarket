import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { formatPrice, formatShortTime, formatUsd } from '../constants'
import { useTimezone } from '../context/TimezoneContext'
import { getBackendEngine } from '../services/backendEngine'
import type { RealOrderRow, RealFillRow, RealBalanceDto } from '../services/backendEngine'
import type { PhantomOrder } from '../services/paperTrading'

function statusDot(status: PhantomOrder['status']) {
  if (status === 'resting') return <span style={{ color: '#4ade80' }}>●</span>
  if (status === 'filled')  return <span style={{ color: '#60a5fa' }}>●</span>
  return                           <span style={{ color: '#475569' }}>●</span>
}

function realStatusDot(status: RealOrderRow['status']) {
  if (['resting', 'accepted', 'partial', 'pending'].includes(status))
    return <span style={{ color: '#4ade80' }}>●</span>
  if (status === 'filled')
    return <span style={{ color: '#60a5fa' }}>●</span>
  return <span style={{ color: '#475569' }}>●</span>
}

function realStatusColor(status: RealOrderRow['status']): string {
  if (['resting', 'accepted', 'partial', 'pending'].includes(status)) return '#4ade80'
  if (status === 'filled') return '#60a5fa'
  return '#475569'
}

function shortId(id: string): string {
  // CLOB order IDs are hex hashes — show first 10 chars
  return id.length > 12 ? id.slice(0, 10) + '…' : id
}

function ageLabel(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

export function LiveOrdersPanel() {
  const { timezone } = useTimezone()
  const client = getBackendEngine()
  const snap = useSyncExternalStore(
    (cb) => client.subscribe(cb),
    () => client.snapshot(),
    () => client.snapshot(),
  )

  // Tick every second so ages stay fresh without needing a state update from above
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  // Real CLOB orders + fills — polled from the DB every 5 s
  const [realOrders, setRealOrders] = useState<RealOrderRow[]>([])
  const [realFillsRaw, setRealFillsRaw] = useState<RealFillRow[]>([])
  const [realBalance, setRealBalance] = useState<RealBalanceDto | null>(null)
  const [realOrdersError, setRealOrdersError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [orders, fills, balance] = await Promise.all([
          client.fetchRealOrders(100),
          client.fetchRealFills(500),
          client.fetchRealBalance(),
        ])
        if (!cancelled) {
          setRealOrders(orders)
          setRealFillsRaw(fills)
          setRealBalance(balance)
          setRealOrdersError(null)
        }
      } catch (e) {
        if (!cancelled) setRealOrdersError((e as Error).message)
      }
    }
    void load()
    const id = window.setInterval(() => void load(), 5_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [client])

  // Build a question map from positions and fills so we can label orders
  const questionByCondition = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of snap.positions) m.set(p.conditionId, p.question)
    for (const f of snap.fills) m.set(f.conditionId, f.question)
    return m
  }, [snap.positions, snap.fills])

  const recent = useMemo(
    () => snap.orders.filter((o) => o.status !== 'resting').sort((a, b) => (b.closedAt ?? b.postedAt) - (a.closedAt ?? a.postedAt)).slice(0, 50),
    [snap.orders],
  )

  // Only actual CLOB trades (source='reconciler'). Paper-engine fills (source='paper') are
  // synthetic simulation events with unrealistic lot sizes — exclude from all real P&L metrics.
  const realFills = useMemo(
    () => realFillsRaw.filter((f) => f.source === 'reconciler'),
    [realFillsRaw],
  )

  // Real CLOB open orders — accepted/resting/partial/pending = capital is deployed on-chain
  const realOpen = useMemo(
    () => realOrders.filter((o) => ['accepted', 'resting', 'partial', 'pending'].includes(o.status)),
    [realOrders],
  )
  // Only BID orders lock USDC; ASK orders lock tokens (not cash)
  const realCapitalDeployed = useMemo(
    () => realOpen.filter((o) => o.side === 'bid').reduce((s, o) => s + o.price * (o.size - o.filledSize), 0),
    [realOpen],
  )
  const realMarketsQuoted = useMemo(
    () => new Set(realOpen.map((o) => o.conditionId)).size,
    [realOpen],
  )
  // Real P&L from actual CLOB fills: ASK fills = cash in, BID fills = cash out, minus fees
  const realPnl = useMemo(
    () => realFills.reduce((s, f) => {
      const notional = f.fillPrice * f.size
      const fee = f.makerFeeUsd + f.takerFeeUsd
      return s + (f.side === 'ask' ? notional : -notional) - fee
    }, 0),
    [realFills],
  )

  // Show whenever real execution is enabled (brokerKind is always 'paper' on this backend
  // because CLOB orders are posted by a separate overlay module, not the engine broker)
  const realEnabled = realBalance?.enabled ?? false
  if (!realEnabled && realOrders.length === 0) return null

  return (
    <article className="panel sim-panel">
      <div className="panel-header">
        <div>
          <h2>
            Live orders{' '}
            <span className="dim" style={{ fontSize: '0.8rem' }}>
              (real CLOB — {snap.state})
            </span>
          </h2>
          <p>
            Resting orders currently on-chain and recent order history. Updates every 1 s.
          </p>
        </div>
      </div>

      <section className="sim-summary">
        <div className="sim-kpi">
          <div className="kpi-label">Resting</div>
          <div className="kpi-value kpi-green">{realOpen.length}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Markets quoted</div>
          <div className="kpi-value">{realMarketsQuoted}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Capital deployed</div>
          <div className="kpi-value">
            {formatUsd(realCapitalDeployed)}
          </div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Live $/day</div>
          <div className="kpi-value kpi-green">
            {formatUsd(snap.positions.reduce((s, p) => s + p.expectedRatePerDay, 0))}
          </div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Fills (total)</div>
          <div className="kpi-value">{realFills.length}</div>
        </div>
        <div className="sim-kpi">
          <div className="kpi-label">Net P&amp;L</div>
          <div className="kpi-value" style={{ color: realPnl >= 0 ? '#4ade80' : '#ef4444' }}>
            {realPnl >= 0 ? '+' : ''}{formatUsd(realPnl)}
          </div>
        </div>
      </section>

      <h3 className="panel-subhead">Resting orders ({realOpen.length})</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Market</th>
              <th>Outcome</th>
              <th>Side</th>
              <th>Price</th>
              <th>Remaining</th>
              <th>Age</th>
              <th title="On-chain order ID">Order ID</th>
            </tr>
          </thead>
          <tbody>
            {realOpen.length === 0 ? (
              <tr>
                <td colSpan={8} className="dim" style={{ textAlign: 'center', padding: 24 }}>
                  {snap.state === 'running' ? 'No resting orders right now — refresh cycle in progress.' : 'Engine idle.'}
                </td>
              </tr>
            ) : (
              realOpen.map((o) => {
                const q = questionByCondition.get(o.conditionId) ?? o.conditionId.slice(0, 12) + '…'
                const remaining = o.size - o.filledSize
                return (
                  <tr key={o.id}>
                    <td style={{ textAlign: 'center' }}>{realStatusDot(o.status)}</td>
                    <td className="question-cell" title={q}>
                      {q.length > 60 ? q.slice(0, 60) + '…' : q}
                    </td>
                    <td className="dim" style={{ fontSize: '0.8rem' }}>{o.outcome}</td>
                    <td style={{ color: o.side === 'bid' ? '#4ade80' : '#f472b6' }}>
                      {o.side === 'bid' ? 'BID' : 'ASK'}
                    </td>
                    <td className="num">{formatPrice(o.price)}</td>
                    <td className="num">{remaining.toFixed(0)}</td>
                    <td className="num dim">{ageLabel(o.postedAt)}</td>
                    <td className="dim" title={o.id} style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>
                      {shortId(o.id)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <h3 className="panel-subhead" style={{ marginTop: '2rem' }}>
        Real CLOB orders{' '}
        <span className="dim" style={{ fontSize: '0.8rem' }}>
          (DB — last 100, refreshes every 5 s)
        </span>
        {realBalance && (
          <span style={{ marginLeft: '1rem', fontSize: '0.82rem', color: realBalance.sufficient ? '#4ade80' : '#ef4444' }}>
            Wallet: {formatUsd(realBalance.balanceUsdc)} USDC
            {!realBalance.sufficient && ' ⚠ low balance'}
          </span>
        )}
      </h3>
      {realOrdersError && (
        <p className="dim" style={{ color: '#ef4444', padding: '0.5rem 0' }}>
          Could not load real orders: {realOrdersError}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Market</th>
              <th>Outcome</th>
              <th>Side</th>
              <th>Price</th>
              <th>Size</th>
              <th>Filled</th>
              <th>Status</th>
              <th>Posted</th>
              <th>Closed</th>
              <th title="On-chain tx hash">Tx</th>
            </tr>
          </thead>
          <tbody>
            {realOrders.length === 0 && !realOrdersError ? (
              <tr>
                <td colSpan={11} className="dim" style={{ textAlign: 'center', padding: 24 }}>
                  No real orders yet.
                </td>
              </tr>
            ) : (
              realOrders.map((o) => {
                const q = questionByCondition.get(o.conditionId) ?? o.conditionId.slice(0, 12) + '…'
                return (
                  <tr key={o.id}>
                    <td style={{ textAlign: 'center' }}>{realStatusDot(o.status)}</td>
                    <td className="question-cell" title={q}>
                      {q.length > 55 ? q.slice(0, 55) + '…' : q}
                    </td>
                    <td className="dim" style={{ fontSize: '0.8rem' }}>{o.outcome}</td>
                    <td style={{ color: o.side === 'bid' ? '#4ade80' : '#f472b6' }}>
                      {o.side === 'bid' ? 'BID' : 'ASK'}
                    </td>
                    <td className="num">{formatPrice(o.price)}</td>
                    <td className="num">{o.size.toFixed(0)}</td>
                    <td className="num">{o.filledSize > 0 ? o.filledSize.toFixed(2) : '—'}</td>
                    <td style={{ color: realStatusColor(o.status), fontSize: '0.82rem' }}>{o.status}</td>
                    <td className="dim">{formatShortTime(o.postedAt, timezone)}</td>
                    <td className="dim">{o.closedAt ? formatShortTime(o.closedAt, timezone) : '—'}</td>
                    <td className="dim" title={o.txHash ?? undefined} style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>
                      {o.txHash ? o.txHash.slice(0, 10) + '…' : '—'}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <h3 className="panel-subhead" style={{ marginTop: '2rem' }}>
        Real fills{' '}
        <span className="dim" style={{ fontSize: '0.8rem' }}>
          (last 500, refreshes every 5 s)
        </span>
      </h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th>Side</th>
              <th>Fill price</th>
              <th>Size</th>
              <th>Notional</th>
              <th>Fee</th>
              <th title="Cash flow for this fill (+ = received, − = paid)">P&amp;L contribution</th>
              <th>Time</th>
              <th title="On-chain tx hash">Tx</th>
            </tr>
          </thead>
          <tbody>
            {realFills.length === 0 ? (
              <tr>
                <td colSpan={9} className="dim" style={{ textAlign: 'center', padding: 24 }}>
                  No fills yet.
                </td>
              </tr>
            ) : (
              (() => {
                let cumPnl = 0
                return realFills.map((f) => {
                  const notional = f.fillPrice * f.size
                  const fee = f.makerFeeUsd + f.takerFeeUsd
                  const contribution = (f.side === 'ask' ? notional : -notional) - fee
                  cumPnl += contribution
                  const rawQ = f.question || questionByCondition.get(f.conditionId) || f.conditionId.slice(0, 12) + '…'
                  const q = rawQ.length > 55 ? rawQ.slice(0, 55) + '…' : rawQ
                  return (
                    <tr key={f.id}>
                      <td className="question-cell" title={rawQ}>{q}</td>
                      <td style={{ color: f.side === 'bid' ? '#4ade80' : '#f472b6' }}>
                        {f.side === 'bid' ? 'BID' : 'ASK'}
                      </td>
                      <td className="num">{formatPrice(f.fillPrice)}</td>
                      <td className="num">{f.size.toFixed(0)}</td>
                      <td className="num">{formatUsd(notional)}</td>
                      <td className="num dim">{fee > 0 ? formatUsd(fee) : '—'}</td>
                      <td className="num" style={{ color: contribution >= 0 ? '#4ade80' : '#ef4444' }}>
                        {contribution >= 0 ? '+' : ''}{formatUsd(contribution)}
                      </td>
                      <td className="dim">{formatShortTime(f.filledAt, timezone)}</td>
                      <td className="dim" title={f.txHash ?? undefined} style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>
                        {f.txHash ? f.txHash.slice(0, 10) + '…' : '—'}
                      </td>
                    </tr>
                  )
                })
              })()
            )}
          </tbody>
          {realFills.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: '1px solid #334155', fontWeight: 600 }}>
                <td colSpan={6} style={{ textAlign: 'right', paddingRight: '1rem', color: '#94a3b8' }}>
                  Net cash P&amp;L ({realFills.length} fills):
                </td>
                <td className="num" style={{ color: realPnl >= 0 ? '#4ade80' : '#ef4444' }}>
                  {realPnl >= 0 ? '+' : ''}{formatUsd(realPnl)}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <h3 className="panel-subhead">Order history (last 50)</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Market</th>
              <th>Side</th>
              <th>Price</th>
              <th>Size</th>
              <th>Status</th>
              <th>Posted</th>
              <th>Closed</th>
              <th title="Order ID on CLOB">Order ID</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={9} className="dim" style={{ textAlign: 'center', padding: 24 }}>
                  No closed orders yet.
                </td>
              </tr>
            ) : (
              recent.map((o) => {
                const q = questionByCondition.get(o.conditionId) ?? o.conditionId.slice(0, 12) + '…'
                return (
                  <tr key={o.id}>
                    <td style={{ textAlign: 'center' }}>{statusDot(o.status)}</td>
                    <td className="question-cell" title={q}>
                      {q.length > 55 ? q.slice(0, 55) + '…' : q}
                    </td>
                    <td style={{ color: o.side === 'bid' ? '#4ade80' : '#f472b6' }}>
                      {o.side === 'bid' ? 'BID' : 'ASK'}
                    </td>
                    <td className="num">{formatPrice(o.price)}</td>
                    <td className="num">{o.size.toFixed(0)}</td>
                    <td className="dim">{o.status}</td>
                    <td className="dim">{formatShortTime(o.postedAt, timezone)}</td>
                    <td className="dim">{o.closedAt ? formatShortTime(o.closedAt, timezone) : '—'}</td>
                    <td className="dim" title={o.id} style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>
                      {shortId(o.id)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </article>
  )
}
