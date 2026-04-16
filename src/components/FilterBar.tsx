type Props = {
  query: string
  onQuery: (q: string) => void
  onlyEligible: boolean
  onToggleEligible: (v: boolean) => void
  minDaily: number
  onMinDaily: (v: number) => void
}

export function FilterBar({ query, onQuery, onlyEligible, onToggleEligible, minDaily, onMinDaily }: Props) {
  return (
    <section className="controls-panel">
      <input
        type="search"
        placeholder="Search by question, slug or tag…"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <label className="helper-text" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={onlyEligible}
          onChange={(e) => onToggleEligible(e.target.checked)}
        />
        Only in-band
      </label>
      <label className="helper-text" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        Min daily $
        <input
          type="number"
          min={0}
          step={0.5}
          value={minDaily}
          onChange={(e) => onMinDaily(Number(e.target.value) || 0)}
          style={{ width: 90 }}
        />
      </label>
    </section>
  )
}
