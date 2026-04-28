import { Module } from '@nestjs/common'
import { EventEmitterModule } from '@nestjs/event-emitter'

import { AppConfigModule } from '../config/config.module'
import { EngineModule } from '../engine/engine.module'
import { GatewayModule } from '../gateway/gateway.module'
import { HealthModule } from '../health/health.module'
import { PersistenceModule } from '../persistence/persistence.module'
import { PolymarketModule } from '../polymarket/polymarket.module'
import { PrismaModule } from '../prisma/prisma.module'
import { RealExecutionModule } from '../real-execution/real-execution.module'

@Module({
  imports: [
    AppConfigModule,
    EventEmitterModule.forRoot(),
    PrismaModule,
    PersistenceModule,
    PolymarketModule,
    HealthModule,
    // RealExecutionModule before EngineModule so its onModuleInit (cancel-all
    // + liquidate) completes before the engine resumes and starts placing
    // fresh orders.
    RealExecutionModule,
    EngineModule,
    GatewayModule,
  ],
})
export class AppModule {}
