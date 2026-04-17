import { formatUpdatedAt } from '../constants'
import type { ConnectionState } from '../services/wsClient'

type Props = {
  updatedAt: string | null
  loading: boolean
  onRefresh: () => void
  wsState: ConnectionState
  streamedCount: number
  totalMarkets: number
}

function wsLabel(state: ConnectionState): { label: string; className: string } {
  switch (state) {
    case 'open':
      return { label: 'Live', className: 'ws-dot ws-dot-open' }
    case 'connecting':
      return { label: 'Connecting', className: 'ws-dot ws-dot-connecting' }
    case 'reconnecting':
      return { label: 'Reconnecting', className: 'ws-dot ws-dot-connecting' }
    case 'closed':
      return { label: 'Offline', className: 'ws-dot ws-dot-closed' }
    case 'idle':
    default:
      return { label: 'Idle', className: 'ws-dot ws-dot-idle' }
  }
}

export function HeroPanel({
  updatedAt,
  loading,
  onRefresh,
  wsState,
  streamedCount,
  totalMarkets,
}: Props) {
  const ws = wsLabel(wsState)
  const streamedTokens = streamedCount
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
          {loading ? 'Refreshing…' : 'Resync'}
        </button>
        <span className="ws-status" title={`${streamedTokens} token streams open of ${totalMarkets * 2} total`}>
          <span className={ws.className} /> {ws.label}
          {streamedTokens > 0 ? ` · ${streamedTokens} streams` : ''}
        </span>
        <span>{updatedAt ? `Updated ${formatUpdatedAt(updatedAt)}` : 'Loading live data…'}</span>
      </div>
    </header>
  )
}
