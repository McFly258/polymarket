import { Module } from '@nestjs/common'

import { PersistenceModule } from '../persistence/persistence.module'
import { PrismaModule } from '../prisma/prisma.module'

import { ClobBroker } from './clob-broker'
import { RealExecutionController } from './real-execution.controller'
import { RealExecutionListener } from './real-execution.listener'
import { RealFillRepo } from './real-fill.repo'
import { RealOrderRepo } from './real-order.repo'
import { RealPositionRepo } from './real-position.repo'
import { RealStateRepo } from './real-state.repo'

@Module({
  imports: [PrismaModule, PersistenceModule],
  controllers: [RealExecutionController],
  providers: [
    RealOrderRepo,
    RealFillRepo,
    RealPositionRepo,
    RealStateRepo,
    ClobBroker,
    RealExecutionListener,
  ],
  exports: [ClobBroker, RealStateRepo, RealOrderRepo, RealFillRepo, RealPositionRepo],
})
export class RealExecutionModule {}
