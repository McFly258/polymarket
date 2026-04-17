import { memo, useState } from 'react'
import { formatCents, formatEndDate, formatMaxSpread, formatPrice, formatUsd } from '../constants'
import type { BookSnapshot, RewardsRow } from '../types'

type Props = {
  rows: RewardsRow[]
  loading: boolean
  selectedId: string | null
  onSelect: (id: string | null) => void
}

const INITIAL_VISIBLE = 150
const PAGE_STEP = 150

function SideChip({ book }: { book: BookSnapshot }) {
  const cls =
    book.withinRewardSpread === true
      ? 'side-chip eligible'
      : book.withinRewardSpread === false
        ? 'side-chip ineligible'
        : 'side-chip'

  const midLabel = book.mid !== null ? formatPrice(book.mid) : formatPrice(book.price)
  const spreadLabel = book.spread !== null ? ` · Δ ${(book.spread * 100).toFixed(1)}¢` : ' · no book'

  const title =
    book.bestBid !== null && book.bestAsk !== null
      ? `bid ${formatPrice(book.bestBid)} / ask ${formatPrice(book.bestAsk)}`
      : 'no orderbook'

  return (
    <span className={cls} title={title}>
      {book.outcome}: {midLabel}
      {spreadLabel}
    </span>
  )
}

function StatusBadge({ row }: { row: RewardsRow }) {
  if (row.books.every((b) => b.withinRewardSpread === null)) {
    return <span className="badge badge-mute">no book</span>
  }
  if (row.eligibleSides === row.books.length) {
    return <span className="badge badge-on">in-band</span>
  }
  if (row.eligibleSides > 0) {
    return <span className="badge badge-warn">partial</span>
  }
  return <span className="badge badge-off">out</span>
}

type RowProps = {
  row: RewardsRow
  selected: boolean
  onSelect: (id: string | null) => void
}

const MarketRow = memo(function MarketRow({ row, selected, onSelect }: RowProps) {
  return (
    <tr
      className={selected ? 'row-selected' : 'row-clickable'}
      onClick={() => onSelect(selected ? null : row.conditionId)}
    >
      <td className="question-cell">
        <a
          href={`https://polymarket.com/event/${row.slug}`}
          target="_blank"
          rel="noreferrer"
        >
          {row.question}
        </a>
        <div className="question-meta">{row.tags.slice(0, 4).join(' · ') || '—'}</div>
      </td>
      <td className="num">{formatUsd(row.dailyRate)}</td>
      <td className="num">{formatMaxSpread(row.rewardMaxSpread)}</td>
      <td className="num">{row.rewardMinSize}</td>
      <td className="num">{formatCents(row.minTickSize)}</td>
      <td>
        <div className="side-grid">
          {row.books.map((b) => (
            <SideChip key={b.tokenId} book={b} />
          ))}
        </div>
      </td>
      <td><StatusBadge row={row} /></td>
      <td className="dim">{formatEndDate(row.endDateIso)}</td>
    </tr>
  )
})

export function RewardsTable({ rows, loading, selectedId, onSelect }: Props) {
  const [visible, setVisible] = useState(INITIAL_VISIBLE)
  const shown = rows.slice(0, visible)
  const hiddenCount = Math.max(0, rows.length - shown.length)

  return (
    <article className="panel table-panel">
      <div className="panel-header">
        <div>
          <h2>Reward-eligible markets</h2>
          <p>
            Sorted by daily USDC pool. A market is &ldquo;in-band&rdquo; when the current book
            spread on every outcome fits inside 2× the max reward spread.{' '}
            <span className="dim">
              Showing {shown.length.toLocaleString()} of {rows.length.toLocaleString()}.
            </span>
          </p>
        </div>
        {loading ? <span className="helper-text">Refreshing…</span> : null}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th>Daily</th>
              <th>Max spread</th>
              <th>Min size</th>
              <th>Tick</th>
              <th>Book</th>
              <th>Status</th>
              <th>Ends</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <MarketRow
                key={row.conditionId}
                row={row}
                selected={selectedId === row.conditionId}
                onSelect={onSelect}
              />
            ))}
            {rows.length === 0 && !loading ? (
              <tr><td colSpan={8} className="dim" style={{ textAlign: 'center', padding: 40 }}>
                No reward markets matching the current filters.
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {hiddenCount > 0 ? (
        <div className="table-footer">
          <button
            type="button"
            className="refresh-button"
            onClick={() => setVisible((v) => v + PAGE_STEP)}
          >
            Show next {Math.min(PAGE_STEP, hiddenCount)}
          </button>
          <button
            type="button"
            className="refresh-button"
            onClick={() => setVisible(rows.length)}
          >
            Show all {rows.length.toLocaleString()}
          </button>
          <span className="helper-text dim">
            {hiddenCount.toLocaleString()} more hidden — rendering everything at once is slow.
          </span>
        </div>
      ) : null}
    </article>
  )
}
