import { Module } from '@nestjs/common'

import { PrismaModule } from '../prisma/prisma.module'
import { CapitalRepo } from './capital.repo'
import { EngineStateRepo } from './engine-state.repo'
import { FillRepo } from './fill.repo'
import { OrderRepo } from './order.repo'
import { PositionRepo } from './position.repo'
import { RewardRepo } from './reward.repo'

@Module({
  imports: [PrismaModule],
  providers: [EngineStateRepo, RewardRepo, OrderRepo, FillRepo, PositionRepo, CapitalRepo],
  exports: [EngineStateRepo, RewardRepo, OrderRepo, FillRepo, PositionRepo, CapitalRepo],
})
export class PersistenceModule {}
