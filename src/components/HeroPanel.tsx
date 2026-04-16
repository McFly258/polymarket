import { formatUpdatedAt } from '../constants'

type Props = {
  updatedAt: string | null
  loading: boolean
  onRefresh: () => void
}

export function HeroPanel({ updatedAt, loading, onRefresh }: Props) {
  return (
    <header className="hero-panel">
      <div>
        <p className="eyebrow">Polymarket rewards</p>
        <h1>Liquidity rewards monitor</h1>
        <p className="hero-copy">
          Live tracker for every Polymarket market paying liquidity rewards — daily USDC pool,
          required spread, minimum size and whether the current book is inside the reward band.
        </p>
      </div>
      <div className="hero-meta">
        <button className="refresh-button" onClick={onRefresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh now'}
        </button>
        <span>{updatedAt ? `Updated ${formatUpdatedAt(updatedAt)}` : 'Loading live data…'}</span>
      </div>
    </header>
  )
}
