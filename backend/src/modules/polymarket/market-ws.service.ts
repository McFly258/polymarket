import { Injectable, Logger } from '@nestjs/common'
import WebSocket from 'ws'

import type { BookLevel, BookView, ConnectionState } from '../../domain/book.types'

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const MAX_IDS_PER_SOCKET = 200

interface RawBookMsg {
  event_type: 'book'
  asset_id: string
  bids: Array<{ price: string; size: string }>
  asks: Array<{ price: string; size: string }>
}

interface PriceChangeMsg {
  event_type: 'price_change'
  asset_id: string
  changes: Array<{ price: string; side: 'BUY' | 'SELL'; size: string }>
}

type IncomingMsg = RawBookMsg | PriceChangeMsg | { event_type: string; asset_id?: string }

export interface WsClient {
  stop: () => void
  readonly streamedCount: number
}

export interface WsClientOptions {
  onBook: (tokenId: string, view: BookView) => void
  onStatus?: (state: ConnectionState, info: { streamed: number }) => void
}

function sortBids(levels: BookLevel[]): BookLevel[] {
  return [...levels].sort((a, b) => b.price - a.price)
}
function sortAsks(levels: BookLevel[]): BookLevel[] {
  return [...levels].sort((a, b) => a.price - b.price)
}
function recomputeMeta(
  bids: BookLevel[],
  asks: BookLevel[],
): Pick<BookView, 'bestBid' | 'bestAsk' | 'mid' | 'spread'> {
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
    if (!Number.isFinite(size) || size === 0) map.delete(price)
    else map.set(price, size)
  }
  const bidArr = sortBids([...bids.entries()].map(([price, size]) => ({ price, size })))
  const askArr = sortAsks([...asks.entries()].map(([price, size]) => ({ price, size })))
  return { bids: bidArr, asks: askArr, ...recomputeMeta(bidArr, askArr) }
}

function aggregateState(states: ConnectionState[]): ConnectionState {
  if (states.length === 0) return 'idle'
  if (states.some((s) => s === 'closed')) return 'closed'
  if (states.some((s) => s === 'reconnecting')) return 'reconnecting'
  if (states.some((s) => s === 'connecting')) return 'connecting'
  if (states.every((s) => s === 'open')) return 'open'
  return 'connecting'
}

interface ShardHandlers {
  onMsg: (msg: IncomingMsg) => void
  onState: (state: ConnectionState) => void
}

class Shard {
  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private timer: NodeJS.Timeout | null = null
  state: ConnectionState = 'idle'
  private readonly ids: string[]
  private readonly handlers: ShardHandlers

  constructor(ids: string[], handlers: ShardHandlers) {
    this.ids = ids
    this.handlers = handlers
  }

  start(): void {
    if (this.closed) return
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.on('open', () => {
      this.attempt = 0
      this.setState('open')
      ws.send(JSON.stringify({ type: 'market', assets_ids: this.ids }))
    })
    ws.on('message', (data: WebSocket.RawData) => {
      const raw = data.toString()
      if (!raw || raw === 'PONG' || raw === 'pong') return
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          for (const m of parsed) this.handlers.onMsg(m as IncomingMsg)
        } else {
          this.handlers.onMsg(parsed as IncomingMsg)
        }
      } catch {
        // malformed frame
      }
    })
    ws.on('close', () => this.scheduleReconnect())
    ws.on('error', () => {
      try { ws.close() } catch { /* noop */ }
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
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.start(), backoff)
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.ws) {
      try { this.ws.close() } catch { /* noop */ }
    }
    this.setState('closed')
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return
    this.state = next
    this.handlers.onState(next)
  }
}

@Injectable()
export class MarketWsService {
  private readonly logger = new Logger(MarketWsService.name)

  startStream(tokenIds: string[], opts: WsClientOptions): WsClient {
    const books = new Map<string, BookView>()
    const shards: Shard[] = []
    const logger = this.logger
    for (let i = 0; i < tokenIds.length; i += MAX_IDS_PER_SOCKET) {
      const slice = tokenIds.slice(i, i + MAX_IDS_PER_SOCKET)
      const shard = new Shard(slice, {
        onMsg: (msg) => {
          if (!msg || !msg.event_type) return
          if (msg.event_type === 'book') {
            const bm = msg as RawBookMsg
            const view = viewFromRawBook(bm)
            books.set(bm.asset_id, view)
            opts.onBook(bm.asset_id, view)
          } else if (msg.event_type === 'price_change') {
            const pm = msg as PriceChangeMsg
            const view = applyPriceChange(books.get(pm.asset_id), pm.changes)
            books.set(pm.asset_id, view)
            opts.onBook(pm.asset_id, view)
          }
        },
        onState: () => {
          const worst = aggregateState(shards.map((s) => s.state))
          if (worst === 'open') logger.log(`ws open — streaming ${tokenIds.length} tokens`)
          opts.onStatus?.(worst, { streamed: tokenIds.length })
        },
      })
      shards.push(shard)
    }
    for (const s of shards) s.start()
    return {
      stop: () => shards.forEach((s) => s.close()),
      streamedCount: tokenIds.length,
    }
  }
}
