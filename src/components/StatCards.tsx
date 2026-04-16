import { formatUsd } from '../constants'
import type { DashboardData } from '../types'

type Props = {
  data: DashboardData | null
}

export function StatCards({ data }: Props) {
  const totals = data?.totals

  return (
    <section className="stat-grid">
      <article className="stat-card">
        <span className="stat-label">Reward markets</span>
        <strong className="num">{totals?.markets ?? '—'}</strong>
        <small>Active markets with a rewards pool</small>
      </article>
      <article className="stat-card">
        <span className="stat-label">Daily USDC pool</span>
        <strong className="num">{totals ? formatUsd(totals.dailyPool) : '—'}</strong>
        <small>Sum of daily reward rates (paid ~midnight UTC)</small>
      </article>
      <article className="stat-card">
        <span className="stat-label">In-band now</span>
        <strong className="num">
          {totals ? `${totals.eligibleMarkets} / ${totals.markets}` : '—'}
        </strong>
        <small>Markets where book spread ≤ max reward spread</small>
      </article>
      <article className="stat-card">
        <span className="stat-label">Top daily rate</span>
        <strong className="num">
          {data?.rows[0] ? formatUsd(data.rows[0].dailyRate) : '—'}
        </strong>
        <small>{data?.rows[0]?.question.slice(0, 60) ?? '—'}</small>
      </article>
    </section>
  )
}
