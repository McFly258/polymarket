import { useEffect, useState } from 'react'
import { fetchBooks, type BookLevel, type BookView } from '../api/polymarket'
import { formatPrice } from '../constants'
import type { PaperPosition, PhantomOrder } from '../services/paperTrading'

const POLL_MS = 1500

interface Props {
  position: PaperPosition
  bidOrder: PhantomOrder | null
  askOrder: PhantomOrder | null
}

function priceKey(p: number): string {
  return p.toFixed(3)
}

export function OrderBookPanel({ position, bidOrder, askOrder }: Props) {
  const [book, setBook] = useState<BookView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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
