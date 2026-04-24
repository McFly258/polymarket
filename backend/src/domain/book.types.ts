// Shapes shared by the WS client and the engine. Kept in domain/ so neither
// the engine nor the WS service has to import the other's module to read them.

export interface BookLevel {
  price: number
  size: number
}

export interface BookView {
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  spread: number | null
  bids: BookLevel[]
  asks: BookLevel[]
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
