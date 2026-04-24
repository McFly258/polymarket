// Paper broker — simulates order placement/cancellation without touching any
// real exchange. All orders get synthetic IDs; fills are detected by the engine
// when the WS book crosses our posted price.

import type { Broker, MarketHedgeRequest, MarketHedgeResult, PlaceOrderRequest, PlaceOrderResult } from '../../domain/broker.types'

export class PaperBroker implements Broker {
  readonly kind = 'paper' as const

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const id = `paper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return { id, request: req, acceptedAt: Date.now() }
  }

  async cancelOrder(_id: string): Promise<void> {
    // No-op for paper trading; the engine marks the order cancelled in Postgres.
  }

  async marketHedge(req: MarketHedgeRequest): Promise<MarketHedgeResult> {
    const id = `hedge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return {
      id,
      request: req,
      fillPrice: req.fillPrice,
      filledAt: Date.now(),
    }
  }
}
