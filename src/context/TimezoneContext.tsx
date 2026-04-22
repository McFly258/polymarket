import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'

export const TIMEZONES: { label: string; value: string }[] = [
  { label: 'UTC', value: 'UTC' },
  { label: 'New York (ET)', value: 'America/New_York' },
  { label: 'Chicago (CT)', value: 'America/Chicago' },
  { label: 'Denver (MT)', value: 'America/Denver' },
  { label: 'Los Angeles (PT)', value: 'America/Los_Angeles' },
  { label: 'London (GMT/BST)', value: 'Europe/London' },
  { label: 'Paris (CET)', value: 'Europe/Paris' },
  { label: 'Berlin (CET)', value: 'Europe/Berlin' },
  { label: 'Dubai (GST)', value: 'Asia/Dubai' },
  { label: 'Mumbai (IST)', value: 'Asia/Kolkata' },
  { label: 'Singapore (SGT)', value: 'Asia/Singapore' },
  { label: 'Tokyo (JST)', value: 'Asia/Tokyo' },
  { label: 'Sydney (AEST)', value: 'Australia/Sydney' },
]

const STORAGE_KEY = 'polymarket-tz'

function resolveDefault(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && TIMEZONES.some((t) => t.value === stored)) return stored
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone
  return TIMEZONES.some((t) => t.value === browser) ? browser : 'UTC'
}

type TimezoneContextValue = {
  timezone: string
  setTimezone: (tz: string) => void
}

const TimezoneContext = createContext<TimezoneContextValue>({
  timezone: 'UTC',
  setTimezone: () => {},
})

export function TimezoneProvider({ children }: { children: ReactNode }) {
  const [timezone, setTimezoneState] = useState(resolveDefault)

  function setTimezone(tz: string) {
    localStorage.setItem(STORAGE_KEY, tz)
    setTimezoneState(tz)
  }

  return (
    <TimezoneContext.Provider value={{ timezone, setTimezone }}>
      {children}
    </TimezoneContext.Provider>
  )
}

export function useTimezone(): TimezoneContextValue {
  return useContext(TimezoneContext)
}
