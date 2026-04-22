export const CLOB_BASE = '/clob-api'
export const REFRESH_MS = 3 * 60_000

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

export function formatUpdatedAt(iso: string, tz = 'UTC'): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz })
}

export function formatEndDate(iso: string | null, tz = 'UTC'): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric', timeZone: tz })
}

export function formatTs(ts: number, tz = 'UTC'): string {
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz,
  })
}

export function formatShortTime(ts: number, tz = 'UTC'): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz,
  })
}

export function formatHourLabel(hourEpoch: number, tz = 'UTC'): string {
  const d = new Date(hourEpoch)
  const parts = new Intl.DateTimeFormat('en-US', {
    month: 'numeric', day: 'numeric', hour: '2-digit', hour12: false, timeZone: tz,
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
  const hour = get('hour')
  return `${get('month')}/${get('day')} ${hour === '24' ? '00' : hour}:00`
}
