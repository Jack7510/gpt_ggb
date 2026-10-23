import { pluginCoreCleanupSchema, type PluginCoreCleanup } from '@ggb-copilot/application'
import { artifactsMatchDelivery } from './plugin-core-completion.js'
import type { Pool, PoolClient } from 'pg'
import {
  isTerminalPluginCorePhase, pluginCoreEventPayloadSchema,
  type NewPluginCoreRunSpec, type PluginCoreDelivery, type PluginCoreEvent,
  type PluginCoreEventAppend, type PluginCoreFailure, type PluginCorePhase,
  type PluginCoreRunAccessFacts, type PluginCoreRunRecord, type PluginCoreUsage,
} from '@ggb-copilot/application'
import type { RunId } from '@ggb-copilot/application'
import type {
  PluginCoreArtifactRecordView, PluginCoreCompleteInput, PluginCoreCreateResult,
  PluginCoreFailInput, PluginCoreRunningResult, PluginCoreStore,
} from './plugin-core-store.js'

const RUN_COLUMNS = `delivery_contract, run_id, token_verifier, request_digest, prompt, prompt_digest,
  base_sha256, base_name, phase, stop_requested, execution_started_at,
  execution_expires_at, final_response, failure, delivery, usage, duration_ms,
  model_id, created_at, updated_at, expires_at`

interface RunRow {
  delivery_contract: 'legacy' | 'receipt-v1'
  run_id: string
  token_verifier: string
  request_digest: string
  prompt: string
  prompt_digest: string
  base_sha256: string | null
  base_name: string | null
  phase: PluginCorePhase
  stop_requested: boolean
  execution_started_at: Date | string | null
  execution_expires_at: Date | string
  final_response: string | null
  failure: PluginCoreFailure | null
  delivery: PluginCoreDelivery | null
  usage: PluginCoreUsage | null
  duration_ms: string | number | null
  model_id: string | null
  created_at: Date | string
  updated_at: Date | string
  expires_at: Date | string
}

interface EventRow {
  event_id: string | number
  payload: unknown
  occurred_at: Date | string
}

interface ArtifactRow {
  run_id: string
  artifact_id: string
  kind: PluginCoreArtifactRecordView['kind']
  size_bytes: string | number
  sha256: string
  content_type: string
  content_base64: string
  created_at: Date | string
  expires_at: Date | string
}

const DEFAULT_TERMINAL_TTL_MS = 7 * 86_400_000

/** PostgreSQL adapter for the independent plugin-core lifecycle. */
export class PgPluginCoreStore implements PluginCoreStore {
  constructor(private readonly pool: Pool,
    private readonly terminalTtlMs = DEFAULT_TERMINAL_TTL_MS) {}

  async createRun(spec: NewPluginCoreRunSpec): Promise<PluginCoreCreateResult> {
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO plugin_core_runs (run_id, token_verifier, request_digest,
           prompt, prompt_digest, base_sha256, base_name, phase,
           execution_expires_at, expires_at, delivery_contract)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$9,$10)
         ON CONFLICT (run_id) DO NOTHING`,
        [spec.runId, spec.tokenVerifier, spec.requestDigest, spec.prompt,
          spec.promptDigest, spec.baseSha256, spec.baseName,
          spec.executionExpiresAt, spec.expiresAt, spec.deliveryContract ?? 'receipt-v1'],
      )
      const found = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM plugin_core_runs WHERE run_id = $1`,
        [spec.runId],
      )
      const record = rowToRecord(found.rows[0]!)
      if (inserted.rowCount === 1) {
        await appendEvents(client, spec.runId as RunId, [{
          payload: { type: 'plugin_core.phase', phase: 'accepted' },
          occurredAt: record.createdAt,
        }])
        return { kind: 'created', record }
      }
      return record.tokenVerifier === spec.tokenVerifier
        && record.requestDigest === spec.requestDigest
        ? { kind: 'existing', record }
        : { kind: 'conflict', record }
    })
  }

  async getRunAccessFacts(runId: RunId): Promise<PluginCoreRunAccessFacts | null> {
    const found = await this.pool.query<{
      token_verifier: string; request_digest: string
    }>('SELECT token_verifier, request_digest FROM plugin_core_runs WHERE run_id = $1',
      [runId])
    const row = found.rows[0]
    return row === undefined ? null : {
      tokenVerifier: row.token_verifier, requestDigest: row.request_digest,
    }
  }

  async getRun(runId: RunId): Promise<PluginCoreRunRecord | null> {
    const found = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM plugin_core_runs WHERE run_id = $1`, [runId])
    return found.rows[0] === undefined ? null : rowToRecord(found.rows[0])
  }

  async markRunning(runId: RunId): Promise<PluginCoreRunningResult> {
    return this.transaction(async (client) => {
      const updated = await client.query<RunRow>(
        `UPDATE plugin_core_runs
         SET phase = 'running', execution_started_at = now(), updated_at = now()
         WHERE run_id = $1 AND phase = 'accepted' AND stop_requested = FALSE
         RETURNING ${RUN_COLUMNS}`,
        [runId],
      )
      if (updated.rowCount === 1) {
        await appendEvents(client, runId, [{
          payload: { type: 'plugin_core.phase', phase: 'running' },
          occurredAt: iso(updated.rows[0]!.updated_at),
        }])
        return 'running'
      }
      const current = await selectForUpdate(client, runId)
      if (current === null) return 'missing'
      if (current.phase === 'running') return 'running'
      if (current.phase === 'accepted' && current.stop_requested) {
        await cancelTx(client, runId, this.terminalExpiry())
        return 'cancelled'
      }
      return 'conflict'
    })
  }

  async requestStop(runId: RunId): Promise<boolean> {
    const updated = await this.pool.query(
      `UPDATE plugin_core_runs SET stop_requested = TRUE, updated_at = now()
       WHERE run_id = $1 AND phase IN ('accepted','running')`,
      [runId],
    )
    return (updated.rowCount ?? 0) > 0
  }

  async completeRun(input: PluginCoreCompleteInput): Promise<'committed' | 'cancelled' | 'conflict'> {
    return this.transaction(async (client) => {
      const current = await selectForUpdate(client, input.runId)
      if (current === null || isTerminalPluginCorePhase(current.phase)) return 'conflict'
      if (current.phase !== 'running' || !input.cleanup?.confirmed || input.cleanup.runId !== input.runId) return 'conflict'
      if (current.stop_requested) {
        await cancelTx(client, input.runId, input.expiresAt, input.cleanup)
        return 'cancelled'
      }
      if (!artifactsMatchDelivery(input, { runId: current.run_id, baseSha256: current.base_sha256, deliveryContract: current.delivery_contract })) return 'conflict'
      const delivery = { ...input.delivery, cleanup: input.cleanup! }
      for (const artifact of input.artifacts) {
        await client.query(
          `INSERT INTO plugin_core_artifacts (run_id, artifact_id, kind, size_bytes,
             sha256, content_type, content_base64, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (run_id, artifact_id) DO NOTHING`,
          [input.runId, artifact.artifactId, artifact.kind, artifact.sizeBytes,
            artifact.sha256, artifact.contentType, artifact.contentBase64, input.expiresAt],
        )
      }
      await insertUsage(client, current, input.usage, input.modelId,
        input.durationMs, null)
      await client.query(
        `UPDATE plugin_core_runs SET phase = 'completed', final_response = $2,
           delivery = $3, usage = $4, duration_ms = $5, model_id = $6,
           updated_at = now(), expires_at = $7
         WHERE run_id = $1`,
        [input.runId, input.finalResponse, JSON.stringify(delivery),
          input.usage === null ? null : JSON.stringify(input.usage),
          input.durationMs, input.modelId, input.expiresAt],
      )
      await appendEvents(client, input.runId, [{
        payload: {
          type: 'plugin_core.delivery',
          finalResponse: input.finalResponse,
          delivery,
          usage: input.usage,
          durationMs: input.durationMs,
        },
        occurredAt: new Date().toISOString(),
      }])
      return 'committed'
    })
  }

  async failRun(input: PluginCoreFailInput): Promise<'committed' | 'cancelled' | 'conflict'> {
    return this.transaction(async (client) => {
      const current = await selectForUpdate(client, input.runId)
      if (current === null || isTerminalPluginCorePhase(current.phase)) return 'conflict'
      if (!pluginCoreEventPayloadSchema.safeParse({ type: 'plugin_core.failed',
        ...input.failure, usage: input.usage }).success) return 'conflict'
      const cleaned = pluginCoreCleanupSchema.safeParse(input.cleanup).success
        && input.cleanup?.confirmed === true && input.cleanup.runId === input.runId
      if (current.phase === 'running' && !cleaned && !['plugin_core_cleanup_failed', 'plugin_core_worker_unavailable'].includes(input.failure.code)) return 'conflict'
      if (current.stop_requested && cleaned && !['plugin_core_cleanup_failed', 'plugin_core_worker_unavailable'].includes(input.failure.code)) {
        await cancelTx(client, input.runId, input.expiresAt, input.cleanup)
        return 'cancelled'
      }
      await insertUsage(client, current, input.usage, input.modelId,
        input.durationMs, input.failure.code)
      await client.query(
        `UPDATE plugin_core_runs SET phase = 'failed', failure = $2, usage = $3,
           duration_ms = $4, model_id = $5, updated_at = now(), expires_at = $6
         WHERE run_id = $1`,
        [input.runId, JSON.stringify(input.failure),
          input.usage === null ? null : JSON.stringify(input.usage),
          input.durationMs, input.modelId, input.expiresAt],
      )
      await appendEvents(client, input.runId, [{
        payload: {
          type: 'plugin_core.failed',
          code: input.failure.code,
          message: input.failure.message,
          ...(input.failure.details === undefined ? {} : { details: input.failure.details }),
          usage: input.usage,
        },
        occurredAt: new Date().toISOString(),
      }])
      return 'committed'
    })
  }

  async cancelRun(runId: RunId, expiresAt: string, cleanup?: PluginCoreCleanup): Promise<boolean> {
    if (cleanup && (!pluginCoreCleanupSchema.safeParse(cleanup).success || cleanup.runId !== runId)) return false
    return this.transaction(async (client) => {
      const current = await selectForUpdate(client, runId)
      if (current === null) return false
      if (current.phase === 'cancelled') return true
      if (isTerminalPluginCorePhase(current.phase)) return false
      if (current.phase === 'running' && (!cleanup?.confirmed || cleanup.runId !== runId)) return false
      await cancelTx(client, runId, expiresAt, cleanup)
      return true
    })
  }

  async appendEvents(runId: RunId, events: readonly PluginCoreEventAppend[]): Promise<PluginCoreEvent[]> {
    return this.transaction(async (client) => {
      const exists = await client.query<{ phase: string; stop_requested: boolean }>(
        'SELECT phase, stop_requested FROM plugin_core_runs WHERE run_id = $1 FOR UPDATE', [runId])
      if (exists.rowCount !== 1) return []
      const row = exists.rows[0]!
      const previous = await client.query<{ sequence: number }>(
        `SELECT (payload->'progress'->>'sequence')::int AS sequence FROM plugin_core_events
         WHERE run_id = $1 AND payload->>'type' = 'plugin_core.progress' ORDER BY event_id DESC LIMIT 1`, [runId])
      let sequence = previous.rows[0]?.sequence ?? 0
      return appendEvents(client, runId, events.filter(event => {
        if (event.payload.type !== 'plugin_core.progress') return true
        const payload = pluginCoreEventPayloadSchema.parse(event.payload)
        if (payload.type !== 'plugin_core.progress' || row.phase !== 'running' || row.stop_requested
          || payload.progress.sequence <= sequence) return false
        sequence = payload.progress.sequence
        return true
      }))
    })
  }

  async listEvents(runId: RunId, afterEventId: number, limit: number): Promise<PluginCoreEvent[]> {
    const found = await this.pool.query<EventRow>(
      `SELECT event_id, payload, occurred_at FROM plugin_core_events
       WHERE run_id = $1 AND event_id > $2 ORDER BY event_id LIMIT $3`,
      [runId, afterEventId, Math.max(0, limit)],
    )
    return found.rows.map(row => ({
      schemaVersion: 1 as const,
      eventId: Number(row.event_id),
      occurredAt: iso(row.occurred_at),
      runId,
      payload: pluginCoreEventPayloadSchema.parse(row.payload),
    }))
  }

  async earliestEventId(runId: RunId): Promise<number | null> {
    const found = await this.pool.query<{ event_id: string | null }>(
      'SELECT MIN(event_id) AS event_id FROM plugin_core_events WHERE run_id = $1',
      [runId])
    const value = found.rows[0]?.event_id
    return value === null || value === undefined ? null : Number(value)
  }

  async latestEventId(runId: RunId): Promise<number | null> {
    const found = await this.pool.query<{ event_id: string | null }>(
      'SELECT MAX(event_id) AS event_id FROM plugin_core_events WHERE run_id = $1',
      [runId])
    const value = found.rows[0]?.event_id
    return value === null || value === undefined ? null : Number(value)
  }

  async getArtifact(runId: RunId, artifactId: string): Promise<
    { record: PluginCoreArtifactRecordView; contentBase64: string } | null> {
    const found = await this.pool.query<ArtifactRow>(
      `SELECT run_id, artifact_id, kind, size_bytes, sha256, content_type,
         content_base64, created_at, expires_at
       FROM plugin_core_artifacts WHERE run_id = $1 AND artifact_id = $2`,
      [runId, artifactId],
    )
    const row = found.rows[0]
    if (row === undefined) return null
    return {
      record: {
        artifactId: row.artifact_id,
        runId: row.run_id as RunId,
        kind: row.kind,
        sizeBytes: Number(row.size_bytes),
        sha256: row.sha256,
        contentType: row.content_type,
        createdAt: iso(row.created_at),
        expiresAt: iso(row.expires_at),
      },
      contentBase64: row.content_base64,
    }
  }

  async countActiveRuns(): Promise<number> {
    const found = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM plugin_core_runs
       WHERE phase IN ('accepted','running')`)
    return Number(found.rows[0]?.count ?? 0)
  }

  async sweepExpired(now: string, limit: number): Promise<number> {
    return this.transaction(async (client) => {
      const expiresAt = new Date(Date.parse(now) + this.terminalTtlMs).toISOString()
      await client.query(
        `UPDATE plugin_core_runs SET stop_requested = TRUE
         WHERE phase = 'running' AND execution_expires_at <= $1`, [now])
      const interrupted = await client.query<RunRow>(
        `UPDATE plugin_core_runs
         SET phase = 'failed',
             failure = $1, duration_ms = NULL, updated_at = now(), expires_at = $2
         WHERE run_id IN (
           SELECT run_id FROM plugin_core_runs
           WHERE phase = 'accepted'
             AND COALESCE(execution_expires_at, expires_at) <= $3
           ORDER BY created_at LIMIT $4 FOR UPDATE SKIP LOCKED
         )
         RETURNING ${RUN_COLUMNS}`,
        [JSON.stringify({
          code: 'plugin_core_interrupted',
          message: 'The plugin-core run did not finish before its execution deadline.',
        }), expiresAt, now, limit],
      )
      for (const row of interrupted.rows) {
        await appendEvents(client, row.run_id as RunId, [{
          payload: {
            type: 'plugin_core.failed',
            code: 'plugin_core_interrupted',
            message: 'The plugin-core run did not finish before its execution deadline.',
            usage: row.usage,
          },
          occurredAt: now,
        }])
      }
      const deleted = await client.query<{ run_id: string }>(
        `DELETE FROM plugin_core_runs WHERE run_id IN (
           SELECT run_id FROM plugin_core_runs
           WHERE phase IN ('completed','failed','cancelled') AND expires_at <= $1
             AND COALESCE(failure->>'code', '') NOT IN ('plugin_core_cleanup_failed', 'plugin_core_worker_unavailable')
           ORDER BY expires_at LIMIT $2
         ) RETURNING run_id`,
        [now, limit],
      )
      return (deleted.rowCount ?? 0) + (interrupted.rowCount ?? 0)
    })
  }

  async deleteRun(runId: RunId): Promise<boolean> {
    const deleted = await this.pool.query(
      `DELETE FROM plugin_core_runs WHERE run_id = $1 AND phase <> 'running'
       AND COALESCE(failure->>'code', '') NOT IN ('plugin_core_cleanup_failed', 'plugin_core_worker_unavailable')`, [runId])
    return (deleted.rowCount ?? 0) > 0
  }

  private terminalExpiry(now = Date.now()): string {
    return new Date(now + this.terminalTtlMs).toISOString()
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

async function selectForUpdate(client: PoolClient, runId: RunId): Promise<RunRow | null> {
  const found = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM plugin_core_runs WHERE run_id = $1 FOR UPDATE`,
    [runId],
  )
  return found.rows[0] ?? null
}

async function cancelTx(client: PoolClient, runId: RunId, expiresAt: string, cleanup?: PluginCoreCleanup): Promise<void> {
  const now = new Date().toISOString()
  await client.query(
    `UPDATE plugin_core_runs SET phase = 'cancelled', stop_requested = TRUE,
       updated_at = now(), expires_at = $2
     WHERE run_id = $1 AND phase IN ('accepted','running')`,
    [runId, expiresAt],
  )
  await appendEvents(client, runId, [{
    payload: { type: 'plugin_core.cancelled', cleanup: cleanup ?? { runId, confirmed: true, completedAt: now } }, occurredAt: now,
  }])
}

async function appendEvents(client: PoolClient, runId: RunId,
  events: readonly PluginCoreEventAppend[]): Promise<PluginCoreEvent[]> {
  if (events.length === 0) return []
  const max = await client.query<{ next_id: string }>(
    `SELECT COALESCE(MAX(event_id), 0) + 1 AS next_id
     FROM plugin_core_events WHERE run_id = $1`,
    [runId],
  )
  let next = Number(max.rows[0]!.next_id)
  const appended: PluginCoreEvent[] = []
  for (const input of events) {
    const payload = pluginCoreEventPayloadSchema.parse(input.payload)
    await client.query(
      `INSERT INTO plugin_core_events (run_id, event_id, payload, occurred_at)
       VALUES ($1,$2,$3,$4)`,
      [runId, next, JSON.stringify(payload), input.occurredAt],
    )
    appended.push({
      schemaVersion: 1, eventId: next, occurredAt: input.occurredAt,
      runId, payload,
    })
    next += 1
  }
  return appended
}

async function insertUsage(client: PoolClient, run: RunRow,
  usage: PluginCoreUsage | null, modelId: string, durationMs: number | null,
  errorCode: string | null): Promise<void> {
  const value = usage ?? {
    calls: 0, inputTokens: null, outputTokens: null, reasoningTokens: null,
    cacheReadTokens: null, complete: false, source: 'unknown' as const,
  }
  await client.query(
    `INSERT INTO plugin_core_usage (run_id, calls, input_tokens, output_tokens,
       reasoning_tokens, cache_read_tokens, complete, usage_source, model_id,
       prompt_digest, duration_ms, error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (run_id) DO NOTHING`,
    [run.run_id, value.calls, value.inputTokens, value.outputTokens,
      value.reasoningTokens, value.cacheReadTokens, value.complete,
      value.source, modelId, run.prompt_digest, durationMs, errorCode],
  )
}



function rowToRecord(row: RunRow): PluginCoreRunRecord {
  return {
    runId: row.run_id,
    deliveryContract: row.delivery_contract,
    tokenVerifier: row.token_verifier,
    requestDigest: row.request_digest,
    prompt: row.prompt,
    promptDigest: row.prompt_digest,
    baseSha256: row.base_sha256,
    baseName: row.base_name,
    phase: row.phase,
    stopRequested: row.stop_requested,
    executionStartedAt: row.execution_started_at === null ? null : iso(row.execution_started_at),
    executionExpiresAt: iso(row.execution_expires_at),
    finalResponse: row.final_response,
    failure: row.failure,
    delivery: row.delivery,
    usage: row.usage,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    modelId: row.model_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}
