import { Module } from '@nestjs/common'

import { EngineModule } from '../engine/engine.module'
import { EngineGateway } from './engine.gateway'

@Module({
  imports: [EngineModule],
  providers: [EngineGateway],
})
export class GatewayModule {}
