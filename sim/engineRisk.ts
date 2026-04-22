// Post-fill circuit breakers. Each function mutates its rolling-window state
// with the new fill, evaluates the threshold, and returns a decision the
// engine applies. Breakers do not perform side effects (I/O, position close)
// themselves — the engine owns that so tests can exercise breakers in isolation.

import type { StrategyConfig } from '../src/types.ts'

export interface AdverseSelectionHit {
  conditionId: string
  blacklistUntil: number
  sameSideFills: number
  windowMinutes: number
  blacklistMinutes: number
}

export interface MarketDrawdownHit {
  conditionId: string
  blacklistUntil: number
  windowPnl: number
  windowHours: number
  lossLimitUsd: number
  blacklistMinutes: number
}

export interface PortfolioDrawdownHit {
  globalPauseUntil: number
  windowPnl: number
  windowHours: number
  lossLimitUsd: number
  pauseMinutes: number
}

// Same-side fill density in a rolling window. When a competing participant has
// an information edge, fills cluster on one side. Above the threshold we blacklist.
export function checkAdverseSelection(
  fillHistory: Map<string, Array<{ side: 'bid' | 'ask'; time: number }>>,
  conditionId: string,
  side: 'bid' | 'ask',
  now: number,
  cfg: StrategyConfig,
): AdverseSelectionHit | null {
  const maxFills = cfg.maxFillsPerWindow ?? 3
  const windowMinutes = cfg.fillWindowMinutes ?? 15
  const blacklistMinutes = cfg.blacklistMinutes ?? 60
  const windowMs = windowMinutes * 60_000

  if (!fillHistory.has(conditionId)) fillHistory.set(conditionId, [])
  const hist = fillHistory.get(conditionId)!
  hist.push({ side, time: now })
  const pruned = hist.filter((e) => e.time >= now - windowMs)
  fillHistory.set(conditionId, pruned)
  const sameSideFills = pruned.filter((e) => e.side === side).length

  if (sameSideFills < maxFills) return null
  return {
    conditionId,
    blacklistUntil: now + blacklistMinutes * 60_000,
    sameSideFills,
    windowMinutes,
    blacklistMinutes,
  }
}

// Rolling-window realised PnL per market. When losses on a single market breach
// the threshold we blacklist it only; other markets keep running.
export function checkMarketDrawdown(
  marketPnlHistory: Map<string, Array<{ time: number; pnl: number }>>,
  blacklist: Map<string, number>,
  conditionId: string,
  pnl: number,
  now: number,
  cfg: StrategyConfig,
): MarketDrawdownHit | null {
  const lossLimitUsd = cfg.marketLossLimitUsd ?? 5
  if (lossLimitUsd <= 0 || blacklist.has(conditionId)) return null

  const windowHours = cfg.marketLossWindowHours ?? 24
  const windowMs = windowHours * 60 * 60_000
  const mhist = marketPnlHistory.get(conditionId) ?? []
  mhist.push({ time: now, pnl })
  const prunedPnl = mhist.filter((e) => e.time >= now - windowMs)
  marketPnlHistory.set(conditionId, prunedPnl)
  const windowPnl = prunedPnl.reduce((s, e) => s + e.pnl, 0)

  if (windowPnl > -lossLimitUsd) return null
  const blacklistMinutes = cfg.marketLossBlacklistMinutes ?? cfg.blacklistMinutes ?? 60
  return {
    conditionId,
    blacklistUntil: now + blacklistMinutes * 60_000,
    windowPnl,
    windowHours,
    lossLimitUsd,
    blacklistMinutes,
  }
}

// Rolling-window realised PnL across the whole portfolio. Sits on top of the
// per-market breaker so a broad bleed across many markets still trips even
// when no single market hits its cap. On hit, the caller pauses globally and
// closes every open position.
export function checkPortfolioDrawdown(
  portfolioPnlHistory: Array<{ time: number; pnl: number }>,
  globalPauseUntil: number,
  pnl: number,
  now: number,
  cfg: StrategyConfig,
): { history: Array<{ time: number; pnl: number }>; hit: PortfolioDrawdownHit | null } {
  const lossLimitUsd = cfg.globalLossLimitUsd ?? 15
  if (lossLimitUsd <= 0 || now < globalPauseUntil) {
    return { history: portfolioPnlHistory, hit: null }
  }

  const windowHours = cfg.globalLossWindowHours ?? 24
  const windowMs = windowHours * 60 * 60_000
  const updated = [...portfolioPnlHistory, { time: now, pnl }].filter((e) => e.time >= now - windowMs)
  const windowPnl = updated.reduce((s, e) => s + e.pnl, 0)

  if (windowPnl > -lossLimitUsd) return { history: updated, hit: null }
  const pauseMinutes = cfg.globalPauseMinutes ?? 120
  return {
    history: updated,
    hit: {
      globalPauseUntil: now + pauseMinutes * 60_000,
      windowPnl,
      windowHours,
      lossLimitUsd,
      pauseMinutes,
    },
  }
}
