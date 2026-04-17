import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { BookView } from './api/polymarket'
import { REFRESH_MS } from './constants'
import type { DashboardData, MarketVolatility, RawMarket, StrategyConfig } from './types'
import {
  buildDashboard,
  collectTokenIds,
  loadMarketsAndBooks,
} from './services/dashboard'
import { DEFAULT_STRATEGY } from './services/strategy'
import { startMarketStream, type ConnectionState } from './services/wsClient'
import { HeroPanel } from './components/HeroPanel'
import { StatCards } from './components/StatCards'
import { FilterBar } from './components/FilterBar'
import { RewardsTable } from './components/RewardsTable'
import { MarketHistoryPanel } from './components/MarketHistoryPanel'
import { SimulationPanel } from './components/SimulationPanel'

// How often we re-derive the dashboard rows from the live books map. WS events
// can arrive dozens of times per second — we throttle rather than render on
// every tick to keep the table smooth.
const DERIVE_INTERVAL_MS = 1000

// Safety HTTP resync to catch anything the WS missed (tick-size changes, new
// markets, etc.) and refresh the market metadata.
const RESYNC_INTERVAL_MS = REFRESH_MS

function App() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [onlyEligible, setOnlyEligible] = useState(false)
  const [minDaily, setMinDaily] = useState(0)
  const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null)
  const [strategyConfig, setStrategyConfig] = useState<StrategyConfig>(DEFAULT_STRATEGY)
  const [volatility, setVolatility] = useState<Record<string, MarketVolatility>>({})

  const [wsState, setWsState] = useState<ConnectionState>('idle')
  const [streamedCount, setStreamedCount] = useState(0)

  // Refs (not state) so that WS events don't trigger a render per message.
  const marketsRef = useRef<RawMarket[]>([])
  const booksRef = useRef<Map<string, BookView>>(new Map())
  const dirtyRef = useRef(false)

  const deriveNow = useCallback(() => {
    if (!marketsRef.current.length) return
    const next = buildDashboard(
      marketsRef.current,
      booksRef.current,
      new Date().toISOString(),
    )
    setData(next)
    dirtyRef.current = false
  }, [])

  const fetchVolatility = useCallback(async () => {
    try {
      const resp = await fetch('/api/polymarket/volatility?hours=24')
      if (resp.ok) {
        const payload = (await resp.json()) as {
          volatility: Record<string, MarketVolatility>
        }
        setVolatility(payload.volatility ?? {})
      }
    } catch {
      // Volatility endpoint requires the collector DB — fail silent.
    }
  }, [])

  const resync = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const snapshot = await loadMarketsAndBooks()
      marketsRef.current = snapshot.markets
      // Merge: HTTP snapshot wins for anything we haven't got a WS update for
      // yet, but we keep any fresher WS state from the current session.
      const merged = new Map(snapshot.books)
      for (const [id, v] of booksRef.current) merged.set(id, v)
      booksRef.current = merged
      dirtyRef.current = true
      deriveNow()
      void fetchVolatility()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [deriveNow, fetchVolatility])

  // Initial load + periodic HTTP resync (safety net for the WS).
  useEffect(() => {
    void resync()
    const id = window.setInterval(() => void resync(), RESYNC_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [resync])

  // Throttled re-derivation loop — rebuilds rows from the live books map at
  // most once per DERIVE_INTERVAL_MS, but only if something actually changed.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (dirtyRef.current) deriveNow()
    }, DERIVE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [deriveNow])

  // Wire up the websocket stream whenever the market set changes.
  useEffect(() => {
    if (!data) return
    const tokenIds = collectTokenIds(marketsRef.current)
    if (tokenIds.length === 0) return
    const client = startMarketStream(tokenIds, {
      seedBooks: booksRef.current,
      onBook: (tokenId, view) => {
        booksRef.current.set(tokenId, view)
        dirtyRef.current = true
      },
      onStatus: (state, info) => {
        setWsState(state)
        setStreamedCount(info.streamed)
      },
    })
    return () => client.stop()
    // We deliberately restart the stream only when the market COUNT changes —
    // not on every data tick — to avoid thrashing the sockets. buildDashboard
    // is pure, so same-length arrays behave identically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.rows.length])

  const deferredQuery = useDeferredValue(query)
  const deferredMinDaily = useDeferredValue(minDaily)

  const filteredRows = useMemo(() => {
    const rows = data?.rows ?? []
    const q = deferredQuery.trim().toLowerCase()
    return rows.filter((r) => {
      if (r.dailyRate < deferredMinDaily) return false
      if (onlyEligible && r.eligibleSides !== r.books.length) return false
      if (!q) return true
      const hay = `${r.question} ${r.slug} ${r.tags.join(' ')}`.toLowerCase()
      return hay.includes(q)
    })
  }, [data, deferredQuery, onlyEligible, deferredMinDaily])

  return (
    <main className="app-shell">
      <HeroPanel
        updatedAt={data?.updatedAt ?? null}
        loading={loading}
        onRefresh={() => void resync()}
        wsState={wsState}
        streamedCount={streamedCount}
        totalMarkets={data?.totals.markets ?? 0}
      />

      {error ? <section className="error-banner">{error}</section> : null}

      <StatCards data={data} />

      <SimulationPanel
        rows={data?.rows ?? []}
        config={strategyConfig}
        onConfigChange={setStrategyConfig}
        volatility={volatility}
      />

      <FilterBar
        query={query}
        onQuery={setQuery}
        onlyEligible={onlyEligible}
        onToggleEligible={setOnlyEligible}
        minDaily={minDaily}
        onMinDaily={setMinDaily}
      />

      <RewardsTable
        rows={filteredRows}
        loading={loading}
        selectedId={selectedMarketId}
        onSelect={setSelectedMarketId}
      />

      {selectedMarketId && (() => {
        const row = data?.rows.find((r) => r.conditionId === selectedMarketId)
        return row ? (
          <div
            className="history-panel-backdrop"
            onClick={() => setSelectedMarketId(null)}
          >
            <div onClick={(e) => e.stopPropagation()}>
              <MarketHistoryPanel
                conditionId={selectedMarketId}
                question={row.question}
                onClose={() => setSelectedMarketId(null)}
              />
            </div>
          </div>
        ) : null
      })()}
    </main>
  )
}

export default App
