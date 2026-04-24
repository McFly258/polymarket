import { Logger, OnModuleInit } from '@nestjs/common'
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets'
import type { Server, WebSocket } from 'ws'

import { EngineService } from '../engine/engine.service'

// The frontend connects to ws://host:7802/stream. On connect we send an initial
// snapshot; then the engine broadcasts a lightweight "tick" on state change so
// the client can refetch /state without polling.
@WebSocketGateway({ path: '/stream', cors: { origin: '*' } })
export class EngineGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  private readonly logger = new Logger(EngineGateway.name)
  private clients = new Set<WebSocket>()
  private pending = false

  @WebSocketServer()
  server!: Server

  constructor(private readonly engine: EngineService) {}

  onModuleInit(): void {
    this.engine.registerBroadcaster({
      onStateChange: () => this.scheduleBroadcast(),
    })
  }

  async handleConnection(client: WebSocket): Promise<void> {
    this.clients.add(client)
    try {
      const snap = await this.engine.snapshot()
      client.send(JSON.stringify({ type: 'snapshot', data: snap }))
    } catch (err) {
      this.logger.error('initial snapshot send failed', err as Error)
    }
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client)
  }

  // Coalesce book-churn into ~4 Hz broadcasts so we don't flood clients.
  private scheduleBroadcast(): void {
    if (this.pending) return
    this.pending = true
    setTimeout(() => {
      this.pending = false
      void this.broadcast()
    }, 250)
  }

  private async broadcast(): Promise<void> {
    if (this.clients.size === 0) return
    try {
      const snap = await this.engine.snapshot()
      const payload = JSON.stringify({ type: 'snapshot', data: snap })
      for (const c of this.clients) {
        if (c.readyState === 1) c.send(payload)
      }
    } catch (err) {
      this.logger.error('broadcast failed', err as Error)
    }
  }
}
