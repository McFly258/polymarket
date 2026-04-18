/**
 * Main-thread facade for the PaperEngine Web Worker.
 *
 * Encapsulates:
 *   - Worker lifecycle (import with Vite's ?worker syntax)
 *   - Message dispatch to the worker
 *   - Summary state management (updated at most every 2 s from the worker)
 *   - useSyncExternalStore-compatible subscribe/snapshot API
 *
 * The WS client calls `postBooks(batch)` to forward batched book updates to the
 * worker — no engine logic runs on the main thread.
 */

import PaperEngineWorker from '../workers/paperEngine.worker?worker'
import type {
  BooksBatch,
  FillEvent,
  StartPayload,
  WorkerSummary,
} from '../workers/paperEngine.worker'
import type { StrategyAllocation, StrategyConfig, RewardsRow } from '../types'

// Re-export so consumers only need to import from here.
export type { FillEvent, WorkerSummary, BooksBatch, StartPayload }

// ── Snapshot type exposed to React ────────────────────────────────────────

export interface PaperEngineSnapshot extends WorkerSummary {
  brokerKind: 'paper' | 'live'
}

const EMPTY_SNAPSHOT: PaperEngineSnapshot = {
  state: 'idle',
  startedAt: null,
  positions: [],
  fills: [],
  reward: { totalEarnedUsd: 0, lastRatePerDay: 0, lastUpdatedAt: Date.now() },
  netPnl: 0,
  brokerKind: 'paper',
}

type Listener = () => void

// ── Worker bridge class ────────────────────────────────────────────────────

class PaperEngineWorkerBridge {
  private readonly worker: Worker
  private snapshot: PaperEngineSnapshot = { ...EMPTY_SNAPSHOT }
  private listeners = new Set<Listener>()

  constructor() {
    this.worker = new PaperEngineWorker()
    this.worker.addEventListener('message', (evt: MessageEvent<{ type: string; payload: unknown }>) => {
      const { type, payload } = evt.data
      if (type === 'summary') {
        this.snapshot = { ...(payload as WorkerSummary), brokerKind: 'paper' }
        this.notify()
      } else if (type === 'fill') {
        // Fill events arrive immediately; merge into local snapshot so the UI
        // reflects the fill without waiting for the next 2-second summary tick.
        const fill = payload as FillEvent
        const existing = this.snapshot.fills
        if (!existing.some((f) => f.id === fill.id)) {
          this.snapshot = {
            ...this.snapshot,
            fills: [fill, ...existing].slice(0, 200),
          }
          this.notify()
        }
      }
    })
  }

  // ── External store API ─────────────────────────────────────────────────

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot(): PaperEngineSnapshot {
    return this.snapshot
  }

  // ── Commands to the worker ─────────────────────────────────────────────

  start(allocations: StrategyAllocation[], rows: RewardsRow[], config: StrategyConfig): void {
    const payload: StartPayload = { allocations, rows, config }
    this.worker.postMessage({ type: 'start', payload })
  }

  stop(): void {
    this.worker.postMessage({ type: 'stop' })
  }

  resetHistory(): void {
    this.worker.postMessage({ type: 'reset' })
  }

  /**
   * Forward a batch of book updates to the worker.
   * Called by the WS client every ~250 ms with accumulated updates.
   */
  postBooks(updates: Record<string, import('../workers/paperEngine.worker').BookView>): void {
    const batch: BooksBatch = { updates }
    this.worker.postMessage({ type: 'books', payload: batch })
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  isRunning(): boolean {
    return this.snapshot.state === 'running'
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }
}

// Singleton — one worker instance per browser tab.
let bridge: PaperEngineWorkerBridge | null = null

export function getPaperEngineWorker(): PaperEngineWorkerBridge {
  if (!bridge) bridge = new PaperEngineWorkerBridge()
  return bridge
}
