import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { runIdSchema } from '@ggb-copilot/application'
import { PgPluginCoreStore } from '../src/pg-plugin-core-store.js'

const runId = runIdSchema.parse('run_00000000-0000-4000-8000-000000000101')

/** Offline driver boundary; this does not claim PostgreSQL SQL execution coverage. */
function fixture() {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('FOR UPDATE') && sql.startsWith('SELECT')) return { rows: [{ run_id: runId,
      phase: 'running', stop_requested: true, prompt_digest: 'a'.repeat(64) }], rowCount: 1 }
    if (sql.includes('AS next_id')) return { rows: [{ next_id: '1' }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const release = vi.fn()
  const client = { query, release } as unknown as PoolClient
  const pool = { query, connect: async () => client } as unknown as Pool
  return { store: new PgPluginCoreStore(pool), query, release }
}

describe('PostgreSQL unknown-cleanup boundary without a database', () => {
  it('commits worker_unavailable without converting a pending stop into cancellation', async () => {
    const { store, query, release } = fixture()
    expect(await store.failRun({ runId, failure: { code: 'plugin_core_worker_unavailable', message: 'cleanup unknown' },
      usage: null, durationMs: 1, modelId: 'unknown', expiresAt: '2026-10-23T00:00:00.000Z' })).toBe('committed')
    expect(query.mock.calls.some(([sql]) => sql.includes("phase = 'cancelled'"))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes("phase = 'failed'"))).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  })
  it('writes the same build summary to the PostgreSQL row and failure event', async () => {
    const { store, query } = fixture()
    const details = { kind: 'execution_failed' as const, lastBuildId: '11111111-1111-4111-8111-111111111111',
      failedChecks: [], reasons: ['Process exited with code 1'] }
    const input = { runId, failure: { code: 'plugin_core_worker_unavailable' as const, message: 'Worker failed', details },
      usage: null, durationMs: 1, modelId: 'unknown', expiresAt: '2026-10-23T00:00:00.000Z' }
    expect(await store.failRun({ ...input, failure: { ...input.failure,
      details: { ...details, reasons: ['x'.repeat(513)] } } })).toBe('conflict')
    expect(await store.failRun(input)).toBe('committed')
    const row = query.mock.calls.find(([sql]) => sql.includes("phase = 'failed'"))!
    expect(JSON.parse(String(row[1]![1])).details).toEqual(details)
    const event = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO plugin_core_events'))!
    expect(JSON.parse(String(event[1]![2])).details).toEqual(details)
  })
  it('excludes both unknown and failed cleanup records from deletion and TTL queries', async () => {
    const { store, query } = fixture()
    await store.deleteRun(runId)
    await store.sweepExpired('2026-10-23T00:00:00.000Z', 10)
    const deletes = query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM plugin_core_runs'))
    expect(deletes).toHaveLength(2)
    for (const [sql] of deletes) expect(sql).toContain("NOT IN ('plugin_core_cleanup_failed', 'plugin_core_worker_unavailable')")
  })
})


describe('PostgreSQL progress row lock without a database', () => {
  it.each([
    ['running', false, 0, 1], ['running', false, 2, 0], ['running', true, 0, 0],
    ['completed', false, 0, 0], ['failed', false, 0, 0], ['cancelled', true, 0, 0],
  ] as const)('guards phase=%s stop=%s previous=%s', async (phase, stop, sequence, count) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rows: [{ phase, stop_requested: stop }], rowCount: 1 }
      if (sql.includes('AS sequence')) return { rows: [{ sequence }], rowCount: 1 }
      if (sql.includes('AS next_id')) return { rows: [{ next_id: '3' }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const client = { query, release: vi.fn() } as unknown as PoolClient
    const store = new PgPluginCoreStore({ connect: async () => client } as unknown as Pool)
    const occurredAt = '2026-10-23T00:00:00.000Z'
    expect(await store.appendEvents(runId, [{ occurredAt, payload: { type: 'plugin_core.progress', progress: {
      tool: 'ggb_check', status: 'started', callId: '11111111-1111-4111-8111-111111111111', sequence: 1, occurredAt,
    } } }])).toHaveLength(count)
    expect(query.mock.calls[1]?.[0]).toContain('FOR UPDATE')
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO plugin_core_events'))).toHaveLength(count)
  })
})
