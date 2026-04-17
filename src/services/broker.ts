// Broker interface — abstracts order placement so the engine doesn't care
// whether it's running paper (PaperBroker) or hooked to a real CLOB account
// (future LiveBroker that signs orders + calls /order).
//
// Every order returned by the broker has a stable id; the engine uses this id
// when reasoning about its own resting orders vs. cancelling them.

export type OrderSide = 'buy' | 'sell'

export interface PlaceOrderRequest {
  conditionId: string
  tokenId: string
  side: OrderSide
  /** Limit price in dollars (0..1 for binary outcomes). */
  price: number
  /** Number of outcome shares. */
  size: number
  /** Free-form tag the engine can use to recognise its own orders later. */
  clientTag?: string
}

export interface PlaceOrderResult {
  id: string
  request: PlaceOrderRequest
  acceptedAt: number
}

export interface MarketHedgeRequest {
  conditionId: string
  tokenId: string
  side: OrderSide
  size: number
  /** Reference price the engine *expected* to cross at (for slippage accounting). */
  expectedPrice: number
  /** Actual top-of-book price the engine sees right now — used as the fill price. */
  fillPrice: number
}

export interface MarketHedgeResult {
  id: string
  request: MarketHedgeRequest
  fillPrice: number
  filledAt: number
}

export interface Broker {
  /** Identifier so UI can show whether it's the paper or live driver. */
  readonly kind: 'paper' | 'live'
  /** Post a resting limit order. Resolves once the venue accepts it. */
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>
  /** Cancel a resting order. No-op if id is unknown. */
  cancelOrder(id: string): Promise<void>
  /** Cross the spread to flatten inventory. Resolves with the realised fill. */
  marketHedge(req: MarketHedgeRequest): Promise<MarketHedgeResult>
}

let counter = 0
function genId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}

/**
 * Paper broker — accepts every order, persists nothing remotely. The trading
 * engine is the source of truth for fills; the broker just hands back ids.
 */
export class PaperBroker implements Broker {
  readonly kind = 'paper' as const

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    return { id: genId('paper-ord'), request: req, acceptedAt: Date.now() }
  }

  async cancelOrder(): Promise<void> {
    // Paper broker has nothing to cancel server-side.
  }

  async marketHedge(req: MarketHedgeRequest): Promise<MarketHedgeResult> {
    return { id: genId('paper-hedge'), request: req, fillPrice: req.fillPrice, filledAt: Date.now() }
  }
}
