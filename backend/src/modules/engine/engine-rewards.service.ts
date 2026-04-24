import { Injectable } from '@nestjs/common'

import { competingScore, levelScore } from '../../domain/constants'
import { CapitalRepo } from '../persistence/capital.repo'
import { PositionRepo } from '../persistence/position.repo'
import { RewardRepo } from '../persistence/reward.repo'

import type { EngineRuntimeState } from './engine-state'
import { positionRowFromInternal } from './engine-state'

@Injectable()
export class EngineRewardsService {
  constructor(
    private readonly rewardRepo: RewardRepo,
    private readonly positionRepo: PositionRepo,
    private readonly capitalRepo: CapitalRepo,
  ) {}

  async accrue(s: EngineRuntimeState): Promise<void> {
    if (s.state !== 'running' || !s.config) return

    const now = Date.now()
    const elapsedDays = (now - s.rewardLastUpdatedAt) / (24 * 60 * 60 * 1000)
    let totalRate = 0

    const positionWrites: Array<ReturnType<typeof positionRowFromInternal>> = []
    for (const pos of s.positions.values()) {
      const view = pos.latestBook
      if (!view || view.mid === null) continue
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

      const posIncrement = pos.expectedRatePerDay * elapsedDays
      pos.totalEarnedUsd = (pos.totalEarnedUsd ?? 0) + posIncrement
      pos.earnedSinceLastSnapshot = (pos.earnedSinceLastSnapshot ?? 0) + posIncrement

      positionWrites.push(positionRowFromInternal(pos, now))
    }

    s.rewardTotal += s.rewardLastRate * elapsedDays
    s.rewardLastRate = totalRate
    s.rewardLastUpdatedAt = now

    await Promise.all(positionWrites.map((p) => this.positionRepo.upsert(p)))
    await this.rewardRepo.write({
      totalEarnedUsd: s.rewardTotal,
      lastRatePerDay: s.rewardLastRate,
      lastUpdatedAt: now,
    })
  }

  async takeHourlySnapshot(s: EngineRuntimeState): Promise<void> {
    if (s.state !== 'running') return
    const now = Date.now()
    const hourEpoch = Math.floor(now / 3_600_000) * 3_600_000

    let totalCapitalUsd = 0
    for (const pos of s.positions.values()) totalCapitalUsd += pos.capitalUsd ?? 0

    await this.rewardRepo.upsertHourly({
      hourEpoch,
      snapshotAt: now,
      totalEarnedUsd: s.rewardTotal,
      ratePerDay: s.rewardLastRate,
      totalCapitalUsd,
    })

    const posRows = Array.from(s.positions.values()).map((pos) => ({
      hourEpoch,
      snapshotAt: now,
      conditionId: pos.conditionId,
      question: pos.question,
      rewardSharePct: pos.rewardSharePct,
      expectedRatePerDay: pos.expectedRatePerDay,
      earnedThisHourUsd: pos.earnedSinceLastSnapshot,
    }))
    if (posRows.length > 0) await this.rewardRepo.insertPositionHourly(posRows)

    for (const pos of s.positions.values()) pos.earnedSinceLastSnapshot = 0
  }

  async takeCapitalSample(s: EngineRuntimeState): Promise<void> {
    if (s.state !== 'running') return
    const now = Date.now()
    const CAPITAL_SAMPLE_MS = 5 * 60_000
    const bucketEpoch = Math.floor(now / CAPITAL_SAMPLE_MS) * CAPITAL_SAMPLE_MS
    let totalCapitalUsd = 0
    for (const pos of s.positions.values()) totalCapitalUsd += pos.capitalUsd ?? 0
    await this.capitalRepo.upsert({ bucketEpoch, sampledAt: now, totalCapitalUsd })
  }
}
