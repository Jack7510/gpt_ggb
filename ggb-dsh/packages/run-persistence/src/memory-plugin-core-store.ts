import { pluginCoreCleanupSchema, type PluginCoreCleanup } from '@ggb-copilot/application'
import { artifactsMatchDelivery } from './plugin-core-completion.js'
import {
  isTerminalPluginCorePhase, pluginCoreEventPayloadSchema,
  type NewPluginCoreRunSpec, type PluginCoreEvent, type PluginCoreEventAppend,
  type PluginCoreRunAccessFacts, type PluginCoreRunRecord,
} from '@ggb-copilot/application'
import type { RunId } from '@ggb-copilot/application'
import type {
  PluginCoreArtifactRecordView, PluginCoreCompleteInput, PluginCoreCreateResult,
  PluginCoreFailInput, PluginCoreRunningResult, PluginCoreStore,
} from './plugin-core-store.js'

export interface PluginCoreStoreDocument {
  schemaVersion: 1
  runs: PluginCoreRunRecord[]
  events: Record<string, PluginCoreEvent[]>
  artifacts: Record<string, Record<string, {
    record: PluginCoreArtifactRecordView
    contentBase64: string
  }>>
}

export interface MemoryPluginCoreStoreOptions {
  now?: () => string
  /** Terminal retention after an interrupted run is failed by a sweep. */
  terminalTtlMs?: number
}

const DEFAULT_TERMINAL_TTL_MS = 7 * 86_400_000

/** In-memory canonical implementation; SQLite persists this document. */
export class MemoryPluginCoreStore implements PluginCoreStore {
  private runs = new Map<string, PluginCoreRunRecord>()
  private events = new Map<string, PluginCoreEvent[]>()
  private artifacts = new Map<string, Map<string, {
    record: PluginCoreArtifactRecordView
    contentBase64: string
  }>>()
  private readonly now: () => string
  private readonly terminalTtlMs: number

  constructor(options: MemoryPluginCoreStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS
  }

  async createRun(spec: NewPluginCoreRunSpec): Promise<PluginCoreCreateResult> {
    const existing = this.runs.get(spec.runId)
    if (existing !== undefined) {
      return existing.tokenVerifier === spec.tokenVerifier
        && existing.requestDigest === spec.requestDigest
        ? { kind: 'existing', record: clone(existing) }
        : { kind: 'conflict', record: clone(existing) }
    }
    const now = this.now()
    const record: PluginCoreRunRecord = {
      runId: spec.runId,
      deliveryContract: spec.deliveryContract ?? 'receipt-v1',
      tokenVerifier: spec.tokenVerifier,
      requestDigest: spec.requestDigest,
      prompt: spec.prompt,
      promptDigest: spec.promptDigest,
      baseSha256: spec.baseSha256,
      baseName: spec.baseName,
      phase: 'accepted',
      stopRequested: false,
      executionStartedAt: null,
      executionExpiresAt: spec.executionExpiresAt,
      finalResponse: null,
      failure: null,
      delivery: null,
      usage: null,
      durationMs: null,
      modelId: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: spec.expiresAt,
    }
    this.runs.set(record.runId, record)
    this.appendTo(record.runId, [{
      payload: { type: 'plugin_core.phase', phase: 'accepted' }, occurredAt: now,
    }])
    return { kind: 'created', record: clone(record) }
  }

  async getRunAccessFacts(runId: RunId): Promise<PluginCoreRunAccessFacts | null> {
    const record = this.runs.get(runId)
    return record === undefined ? null : {
      tokenVerifier: record.tokenVerifier, requestDigest: record.requestDigest,
    }
  }

  async getRun(runId: RunId): Promise<PluginCoreRunRecord | null> {
    const record = this.runs.get(runId)
    return record === undefined ? null : clone(record)
  }

  async markRunning(runId: RunId): Promise<PluginCoreRunningResult> {
    const record = this.runs.get(runId)
    if (record === undefined) return 'missing'
    if (record.phase === 'running') return 'running'
    if (record.phase !== 'accepted') return 'conflict'
    if (record.stopRequested) {
      await this.cancelRun(runId, this.terminalExpiry())
      return 'cancelled'
    }
    const now = this.now()
    record.phase = 'running'
    record.executionStartedAt = now
    record.updatedAt = now
    this.appendTo(runId, [{
      payload: { type: 'plugin_core.phase', phase: 'running' }, occurredAt: now,
    }])
    return 'running'
  }

  async requestStop(runId: RunId): Promise<boolean> {
    const record = this.runs.get(runId)
    if (record === undefined || isTerminalPluginCorePhase(record.phase)) return false
    record.stopRequested = true
    record.updatedAt = this.now()
    return true
  }

  async completeRun(input: PluginCoreCompleteInput): Promise<'committed' | 'cancelled' | 'conflict'> {
    const record = this.runs.get(input.runId)
    if (record === undefined || isTerminalPluginCorePhase(record.phase)) return 'conflict'
    if (record.phase !== 'running' || !input.cleanup?.confirmed || input.cleanup.runId !== input.runId) return 'conflict'
    if (record.stopRequested) {
      await this.cancelRun(input.runId, input.expiresAt, input.cleanup)
      return 'cancelled'
    }
    if (!artifactsMatchDelivery(input, record)) return 'conflict'
    const delivery = { ...input.delivery, cleanup: input.cleanup! }
    const now = this.now()
    const artifacts = this.artifacts.get(input.runId) ?? new Map()
    for (const artifact of input.artifacts) {
      if (artifacts.has(artifact.artifactId)) continue
      artifacts.set(artifact.artifactId, {
        record: {
          artifactId: artifact.artifactId,
          runId: input.runId,
          kind: artifact.kind,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          contentType: artifact.contentType,
          createdAt: now,
          expiresAt: input.expiresAt,
        },
        contentBase64: artifact.contentBase64,
      })
    }
    this.artifacts.set(input.runId, artifacts)
    record.phase = 'completed'
    record.finalResponse = input.finalResponse
    record.delivery = delivery
    record.usage = input.usage
    record.durationMs = input.durationMs
    record.modelId = input.modelId
    record.updatedAt = now
    record.expiresAt = input.expiresAt
    this.appendTo(input.runId, [{
      payload: {
        type: 'plugin_core.delivery',
        finalResponse: input.finalResponse,
        delivery,
        usage: input.usage,
        durationMs: input.durationMs,
      },
      occurredAt: now,
    }])
    return 'committed'
  }

  async failRun(input: PluginCoreFailInput): Promise<'committed' | 'cancelled' | 'conflict'> {
    const record = this.runs.get(input.runId)
    if (record === undefined || isTerminalPluginCorePhase(record.phase)) return 'conflict'
    if (!pluginCoreEventPayloadSchema.safeParse({ type: 'plugin_core.failed',
      ...input.failure, usage: input.usage }).success) return 'conflict'
    const cleaned = pluginCoreCleanupSchema.safeParse(input.cleanup).success
      && input.cleanup?.confirmed === true && input.cleanup.runId === input.runId
    if (record.phase === 'running' && !cleaned && !['plugin_core_cleanup_failed', 'plugin_core_worker_unavailable'].includes(input.failure.code)) return 'conflict'
    if (record.stopRequested && cleaned && !['plugin_core_cleanup_failed', 'plugin_core_worker_unavailable'].includes(input.failure.code)) {
      await this.cancelRun(input.runId, input.expiresAt, input.cleanup)
      return 'cancelled'
    }
    const now = this.now()
    record.phase = 'failed'
    record.failure = input.failure
    record.usage = input.usage
    record.durationMs = input.durationMs
    record.modelId = input.modelId
    record.updatedAt = now
    record.expiresAt = input.expiresAt
    this.appendTo(input.runId, [{
      payload: {
        type: 'plugin_core.failed',
        code: input.failure.code,
        message: input.failure.message,
        ...(input.failure.details === undefined ? {} : { details: input.failure.details }),
        usage: input.usage,
      },
      occurredAt: now,
    }])
    return 'committed'
  }

  async cancelRun(runId: RunId, expiresAt: string, cleanup?: PluginCoreCleanup): Promise<boolean> {
    if (cleanup && (!pluginCoreCleanupSchema.safeParse(cleanup).success || cleanup.runId !== runId)) return false
    const record = this.runs.get(runId)
    if (record === undefined) return false
    if (record.phase === 'cancelled') return true
    if (isTerminalPluginCorePhase(record.phase)) return false
    if (record.phase === 'running' && (!cleanup?.confirmed || cleanup.runId !== runId)) return false
    const now = this.now()
    record.phase = 'cancelled'
    record.stopRequested = true
    record.updatedAt = now
    record.expiresAt = expiresAt
    this.appendTo(runId, [{
      payload: { type: 'plugin_core.cancelled', cleanup: cleanup ?? { runId, confirmed: true, completedAt: now } }, occurredAt: now,
    }])
    return true
  }

  async appendEvents(runId: RunId, events: readonly PluginCoreEventAppend[]): Promise<PluginCoreEvent[]> {
    return this.appendTo(runId, events)
  }

  async listEvents(runId: RunId, afterEventId: number, limit: number): Promise<PluginCoreEvent[]> {
    const all = this.events.get(runId) ?? []
    return all.filter(event => event.eventId > afterEventId)
      .slice(0, Math.max(0, limit)).map(clone)
  }

  async earliestEventId(runId: RunId): Promise<number | null> {
    return this.events.get(runId)?.[0]?.eventId ?? null
  }

  async latestEventId(runId: RunId): Promise<number | null> {
    const all = this.events.get(runId)
    return all === undefined || all.length === 0 ? null : all[all.length - 1]!.eventId
  }

  async getArtifact(runId: RunId, artifactId: string): Promise<
    { record: PluginCoreArtifactRecordView; contentBase64: string } | null> {
    const artifact = this.artifacts.get(runId)?.get(artifactId)
    return artifact === undefined ? null : {
      record: { ...artifact.record }, contentBase64: artifact.contentBase64,
    }
  }

  async countActiveRuns(): Promise<number> {
    let count = 0
    for (const record of this.runs.values()) {
      if (record.phase === 'accepted' || record.phase === 'running') count += 1
    }
    return count
  }

  async sweepExpired(now: string, limit: number): Promise<number> {
    let changed = 0
    const nowMs = Date.parse(now)
    for (const record of [...this.runs.values()]) {
      if (changed >= limit) break
      const expiry = record.phase === 'accepted' || record.phase === 'running'
        ? record.executionExpiresAt ?? record.expiresAt : record.expiresAt
      if (Date.parse(expiry) > nowMs) continue
      if (record.phase === 'running') {
        record.stopRequested = true
        continue // only the execution owner can prove cleanup
      }
      if (['plugin_core_cleanup_failed', 'plugin_core_worker_unavailable'].includes(record.failure?.code ?? '')) continue
      if (record.phase === 'accepted') {
        await this.failRun({
          runId: record.runId as RunId,
          failure: {
            code: 'plugin_core_interrupted',
            message: 'The plugin-core run did not finish before its execution deadline.',
          },
          usage: record.usage,
          durationMs: record.durationMs,
          modelId: 'unknown',
          expiresAt: this.terminalExpiry(nowMs),
        })
      } else {
        this.runs.delete(record.runId)
        this.events.delete(record.runId)
        this.artifacts.delete(record.runId)
      }
      changed += 1
    }
    return changed
  }

  async deleteRun(runId: RunId): Promise<boolean> {
    const run = this.runs.get(runId)
    if (run?.phase === 'running' || ['plugin_core_cleanup_failed', 'plugin_core_worker_unavailable'].includes(run?.failure?.code ?? '')) return false
    if (!this.runs.delete(runId)) return false
    this.events.delete(runId)
    this.artifacts.delete(runId)
    return true
  }

  /** Serialize the whole store for the SQLite snapshot adapter. */
  toDocument(): PluginCoreStoreDocument {
    return {
      schemaVersion: 1,
      runs: [...this.runs.values()].map(clone),
      events: Object.fromEntries([...this.events.entries()]
        .map(([runId, events]) => [runId, events.map(clone)])),
      artifacts: Object.fromEntries([...this.artifacts.entries()].map(([runId, artifacts]) =>
        [runId, Object.fromEntries([...artifacts.entries()].map(([id, artifact]) =>
          [id, {
            record: { ...artifact.record },
            contentBase64: artifact.contentBase64,
          }]))])),
    }
  }

  static fromDocument(document: PluginCoreStoreDocument): MemoryPluginCoreStore {
    const store = new MemoryPluginCoreStore()
    for (const run of document.runs) store.runs.set(run.runId, clone(run))
    for (const [runId, events] of Object.entries(document.events)) {
      store.events.set(runId, events.map(clone))
    }
    for (const [runId, artifacts] of Object.entries(document.artifacts)) {
      store.artifacts.set(runId, new Map(Object.entries(artifacts).map(([id, artifact]) =>
        [id, {
          record: { ...artifact.record },
          contentBase64: artifact.contentBase64,
        }])))
    }
    return store
  }

  private appendTo(runId: string, events: readonly PluginCoreEventAppend[]): PluginCoreEvent[] {
    const all = this.events.get(runId) ?? []
    let next = (all[all.length - 1]?.eventId ?? 0) + 1
    const appended: PluginCoreEvent[] = []
    for (const input of events) {
      const payload = pluginCoreEventPayloadSchema.parse(input.payload)
      const event: PluginCoreEvent = {
        schemaVersion: 1, eventId: next, occurredAt: input.occurredAt,
        runId, payload,
      }
      all.push(event)
      appended.push(clone(event))
      next += 1
    }
    this.events.set(runId, all)
    return appended
  }

  private terminalExpiry(nowMs = Date.parse(this.now())): string {
    return new Date(nowMs + this.terminalTtlMs).toISOString()
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Artifact metadata in the delivery event must match the stored artifact set. */
