export const CLOB_BASE = '/clob-api'
export const REFRESH_MS = 60_000

// USDC on Polygon — the asset rewards are paid in
export const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'

export function formatUsd(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '—'
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`
}

export function formatPrice(value: number): string {
  return value.toFixed(3)
}

export function formatCents(valueDollars: number): string {
  return `±${(valueDollars * 100).toFixed(1)}¢`
}

export function formatMaxSpread(valueCents: number): string {
  return `±${valueCents}¢`
}

export function formatUpdatedAt(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatEndDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}
