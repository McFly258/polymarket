import { Module } from '@nestjs/common'

import { MarketRestService } from './market-rest.service'
import { MarketWsService } from './market-ws.service'

@Module({
  providers: [MarketRestService, MarketWsService],
  exports: [MarketRestService, MarketWsService],
})
export class PolymarketModule {}
