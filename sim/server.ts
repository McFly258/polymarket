#!/usr/bin/env node
// HTTP control/readback server for the backend paper-trading engine.
//
// Listens on PAPER_PORT (default 7801, localhost-only). The Vite dev server
// proxies /paper-api/* to this process so the frontend can hit /state on a
// 1-second poll and POST to /start /stop /reset.
//
// On startup, if the DB says we were running, the engine auto-resumes. This
// is the whole reason for the split: the engine keeps trading across browser
// closes, tab reloads, and even a systemctl restart.

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { DEFAULT_STRATEGY } from '../src/services/strategy.ts'
import type { StrategyConfig } from '../src/types.ts'
import { BackendPaperEngine } from './engine.ts'
import { readCapital5Min, readPositionRewardHourly, readRewardHourly, readAllFills } from './db.ts'

const PORT = Number(process.env.PAPER_PORT ?? 7801)
const HOST = process.env.PAPER_HOST ?? '127.0.0.1'

const engine = new BackendPaperEngine()

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  try {
    if (req.method === 'GET' && url.pathname === '/state') {
      return sendJson(res, 200, engine.snapshot())
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/reward-history') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 168), 8760)
      return sendJson(res, 200, readRewardHourly(limit))
    }
    if (req.method === 'GET' && url.pathname === '/capital-history') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 288), 105_120)
      return sendJson(res, 200, readCapital5Min(limit))
    }
    if (req.method === 'GET' && url.pathname === '/position-reward-history') {
      const conditionId = url.searchParams.get('conditionId') ?? undefined
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 168), 8760)
      return sendJson(res, 200, readPositionRewardHourly(conditionId, limit))
    }
    if (req.method === 'GET' && url.pathname === '/fills-history') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 10_000), 100_000)
      return sendJson(res, 200, readAllFills(limit))
    }
    if (req.method === 'POST' && url.pathname === '/start') {
      const raw = await readBody(req)
      let config: StrategyConfig = DEFAULT_STRATEGY
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw) as Partial<StrategyConfig>
          config = { ...DEFAULT_STRATEGY, ...parsed }
        } catch {
          return sendJson(res, 400, { error: 'invalid json body' })
        }
      }
      await engine.start(config)
      return sendJson(res, 200, { ok: true, snapshot: engine.snapshot() })
    }
    if (req.method === 'POST' && url.pathname === '/stop') {
      await engine.stop()
      return sendJson(res, 200, { ok: true, snapshot: engine.snapshot() })
    }
    if (req.method === 'POST' && url.pathname === '/reset') {
      try {
        engine.resetHistory()
      } catch (err) {
        return sendJson(res, 409, { error: (err as Error).message })
      }
      return sendJson(res, 200, { ok: true })
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[server]', err)
    sendJson(res, 500, { error: (err as Error).message })
  }
})

async function main() {
  // Auto-resume on boot.
  await engine.resumeIfNeeded()
  server.listen(PORT, HOST, () => {
    console.log(`[server] listening on http://${HOST}:${PORT}`)
  })
}

async function shutdown(signal: string) {
  console.log(`[server] ${signal} received — shutting down`)
  // Leave engine state as-is so resumeIfNeeded() can pick it up.
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

main().catch((err) => {
  console.error('[server] fatal:', err)
  process.exit(1)
})
