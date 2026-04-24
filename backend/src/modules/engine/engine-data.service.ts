import { Injectable } from '@nestjs/common'

import type { MarketVolatility } from '../../domain/strategy.types'
import { MarketRestService } from '../polymarket/market-rest.service'

@Injectable()
export class EngineDataService {
  constructor(private readonly rest: MarketRestService) {}

  fetchRewardsRows() {
    return this.rest.fetchRewardsRows()
  }

  // Volatility historically comes from a separate collector pipeline. The new
  // backend doesn't ship that pipeline yet, so we return an empty record; the
  // allocator and risk gates treat "no volatility data" as "no objection".
  loadVolatility(): Record<string, MarketVolatility> {
    return {}
  }
}
