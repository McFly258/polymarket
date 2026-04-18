// Vite middleware that serves /api/polymarket/* from the SQLite snapshot DB.
// Mirrors funding-rate/sim/vite-plugin.ts.

import type { IncomingMessage, ServerResponse } from 'http'
import type { Plugin } from 'vite'
import {
  getBookHistoryByMarket, getLatestBooks, getLatestMarkets,
  getMarketVolatility, getRewardHistory, getStats,
} from './db.ts'

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(data))
}

function apiSummary() {
  const markets = getLatestMarkets()
  const books = getLatestBooks()
  const booksByCondition = new Map<string, typeof books>()
  for (const b of books) {
    const arr = booksByCondition.get(b.condition_id) ?? []
    arr.push(b)
    booksByCondition.set(b.condition_id, arr)
  }

  const rows = markets.map((m) => {
    const outcomeBooks = (booksByCondition.get(m.condition_id) ?? []).map((b) => {
      const withinBand =
        b.spread !== null && b.mid !== null
          ? b.spread <= 2 * (m.max_spread / 100)
          : null
      return {
        tokenId: b.token_id,
        outcome: b.outcome,
        bestBid: b.best_bid,
        bestAsk: b.best_ask,
        mid: b.mid,
        spread: b.spread,
        qualifyingBidSize: b.qualifying_bid_size,
        qualifyingAskSize: b.qualifying_ask_size,
        totalBidSize: b.total_bid_size,
        totalAskSize: b.total_ask_size,
        withinBand,
      }
    })
    const eligibleSides = outcomeBooks.filter((b) => b.withinBand === true).length
    return {
      conditionId: m.condition_id,
      slug: m.slug,
      question: m.question,
      endDateIso: m.end_date_iso,
      tags: JSON.parse(m.tags || '[]') as string[],
      minOrderSize: m.min_order_size,
      minTickSize: m.min_tick_size,
      rewardMinSize: m.min_size,
      rewardMaxSpread: m.max_spread,
      dailyRate: m.daily_rate,
      acceptingOrders: m.accepting_orders === 1,
      ts: m.ts,
      books: outcomeBooks,
      eligibleSides,
    }
  })

  const stats = getStats()
  const dailyPool = rows.reduce((s, r) => s + r.dailyRate, 0)
  const inBand = rows.filter((r) => r.eligibleSides === r.books.length && r.books.length > 0).length

  return {
    updatedAt: stats.last_ts ? new Date(stats.last_ts).toISOString() : null,
    totals: {
      markets: rows.length,
      dailyPool,
      eligibleMarkets: inBand,
    },
    stats,
    rows,
  }
}

function apiMarketHistory(conditionId: string) {
  const rewards = getRewardHistory(conditionId)
  const books = getBookHistoryByMarket(conditionId)
  return { rewards, books }
}

function handleRequest(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (!req.url?.startsWith('/api/polymarket')) return next()

  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  try {
    if (path === '/api/polymarket/summary') return json(res, apiSummary())
    if (path === '/api/polymarket/market-history') {
      const cid = url.searchParams.get('condition_id') ?? ''
      if (!cid) { res.writeHead(400); res.end('missing condition_id'); return }
      return json(res, apiMarketHistory(cid))
    }
    if (path === '/api/polymarket/stats') return json(res, getStats())
    if (path === '/api/polymarket/volatility') {
      const hours = Number(url.searchParams.get('hours') ?? '24') || 24
      const topN = Number(url.searchParams.get('top') ?? '400') || 400
      return json(res, { windowHours: hours, volatility: getMarketVolatility(hours, topN) })
    }
    next()
  } catch (err) {
    console.error('[polymarket-api]', err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
}

export default function polymarketApiPlugin(): Plugin {
  return {
    name: 'polymarket-api',
    configureServer(server) { server.middlewares.use(handleRequest) },
    configurePreviewServer(server) { server.middlewares.use(handleRequest) },
  }
}
