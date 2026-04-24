// Engine → real-execution event contract.
// The engine emits these after persisting the paper row, so the real-side
// listener always works from confirmed state. `decisionId` is the join key
// between paper and real rows (non-null for every event).

import type { OrderRow } from '../modules/persistence/order.repo'
import type { FillRow } from '../modules/persistence/fill.repo'

export const ENGINE_EVENT = {
  ORDER_PLACED: 'engine.order.placed',
  ORDER_CANCELLED: 'engine.order.cancelled',
  ORDER_FILLED: 'engine.order.filled',
} as const

export interface OrderPlacedEvent {
  decisionId: string
  paperOrder: OrderRow
}

export interface OrderCancelledEvent {
  decisionId: string | null
  paperOrderId: string
  at: number
}

export interface OrderFilledEvent {
  decisionId: string | null
  paperFill: FillRow
  hedgeSide: 'buy' | 'sell'
  hedgeExpectedPrice: number
  hedgeFillPrice: number
  tokenId: string
  // Paper decided the fill was un-hedgeable (slip > cap). The real side must
  // not dispatch a market hedge here — mirroring the paper "passive hedge" path
  // keeps the two sides comparable and avoids unbounded market-order slippage.
  isPassiveHedge: boolean
}

export function newDecisionId(): string {
  return `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
