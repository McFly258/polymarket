import type { BookLevel, BookView } from '../api/polymarket'

// Polymarket CLOB market websocket — public, no auth required.
// A single connection subscribes to a set of assets_ids and receives book /
// price_change / tick_size_change / last_trade_price events for each of them.
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

// Polymarket occasionally disconnects large subscriptions; keep the slices
// small enough that any single reconnect is cheap.
const MAX_IDS_PER_SOCKET = 200

// Cap on total assets we subscribe to via WS. Top 200 markets × 2 tokens = 400
// token ids. The other markets still appear in the table (sourced from the
// periodic HTTP resync) but don't get live WS tracking. This keeps the
// number of sockets to 2 and the per-message work on the main thread minimal.
const MAX_STREAMED_ASSETS = 400

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

interface RawBookMsg {
  event_type: 'book'
  asset_id: string
  market: string
  bids: Array<{ price: string; size: string }>
  asks: Array<{ price: string; size: string }>
  timestamp: string
  hash: string
}

interface PriceChangeMsg {
  event_type: 'price_change'
  asset_id: string
  market: string
  changes: Array<{ price: string; side: 'BUY' | 'SELL'; size: string }>
  timestamp: string
  hash: string
}

type IncomingMsg = RawBookMsg | PriceChangeMsg | { event_type: string; asset_id?: string }

export interface WsClientOptions {
  /** Called with the updated view whenever a book changes. */
  onBook: (tokenId: string, view: BookView) => void
  /** Notified any time the aggregate connection state changes. */
  onStatus?: (state: ConnectionState, info: { streamed: number; totalRequested: number }) => void
  /** Initial books we already have from HTTP — used as the seed state for diffs. */
  seedBooks?: Map<string, BookView>
}

function sortBids(levels: BookLevel[]): BookLevel[] {
  return [...levels].sort((a, b) => b.price - a.price)
}

function sortAsks(levels: BookLevel[]): BookLevel[] {
  return [...levels].sort((a, b) => a.price - b.price)
}

function recomputeMeta(bids: BookLevel[], asks: BookLevel[]): Pick<BookView, 'bestBid' | 'bestAsk' | 'mid' | 'spread'> {
  const bestBid = bids[0]?.price ?? null
  const bestAsk = asks[0]?.price ?? null
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null
  return { bestBid, bestAsk, mid, spread }
}

function viewFromRawBook(msg: RawBookMsg): BookView {
  const bids = sortBids(
    (msg.bids ?? [])
      .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size)),
  )
  const asks = sortAsks(
    (msg.asks ?? [])
      .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size)),
  )
  return { bids, asks, ...recomputeMeta(bids, asks) }
}

function applyPriceChange(prev: BookView | undefined, changes: PriceChangeMsg['changes']): BookView {
  const bids = new Map<number, number>()
  const asks = new Map<number, number>()
  if (prev) {
    for (const l of prev.bids) bids.set(l.price, l.size)
    for (const l of prev.asks) asks.set(l.price, l.size)
  }
  for (const c of changes) {
    const price = parseFloat(c.price)
    const size = parseFloat(c.size)
    if (!Number.isFinite(price)) continue
    const map = c.side === 'BUY' ? bids : asks
    if (!Number.isFinite(size) || size === 0) {
      map.delete(price)
    } else {
      map.set(price, size)
    }
  }
  const bidArr = sortBids([...bids.entries()].map(([price, size]) => ({ price, size })))
  const askArr = sortAsks([...asks.entries()].map(([price, size]) => ({ price, size })))
  return { bids: bidArr, asks: askArr, ...recomputeMeta(bidArr, askArr) }
}

/**
 * One websocket per 200 assets; each socket reconnects independently with
 * exponential backoff. The shard aggregator exposes a single status derived
 * from the worst-performing socket.
 */
interface ShardHandlers {
  onMsg: (msg: IncomingMsg) => void
  onState: (state: ConnectionState) => void
}

class Shard {
  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private timer: number | null = null
  private readonly ids: string[]
  private readonly handlers: ShardHandlers
  state: ConnectionState = 'idle'

  constructor(ids: string[], handlers: ShardHandlers) {
    this.ids = ids
    this.handlers = handlers
  }

  start(): void {
    if (this.closed) return
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.addEventListener('open', () => {
      this.attempt = 0
      this.setState('open')
      ws.send(JSON.stringify({ type: 'market', assets_ids: this.ids }))
    })
    ws.addEventListener('message', (evt) => {
      const raw = typeof evt.data === 'string' ? evt.data : ''
      if (!raw || raw === 'PONG' || raw === 'pong') return
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          for (const m of parsed) this.handlers.onMsg(m as IncomingMsg)
        } else {
          this.handlers.onMsg(parsed as IncomingMsg)
        }
      } catch {
        // malformed frame — ignore, next snapshot will heal us
      }
    })
    ws.addEventListener('close', () => this.scheduleReconnect())
    ws.addEventListener('error', () => {
      try {
        ws.close()
      } catch {
        /* noop */
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.closed) {
      this.setState('closed')
      return
    }
    this.setState('reconnecting')
    const backoff = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6))
    this.attempt += 1
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.start(), backoff)
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* noop */
      }
    }
    this.setState('closed')
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return
    this.state = next
    this.handlers.onState(next)
  }
}

export interface WsClient {
  stop: () => void
  streamedCount: number
}

export function startMarketStream(
  tokenIds: string[],
  { onBook, onStatus, seedBooks }: WsClientOptions,
): WsClient {
  const streamIds = tokenIds.slice(0, MAX_STREAMED_ASSETS)
  const books = new Map<string, BookView>()
  if (seedBooks) {
    for (const id of streamIds) {
      const seed = seedBooks.get(id)
      if (seed) books.set(id, seed)
    }
  }

  const shards: Shard[] = []
  for (let i = 0; i < streamIds.length; i += MAX_IDS_PER_SOCKET) {
    const slice = streamIds.slice(i, i + MAX_IDS_PER_SOCKET)
    const shard = new Shard(slice, {
      onMsg: (msg) => {
        if (!msg || !msg.event_type) return
        if (msg.event_type === 'book') {
          const bm = msg as RawBookMsg
          const view = viewFromRawBook(bm)
          books.set(bm.asset_id, view)
          onBook(bm.asset_id, view)
        } else if (msg.event_type === 'price_change') {
          const pm = msg as PriceChangeMsg
          const view = applyPriceChange(books.get(pm.asset_id), pm.changes)
          books.set(pm.asset_id, view)
          onBook(pm.asset_id, view)
        }
      },
      onState: () => {
        if (!onStatus) return
        const worst = aggregate(shards.map((s) => s.state))
        onStatus(worst, { streamed: streamIds.length, totalRequested: tokenIds.length })
      },
    })
    shards.push(shard)
  }

  for (const s of shards) s.start()

  return {
    stop: () => shards.forEach((s) => s.close()),
    streamedCount: streamIds.length,
  }
}

function aggregate(states: ConnectionState[]): ConnectionState {
  if (states.length === 0) return 'idle'
  // Worst wins: closed > reconnecting > connecting > idle > open
  if (states.some((s) => s === 'closed')) return 'closed'
  if (states.some((s) => s === 'reconnecting')) return 'reconnecting'
  if (states.some((s) => s === 'connecting')) return 'connecting'
  if (states.every((s) => s === 'open')) return 'open'
  return 'connecting'
}
