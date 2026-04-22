import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { BookView } from './api/polymarket'
import type { DashboardData, MarketVolatility, RawMarket, StrategyConfig } from './types'
import {
  buildDashboard,
  collectTokenIds,
  loadMarketsAndBooksStreaming,
} from './services/dashboard'
import { DEFAULT_STRATEGY, runSimulation } from './services/strategy'
import { startMarketStream, type ConnectionState } from './services/wsClient'
import { TimezoneProvider } from './context/TimezoneContext'
import { HeroPanel } from './components/HeroPanel'
import { StatCards } from './components/StatCards'
import { FilterBar } from './components/FilterBar'
import { RewardsTable } from './components/RewardsTable'
import { MarketHistoryPanel } from './components/MarketHistoryPanel'
import { SimulationPanel } from './components/SimulationPanel'
import { PaperTradingPanel } from './components/PaperTradingPanel'
import { getPaperEngine } from './services/paperTrading'

// Re-derive the dashboard rows from the live books map at most this often. WS
// events can arrive dozens of times per second; the table can't visibly use
// that bandwidth, so we coalesce. 1s matches the paper-engine reward tick.
const DERIVE_INTERVAL_MS = 1000

// Safety HTTP resync to catch anything the WS missed (tick-size changes, new
// markets, etc.). WS keeps books fresh — this is purely a metadata refresh, so
// we can run it sparsely.
const RESYNC_INTERVAL_MS = 15 * 60_000

// Stable signature for a token-id list so the WS effect doesn't tear down
// every time a single market enters/exits the active set.
function tokenIdSignature(ids: string[]): string {
  if (ids.length === 0) return ''
  const sorted = [...ids].sort()
  // Sample first/last/middle + length to detect material set changes without
  // hashing every id on every tick.
  return `${sorted.length}|${sorted[0]}|${sorted[Math.floor(sorted.length / 2)]}|${sorted[sorted.length - 1]}`
}

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
      // Streaming load: markets arrive first so the table shell renders
      // immediately, then books trickle in as HTTP batches complete.
      await loadMarketsAndBooksStreaming(
        {
          onMarkets: (markets) => {
            marketsRef.current = markets
            dirtyRef.current = true
            deriveNow()
          },
          onBooksBatch: (batch) => {
            // Merge incoming batch — WS state takes priority for ids we already
            // have a live feed for, so only write if WS hasn't provided fresher data.
            for (const [id, view] of batch) {
              if (!booksRef.current.has(id)) booksRef.current.set(id, view)
            }
            dirtyRef.current = true
          },
        },
      )
      // Final merge: keep any WS updates that arrived during the HTTP load.
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

  // Stable signature of the streamed token-id set. Recomputed only when `data`
  // changes; the WS effect below depends on this string, so a refresh that adds
  // or drops a single market won't tear down the sockets unless the *set*
  // boundary actually shifts.
  const tokenIdSig = useMemo(() => {
    if (!data) return ''
    return tokenIdSignature(collectTokenIds(marketsRef.current))
  }, [data])

  // Wire up the websocket stream whenever the streamed token set materially
  // changes. The sockets persist across HTTP resyncs and across throttled
  // re-derives — only set-shape changes (lots of markets added/removed) trigger
  // a teardown.
  useEffect(() => {
    if (!tokenIdSig) return
    const tokenIds = collectTokenIds(marketsRef.current)
    if (tokenIds.length === 0) return
    const engine = getPaperEngine()
    const client = startMarketStream(tokenIds, {
      seedBooks: booksRef.current,
      onBook: (tokenId, view) => {
        booksRef.current.set(tokenId, view)
        dirtyRef.current = true
        // Feed the paper engine first so fill detection happens at WS speed,
        // independent of the table re-derive throttle.
        engine.evaluateBook(tokenId, view)
      },
      onStatus: (state, info) => {
        setWsState(state)
        setStreamedCount(info.streamed)
      },
    })
    return () => client.stop()
  }, [tokenIdSig])

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

  // The simulation iterates every reward-eligible market — keep it in one place
  // and pass the result to both panels. useDeferredValue lets the priority
  // table paint first; the heavy sim work happens in a background render.
  const deferredRows = useDeferredValue(data?.rows)
  const deferredVolatility = useDeferredValue(volatility)
  const sim = useMemo(
    () => runSimulation(deferredRows ?? [], strategyConfig, deferredVolatility),
    [deferredRows, strategyConfig, deferredVolatility],
  )

  return (
    <TimezoneProvider>
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
        config={strategyConfig}
        onConfigChange={setStrategyConfig}
        result={sim}
      />

      <PaperTradingPanel
        rows={data?.rows ?? []}
        config={strategyConfig}
        sim={sim}
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
    </TimezoneProvider>
  )
}

export default App
