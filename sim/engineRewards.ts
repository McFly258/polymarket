// Reward accrual + hourly snapshot.
//
// Split from engine.ts for file size / readability. Operates on the
// BackendPaperEngine's public state fields; the engine still owns all state.

import {
  insertPositionRewardHourly,
  upsertPosition,
  upsertRewardHourly,
  writeReward,
} from './db.ts'
import { competingScore, levelScore } from './engineConstants.ts'
import type { BackendPaperEngine } from './engine.ts'

export function accrueRewards(engine: BackendPaperEngine): void {
  if (engine.state !== 'running') return
  // Recompute scores inline so the reward rate we persist is fresh.
  let totalRate = 0
  const now = Date.now()
  const elapsedDays = (now - engine.rewardLastUpdatedAt) / (24 * 60 * 60 * 1000)

  for (const pos of engine.positions.values()) {
    const view = pos.latestBook
    if (!view || view.mid === null || !engine.config) continue
    const mid = view.mid
    const ourBidScore = levelScore(mid - pos.bidPrice, pos.bidPrice * pos.bidSize, pos.maxSpreadDollars)
    const ourAskScore = levelScore(pos.askPrice - mid, pos.askPrice * pos.askSize, pos.maxSpreadDollars)
    const compBid = competingScore(view.bids, mid, pos.maxSpreadDollars, 'bid')
    const compAsk = competingScore(view.asks, mid, pos.maxSpreadDollars, 'ask')
    const bidShare = ourBidScore > 0 ? ourBidScore / (ourBidScore + compBid) : 0
    const askShare = ourAskScore > 0 ? ourAskScore / (ourAskScore + compAsk) : 0
    pos.ourScore = ourBidScore + ourAskScore
    pos.totalScore = pos.ourScore + compBid + compAsk
    pos.rewardSharePct = ((bidShare + askShare) / 2) * 100
    pos.expectedRatePerDay = (pos.dailyPool / 2) * bidShare + (pos.dailyPool / 2) * askShare
    totalRate += pos.expectedRatePerDay

    // Accumulate per-position incremental earned (for hourly snapshot).
    const posIncrement = pos.expectedRatePerDay * elapsedDays
    pos.totalEarnedUsd = (pos.totalEarnedUsd ?? 0) + posIncrement
    pos.earnedSinceLastSnapshot = (pos.earnedSinceLastSnapshot ?? 0) + posIncrement

    upsertPosition(engine.toRow(pos, now))
  }

  engine.rewardTotal += engine.rewardLastRate * elapsedDays
  engine.rewardLastRate = totalRate
  engine.rewardLastUpdatedAt = now
  writeReward({ totalEarnedUsd: engine.rewardTotal, lastRatePerDay: engine.rewardLastRate, lastUpdatedAt: now })
}

export function takeHourlySnapshot(engine: BackendPaperEngine): void {
  if (engine.state !== 'running') return
  const now = Date.now()
  const hourEpoch = Math.floor(now / 3_600_000) * 3_600_000

  upsertRewardHourly({
    hourEpoch,
    snapshotAt: now,
    totalEarnedUsd: engine.rewardTotal,
    ratePerDay: engine.rewardLastRate,
  })

  const posRows = Array.from(engine.positions.values()).map((pos) => ({
    hourEpoch,
    snapshotAt: now,
    conditionId: pos.conditionId,
    question: pos.question,
    rewardSharePct: pos.rewardSharePct,
    expectedRatePerDay: pos.expectedRatePerDay,
    earnedThisHourUsd: pos.earnedSinceLastSnapshot,
  }))
  if (posRows.length > 0) insertPositionRewardHourly(posRows)

  // Reset per-position incremental counter after snapshot.
  for (const pos of engine.positions.values()) pos.earnedSinceLastSnapshot = 0

  console.log(`[engine] hourly snapshot — total earned $${engine.rewardTotal.toFixed(4)}, ${posRows.length} positions`)
}
