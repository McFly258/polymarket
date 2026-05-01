import { Injectable } from '@nestjs/common'

import type { MarketVolatility } from '../../domain/strategy.types'
import { MarketRestService } from '../polymarket/market-rest.service'

@Injectable()
export class EngineDataService {
  constructor(private readonly rest: MarketRestService) {}

  fetchRewardsRows() {
    return this.rest.fetchRewardsRows()
  }

  loadVolatility(
    history: Map<string, { ts: number; mid: number }[]>,
  ): Record<string, MarketVolatility> {
    const result: Record<string, MarketVolatility> = {}
    for (const [conditionId, samples] of history) {
      if (samples.length < 2) continue
      const sorted = [...samples].sort((a, b) => a.ts - b.ts)
      const changes = sorted.slice(1).map((s, i) => s.mid - sorted[i].mid)
      const mean = changes.reduce((a, b) => a + b, 0) / changes.length
      const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length
      const stepStddev = Math.sqrt(variance)
      const spanMs = sorted[sorted.length - 1].ts - sorted[0].ts
      const intervalMs = spanMs / (sorted.length - 1)
      const barsPerDay = (24 * 60 * 60 * 1000) / intervalMs
      result[conditionId] = {
        conditionId,
        dailyStddevDollars: stepStddev * Math.sqrt(barsPerDay),
        samples: samples.length,
        hoursCovered: spanMs / (60 * 60 * 1000),
      }
    }
    return result
  }
}
