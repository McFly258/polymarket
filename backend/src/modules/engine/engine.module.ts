import { Module } from '@nestjs/common'

import { BROKER_TOKEN } from '../../domain/broker.types'
import { PersistenceModule } from '../persistence/persistence.module'
import { PolymarketModule } from '../polymarket/polymarket.module'
import { RealExecutionModule } from '../real-execution/real-execution.module'

import { EngineAllocService } from './engine-alloc.service'
import { EngineDataService } from './engine-data.service'
import { EngineFillService } from './engine-fill.service'
import { EngineRewardsService } from './engine-rewards.service'
import { EngineService } from './engine.service'
import { EngineController } from './engine.controller'
import { PaperBroker } from './paper-broker'

@Module({
  imports: [PersistenceModule, PolymarketModule, RealExecutionModule],
  controllers: [EngineController],
  providers: [
    {
      provide: BROKER_TOKEN,
      useClass: PaperBroker,
    },
    EngineDataService,
    EngineAllocService,
    EngineFillService,
    EngineRewardsService,
    EngineService,
  ],
  exports: [EngineService],
})
export class EngineModule {}
