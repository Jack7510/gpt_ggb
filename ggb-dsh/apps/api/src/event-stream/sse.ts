import {
  NOOP_METRICS,
  type Metrics,
  type RunId,
} from '@ggb-copilot/application'
import type { ServerResponse } from 'node:http'

const EVENTS_PAGE_LIMIT = 200

export interface SseEventLike {
  eventId: number
  payload: { type: string }
}

/** The subset of a run store the stream needs; plugin-core uses the same shape. */
export interface SseEventSource<E extends SseEventLike> {
  listRunEvents(runId: RunId, afterEventId: number, limit: number): Promise<E[]>
  reconcileExpiredLease?(runId: RunId): Promise<unknown>
}

export interface SseStreamOptions<E extends SseEventLike = never> {
  store: SseEventSource<E>
  runId: RunId
  after: number
  pollMs: number
  heartbeatMs: number
  res: ServerResponse
  /** Atomic opening snapshot. It is not persisted as a business event. */
  ready: Record<string, unknown>
  /** SSE event name for the opening snapshot; defaults to `run.ready`. */
  readyEvent?: string
  /** Plugin-core supplies its own frame encoder and terminal predicate. */
  frame?: (event: E) => string
  isTerminal?: (event: E) => boolean
  /** §15 metrics sink; omitted in tests that do not assert on metrics. */
  metrics?: Metrics
}

/**
 * Poll-based SSE replay of persisted run events (§6.2): replays everything
 * after the cursor, pings while idle, and ends the stream once a terminal
 * event has been delivered. Expired-cursor checks happen in the route.
 */
export function streamRunEvents<E extends SseEventLike = never>(
  options: SseStreamOptions<E>,
): void {
  const { store, runId, res, pollMs, heartbeatMs } = options
  const metrics = options.metrics ?? NOOP_METRICS
  const frame = options.frame ?? ((event: E) =>
    `data: ${JSON.stringify(event)}\n\n`)
  const isTerminal = options.isTerminal ?? (() => false)
  const readyEvent = options.readyEvent ?? 'run.ready'
  let cursor = Number(options.ready.cursor) || 0
  let closed = false
  let ticking = false
  let lastWriteAt = Date.now()
  let nextLeaseCheckAt = Date.now() + Math.max(heartbeatMs, 1_000)
  // A stream that starts from a non-zero cursor is a client resume, not a first open.
  if (options.after > 0) metrics.increment('sse_reconnects')

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const close = (): void => {
    closed = true
  }
  res.on('close', close)
  res.on('error', close)

  const write = (chunk: string): void => {
    // `write` returning false means the client is behind; the frame is still queued,
    // but the condition is worth counting (§15 SSE backpressure).
    if (!res.write(chunk)) metrics.increment('sse_backpressure')
  }

  write(`event: ${readyEvent}\ndata: ${JSON.stringify(options.ready)}\n\n`)
  if (options.ready.terminal === true) {
    res.end()
    return
  }

  const tick = async (): Promise<void> => {
    if (closed || ticking) return
    ticking = true
    try {
      if (Date.now() >= nextLeaseCheckAt) {
        nextLeaseCheckAt = Date.now() + Math.max(heartbeatMs, 1_000)
        await store.reconcileExpiredLease?.(runId)
      }
      const events = await store.listRunEvents(runId, cursor, EVENTS_PAGE_LIMIT)
      for (const event of events) {
        if (closed) return
        write(frame(event))
        cursor = event.eventId
        lastWriteAt = Date.now()
        if (isTerminal(event)) {
          res.end()
          closed = true
          return
        }
      }
    } finally {
      ticking = false
    }
  }

  void tick().catch(finishWithError)
  const interval = setInterval(() => {
    if (closed) {
      clearInterval(interval)
      return
    }
    if (Date.now() - lastWriteAt >= heartbeatMs) {
      write(': ping\n\n')
      lastWriteAt = Date.now()
    }
    void tick().catch(finishWithError)
  }, pollMs)

  function finishWithError(error: unknown): void {
    clearInterval(interval)
    closed = true
    if (!res.writableEnded) {
      res.end()
    }
    void error
  }
}
