import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'

import {
  ENGINE_EVENT,
  type OrderCancelledEvent,
  type OrderFilledEvent,
  type OrderPlacedEvent,
} from '../../domain/events'

import { ClobBroker } from './clob-broker'

@Injectable()
export class RealExecutionListener {
  private readonly logger = new Logger(RealExecutionListener.name)

  constructor(private readonly clob: ClobBroker) {}

  @OnEvent(ENGINE_EVENT.ORDER_PLACED, { async: true, promisify: true })
  async handleOrderPlaced(evt: OrderPlacedEvent): Promise<void> {
    try {
      await this.clob.onOrderPlaced(evt)
    } catch (err) {
      this.logger.error(
        `handleOrderPlaced failed (decision ${evt.decisionId}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  @OnEvent(ENGINE_EVENT.ORDER_CANCELLED, { async: true, promisify: true })
  async handleOrderCancelled(evt: OrderCancelledEvent): Promise<void> {
    try {
      await this.clob.onOrderCancelled(evt)
    } catch (err) {
      this.logger.error(
        `handleOrderCancelled failed (paperOrder ${evt.paperOrderId}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  @OnEvent(ENGINE_EVENT.ORDER_FILLED, { async: true, promisify: true })
  async handleOrderFilled(evt: OrderFilledEvent): Promise<void> {
    try {
      await this.clob.onOrderFilled(evt)
    } catch (err) {
      this.logger.error(
        `handleOrderFilled failed (paperFill ${evt.paperFill.id}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
