import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import './App.css'
import { REFRESH_MS } from './constants'
import type { DashboardData, StrategyConfig } from './types'
import { loadDashboard } from './services/dashboard'
import { DEFAULT_STRATEGY } from './services/strategy'
import { HeroPanel } from './components/HeroPanel'
import { StatCards } from './components/StatCards'
import { FilterBar } from './components/FilterBar'
import { RewardsTable } from './components/RewardsTable'
import { MarketHistoryPanel } from './components/MarketHistoryPanel'
import { SimulationPanel } from './components/SimulationPanel'

function App() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [onlyEligible, setOnlyEligible] = useState(false)
  const [minDaily, setMinDaily] = useState(0)
  const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null)
  const [strategyConfig, setStrategyConfig] = useState<StrategyConfig>(DEFAULT_STRATEGY)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const next = await loadDashboard()
      setData(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), REFRESH_MS)
    return () => window.clearInterval(id)
  }, [refresh])

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
        onRefresh={() => void refresh()}
      />

      {error ? <section className="error-banner">{error}</section> : null}

      <StatCards data={data} />

      <SimulationPanel
        rows={data?.rows ?? []}
        config={strategyConfig}
        onConfigChange={setStrategyConfig}
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
