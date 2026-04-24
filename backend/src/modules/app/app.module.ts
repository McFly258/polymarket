import { Module } from '@nestjs/common'

import { AppConfigModule } from '../config/config.module'
import { EngineModule } from '../engine/engine.module'
import { GatewayModule } from '../gateway/gateway.module'
import { HealthModule } from '../health/health.module'
import { PersistenceModule } from '../persistence/persistence.module'
import { PolymarketModule } from '../polymarket/polymarket.module'
import { PrismaModule } from '../prisma/prisma.module'

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    PersistenceModule,
    PolymarketModule,
    HealthModule,
    EngineModule,
    GatewayModule,
  ],
})
export class AppModule {}
