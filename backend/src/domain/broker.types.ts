export type OrderSide = 'buy' | 'sell'

export interface PlaceOrderRequest {
  conditionId: string
  tokenId: string
  side: OrderSide
  price: number
  size: number
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
  expectedPrice: number
  fillPrice: number
}

export interface MarketHedgeResult {
  id: string
  request: MarketHedgeRequest
  fillPrice: number
  filledAt: number
}

export interface Broker {
  readonly kind: 'paper' | 'live'
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>
  cancelOrder(id: string): Promise<void>
  marketHedge(req: MarketHedgeRequest): Promise<MarketHedgeResult>
}

export const BROKER_TOKEN = 'BROKER_TOKEN'
