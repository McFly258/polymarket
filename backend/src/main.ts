import { ValidationPipe, Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { WsAdapter } from '@nestjs/platform-ws'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'

import { AppModule } from './modules/app/app.module'
import { AppConfigService } from './modules/config/config.service'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false })
  const logger = new Logger('bootstrap')

  app.enableCors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'] })
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
  app.useWebSocketAdapter(new WsAdapter(app))
  app.enableShutdownHooks()

  const cfg = app.get(AppConfigService)

  if (cfg.environment !== 'production') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Polymarket Paper Backend')
        .setDescription('NestJS port of the paper-trading engine (Postgres).')
        .setVersion('0.1.0')
        .build(),
    )
    SwaggerModule.setup('docs', app, doc)
  }

  await app.listen(cfg.port, cfg.host)
  logger.log(`listening on http://${cfg.host}:${cfg.port}`)
}

void bootstrap()
