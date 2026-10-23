import { pluginCoreImageSchema, type PluginCoreImage, type PluginCoreBuildFailure, type PluginCoreProgressObserver } from '@ggb-copilot/application'
import { createHash } from 'node:crypto'
import {
  agentEngineSchema, bodyDigest, canonicalJson, isTerminalPluginCorePhase,
  runIdSchema, runTokenVerifier, verifiersEqual,
  type AgentEngine, type ChannelPluginCoreBase, type ChannelPluginCoreDelivery,
  type ChannelPluginCoreResult, type PluginCoreArtifactKind, type PluginCoreDelivery,
  type PluginCoreRunRecord, type PluginCoreRunView, type PluginCoreUsage,
  type RunId, type RunToken, type PluginCoreCleanup,
} from '@ggb-copilot/application'
import type {
  PluginCoreArtifactRecordView, PluginCoreStore,
} from '@ggb-copilot/run-persistence'
import { RunError } from '@ggb-copilot/application'

const EXECUTION_TTL_MS = 13 * 60_000
const MAX_PROMPT_CHARS = 12_000
const MAX_BASE_BYTES = 8 * 1024 * 1024

export interface PluginCoreWorkerPort {
  runPluginCore(request: { deliveryContract?: 'legacy' | 'receipt-v1'; runId: RunId; providerKey: string; prompt: string;
    image?: PluginCoreImage; base?: ChannelPluginCoreBase | null }, signal?: AbortSignal, onProgress?: PluginCoreProgressObserver): Promise<ChannelPluginCoreResult>
}

export interface PluginCoreRunServiceConfig {
  engine: AgentEngine
  serverPepper: string
  maxConcurrentRuns: number
  activeRunTtlMs: number
  terminalRunTtlMs: number
  now?: () => Date
}

export interface CreatePluginCoreRunInput {
  runId: RunId
  runToken: RunToken
  idempotencyKey: string | null
  providerKey: string | null
  prompt: string
  base: ChannelPluginCoreBase | null
  requestDigest: string
  image?: unknown
}

/** Owns plugin-core runs, SSE/artifact authorization and the formal usage ledger. */
export class PluginCoreRunService {
  private readonly active = new Map<string, AbortController>()
  private readonly pendingDeletes = new Set<string>()
  private readonly now: () => Date
  private draining = false

  constructor(private readonly store: PluginCoreStore,
    private readonly worker: PluginCoreWorkerPort,
    private readonly config: PluginCoreRunServiceConfig) {
    this.now = config.now ?? (() => new Date())
  }

  async createRun(input: CreatePluginCoreRunInput): Promise<{ runId: RunId; phase: string }> {
    if (this.draining) {
      throw new RunError('capacity_unavailable', 'The API is draining')
    }
    if (this.config.engine !== 'plugin_core') {
      throw new RunError('engine_not_supported',
        'The plugin-core engine is not enabled on this deployment')
    }
    const runId = runIdSchema.parse(input.runId)
    if (input.idempotencyKey === null || input.idempotencyKey !== runId) {
      throw new RunError('invalid_request', 'Idempotency-Key must equal runId')
    }
    if (input.providerKey === null || input.providerKey.length === 0) {
      throw new RunError('invalid_request', 'x-ggb-provider-key is required')
    }
    const prompt = input.prompt.trim()
    if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) {
      throw new RunError('invalid_request',
        `prompt must be 1..${String(MAX_PROMPT_CHARS)} characters`)
    }
    const parsedImage = input.image === undefined ? null : pluginCoreImageSchema.safeParse(input.image)
    if (parsedImage !== null && !parsedImage.success) {
      throw new RunError('invalid_request', 'image must be a valid PNG/JPEG of at most 3 MiB')
    }
    const image = parsedImage?.success ? parsedImage.data : undefined
    const base = input.base === null ? null : validateBase(input.base)
    const requestDigest = input.requestDigest
    const tokenVerifier = runTokenVerifier(input.runToken, this.config.serverPepper)
    const access = await this.store.getRunAccessFacts(runId)
    if (access !== null) {
      if (!verifiersEqual(access.tokenVerifier, tokenVerifier)
        || access.requestDigest !== requestDigest) {
        throw new RunError('duplicate_run_conflict',
          'runId already exists with a different body or token')
      }
      const existing = await this.store.getRun(runId)
      if (existing === null) throw new RunError('not_found', 'run not found')
      return { runId, phase: existing.phase }
    }
    const now = this.now()
    const spec = {
      deliveryContract: 'receipt-v1' as const,
      runId,
      tokenVerifier,
      requestDigest,
      prompt,
      promptDigest: createHash('sha256').update(prompt).digest('hex'),
      baseSha256: base?.sha256 ?? null,
      baseName: base?.name ?? null,
      executionExpiresAt: new Date(now.getTime() + EXECUTION_TTL_MS).toISOString(),
      expiresAt: new Date(now.getTime() + this.config.activeRunTtlMs).toISOString(),
    }
    const created = await this.store.createRun(spec)
    if (created.kind === 'conflict') {
      throw new RunError('duplicate_run_conflict',
        'runId already exists with a different body or token')
    }
    if (created.kind === 'existing') {
      return { runId, phase: created.record.phase }
    }
    if (await this.store.countActiveRuns() > this.config.maxConcurrentRuns) {
      await this.store.deleteRun(runId)
      throw new RunError('capacity_unavailable',
        'plugin-core is at its concurrent run limit')
    }
    // Detached from the HTTP request: a client disconnect must not cancel the run.
    void this.execute(created.record, input.providerKey, base, image).catch(() => {
      console.error('[api] plugin-core settlement failed', runId)
    })
    return { runId, phase: created.record.phase }
  }

  async getRunView(runId: RunId, runToken: RunToken): Promise<PluginCoreRunView> {
    const record = await this.authorize(runId, runToken)
    return await this.viewOf(record)
  }

  async stop(runId: RunId, runToken: RunToken): Promise<{ runId: RunId; phase: string }> {
    const record = await this.authorize(runId, runToken)
    if (!isTerminalPluginCorePhase(record.phase)) {
      await this.store.requestStop(runId)
      this.active.get(runId)?.abort(new Error('plugin_core_cancelled'))
    }
    const current = await this.store.getRun(runId)
    if (current === null) throw new RunError('not_found', 'run not found')
    return { runId, phase: current.phase }
  }

  async deleteRun(runId: RunId, runToken: RunToken): Promise<void> {
    const record = await this.authorize(runId, runToken)
    if (!isTerminalPluginCorePhase(record.phase)) {
      await this.store.requestStop(runId)
      this.pendingDeletes.add(runId)
      this.active.get(runId)?.abort(new Error('plugin_core_cancelled'))
      if (record.phase === 'running' || this.active.has(runId)) return
    }
    await this.store.deleteRun(runId)
  }

  async getArtifact(runId: RunId, runToken: RunToken, artifactId: string): Promise<{
    record: PluginCoreArtifactRecordView
    contentBase64: string
  }> {
    await this.authorize(runId, runToken)
    const artifact = await this.store.getArtifact(runId, artifactId)
    if (artifact === null) throw new RunError('not_found', 'artifact not found')
    return artifact
  }

  async eventsSource(runId: RunId, runToken: RunToken) {
    await this.authorize(runId, runToken)
    return this.store
  }

  async sweepExpired(limit = 50): Promise<number> {
    const now = this.now().toISOString()
    const swept = await this.store.sweepExpired(now, limit)
    for (const [runId, controller] of this.active) {
      const record = await this.store.getRun(runId as RunId)
      if (record && Date.parse(record.executionExpiresAt ?? record.expiresAt) <= Date.parse(now)) {
        controller.abort(new Error('plugin_core_timeout'))
      }
    }
    return swept
  }

  async capacity(): Promise<{ activeRuns: number; maxConcurrentRuns: number }> {
    return {
      activeRuns: await this.store.countActiveRuns(),
      maxConcurrentRuns: this.config.maxConcurrentRuns,
    }
  }

  /** Abort every in-flight run during API drain. The Worker receives a cancel message. */
  stopAll(): void {
    for (const controller of this.active.values()) {
      controller.abort(new Error('plugin_core_draining'))
    }
  }

  /** Keep the channel and store alive until terminal settlement has finished. */
  async waitForSettlements(graceMs: number): Promise<boolean> {
    const deadline = Date.now() + graceMs
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return this.active.size === 0
  }

  /** §15: stop admission; in-flight runs keep their grace window until dispose. */
  beginDrain(): void {
    this.draining = true
  }

  /** §6.1/§15: readiness answers whether this process still accepts new runs. */
  async healthReady(): Promise<{ status: 'ok' | 'draining' }> {
    return { status: this.draining ? 'draining' : 'ok' }
  }

  async authorize(runId: RunId, runToken: RunToken): Promise<PluginCoreRunRecord> {
    const access = await this.store.getRunAccessFacts(runId)
    const expected = runTokenVerifier(runToken, this.config.serverPepper)
    if (access === null || !verifiersEqual(access.tokenVerifier, expected)) {
      throw new RunError('not_found', 'run not found')
    }
    const record = await this.store.getRun(runId)
    if (record === null) throw new RunError('not_found', 'run not found')
    return record
  }

  private async viewOf(record: PluginCoreRunRecord): Promise<PluginCoreRunView> {
    // Read a bounded, durable prefix first. No event newer than this cursor is skipped on reconnect.
    const events = await this.store.listEvents(record.runId as RunId, 0, 512)
    const earliest = events[0]?.eventId ?? null
    const latest = events.at(-1)?.eventId ?? null
    const progressEvent = [...events].reverse().find(event => event.payload.type === 'plugin_core.progress')
    record = await this.store.getRun(record.runId as RunId) ?? record
    return {
      runId: record.runId,
      engine: 'plugin_core',
      progress: progressEvent?.payload.type === 'plugin_core.progress' ? progressEvent.payload.progress : null,
      phase: record.phase,
      stopRequested: record.stopRequested,
      finalResponse: record.finalResponse,
      failure: record.failure,
      delivery: record.delivery,
      usage: record.usage,
      durationMs: record.durationMs,
      modelId: record.modelId,
      createdAt: record.createdAt,
      events: { earliestEventId: earliest, latestEventId: latest },
      terminal: isTerminalPluginCorePhase(record.phase),
    }
  }

  private async execute(record: PluginCoreRunRecord, providerKey: string,
    base: ChannelPluginCoreBase | null, image?: PluginCoreImage): Promise<void> {
    const runId = record.runId as RunId
    const controller = new AbortController()
    this.active.set(runId, controller)
    const started = Date.now()
    let cleanup: PluginCoreCleanup | undefined
    let dispatchPending = false
    try {
      const running = await this.store.markRunning(runId)
      if (running !== 'running') return
      dispatchPending = true
      const result = await this.worker.runPluginCore({
        runId, providerKey, prompt: record.prompt, base, ...(image === undefined ? {} : { image }), deliveryContract: record.deliveryContract ?? 'legacy',
      }, controller.signal, async progress => {
        await this.store.appendEvents(runId, [{ payload: { type: 'plugin_core.progress', progress },
          occurredAt: progress.occurredAt }])
      })
      dispatchPending = false
      const durationMs = result.durationMs ?? Date.now() - started
      const usage = usageOf(result)
      if (result.cleanup?.runId !== runId) {
        await this.fail(runId, 'plugin_core_worker_unavailable', usage, durationMs,
          result.modelId ?? 'unknown', 'The Worker returned no matching cleanup proof; cleanup is unknown.')
        return
      }
      if (result.cleanup.confirmed !== true) {
        await this.fail(runId, 'plugin_core_cleanup_failed', usage, durationMs,
          result.modelId ?? 'unknown', undefined, undefined, result.error?.details)
        return
      }
      cleanup = result.cleanup
      if (result.error?.code === 'plugin_core_cancelled') {
        await this.store.cancelRun(runId, this.terminalExpiry(), result.cleanup)
        return
      }
      if (result.error !== null || result.delivery === null) {
        console.error('[api] plugin-core run failed', runId, result.error?.code)
        await this.fail(runId, result.error?.code, usage, durationMs,
          result.modelId ?? 'unknown',
          result.error === null ? undefined
            : result.error.message, cleanup, result.error?.details)
        return
      }
      const completed = await this.complete(runId, result, usage, durationMs)
      if (completed === 'conflict') {
        const current = await this.store.getRun(runId)
        if (current && !isTerminalPluginCorePhase(current.phase)) {
          await this.fail(runId, 'plugin_core_commit_conflict', usage, durationMs,
            result.modelId ?? 'unknown', undefined, cleanup)
        } else console.error('[api] late plugin-core completion ignored', runId)
      }
    } catch (error) {
      if (controller.signal.aborted && cleanup?.confirmed) {
        await this.store.cancelRun(runId, this.terminalExpiry(), cleanup)
        return
      }
      if (dispatchPending) {
        await this.fail(runId, 'plugin_core_worker_unavailable', null, Date.now() - started, 'unknown',
          'The Worker channel failed; execution cleanup is unknown.')
        return
      }
      const code = error instanceof Error && /^plugin_core_[a-z_]+$/u.test(error.message)
        ? error.message : 'plugin_core_failed'
      await this.fail(runId, code, null, Date.now() - started, 'unknown', undefined, cleanup)
    } finally {
      try {
        if (this.pendingDeletes.delete(runId)) await this.store.deleteRun(runId)
      } finally { this.active.delete(runId) }
    }
  }

  private async complete(runId: RunId, result: ChannelPluginCoreResult,
    usage: PluginCoreUsage | null, durationMs: number): Promise<string> {
    const delivery = result.delivery!
    if (delivery.ggbBase64 === null) {
      await this.fail(runId, 'plugin_core_delivery_missing', usage, durationMs,
        result.modelId ?? 'unknown', undefined, result.cleanup)
      return 'failed'
    }
    const ggb = Buffer.from(delivery.ggbBase64, 'base64')
    if (ggb.length !== delivery.ggbBytes) throw new Error('plugin_core_delivery_invalid')
    if (!delivery.trustedBuild) return 'conflict'
    const verificationBytes = requiredBytes(delivery.reportBase64)
    const manifestBytes = requiredBytes(delivery.manifestBase64)
    const artifacts = [
      artifact(delivery.id, 'result_ggb', ggb, 'application/octet-stream'),
      ...(delivery.screenshotBase64 === null ? [] : [artifact(
        `preview-${delivery.id}`, 'preview',
        Buffer.from(delivery.screenshotBase64, 'base64'), 'image/png')]),
      artifact(`verification-${delivery.id}`, 'verification',
        verificationBytes, 'application/json'),
      artifact(`manifest-${delivery.id}`, 'manifest',
        manifestBytes, 'application/json'),
    ]
    const pluginDelivery: PluginCoreDelivery = {
      id: delivery.id,
      artifacts: artifacts.map(item => ({
        artifactId: item.artifactId, kind: item.kind, sizeBytes: item.sizeBytes,
        sha256: item.sha256, contentType: item.contentType,
      })),
      verification: delivery.verification,
      ...(delivery.construction ? { construction: delivery.construction } : {}),
      ...(result.cleanup ? { cleanup: result.cleanup } : {}),
      ...(delivery.trustedBuild ? { trustedBuild: delivery.trustedBuild } : {}),
    }
    const completed = await this.store.completeRun({
      runId,
      finalResponse: result.finalResponse,
      ...(result.cleanup ? { cleanup: result.cleanup } : {}),
      delivery: pluginDelivery,
      usage,
      durationMs,
      modelId: result.modelId ?? 'unknown',
      artifacts,
      expiresAt: new Date(this.now().getTime() + this.config.terminalRunTtlMs).toISOString(),
    })
    return completed
  }

  private async fail(runId: RunId, code: string | undefined,
    usage: PluginCoreUsage | null, durationMs: number, modelId: string,
    message?: string, cleanup?: PluginCoreCleanup, details?: PluginCoreBuildFailure): Promise<void> {
    const failure = {
      code: pluginFailureCode(code),
      message: message ?? 'The plugin-core run did not produce a verified delivery.',
      ...(details === undefined ? {} : { details }),
    }
    const outcome = await this.store.failRun({
      runId, failure, usage, durationMs, modelId,
      ...(cleanup ? { cleanup } : {}),
      expiresAt: new Date(this.now().getTime() + this.config.terminalRunTtlMs).toISOString(),
    })
    if (outcome === 'conflict') {
      const current = await this.store.getRun(runId)
      if (current && !isTerminalPluginCorePhase(current.phase)) {
        console.error('[api] plugin-core failure CAS conflict', runId)
      }
    }
  }

  private terminalExpiry(): string {
    return new Date(this.now().getTime() + this.config.terminalRunTtlMs).toISOString()
  }
}

function validateBase(base: ChannelPluginCoreBase): ChannelPluginCoreBase {
  const bytes = Buffer.from(base.dataBase64, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_BASE_BYTES) {
    throw new RunError('payload_too_large', 'base GGB must be 1..8388608 bytes')
  }
  if (bytes.subarray(0, 2).toString() !== 'PK') {
    throw new RunError('invalid_request', 'base GGB must be a ZIP archive')
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== base.sha256) {
    throw new RunError('invalid_request', 'base.sha256 does not match the upload')
  }
  return { ...base, sha256 }
}

function artifact(artifactId: string, kind: PluginCoreArtifactKind,
  bytes: Buffer, contentType: string) {
  return {
    artifactId,
    kind,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType,
    contentBase64: bytes.toString('base64'),
  }
}

function usageOf(result: ChannelPluginCoreResult): PluginCoreUsage | null {
  if (result.usage === null || result.usage === undefined) return null
  return {
    calls: result.usage.calls,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.reasoningTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    complete: result.usage.complete,
    source: result.usage.complete ? 'sdk' : 'unknown',
  }
}

function pluginFailureCode(value: string | undefined):
  'plugin_core_failed' | 'plugin_core_max_tokens' | 'plugin_core_no_delivery'
  | 'plugin_core_empty_turn' | 'plugin_core_disabled' | 'plugin_core_timeout'
  | 'plugin_core_worker_unavailable' | 'plugin_core_interrupted'
  | 'plugin_core_cancelled' | 'plugin_core_delivery_missing'
  | 'plugin_core_cleanup_failed' | 'plugin_core_commit_conflict' | 'plugin_core_delivery_invalid' {
  switch (value) {
    case 'plugin_core_max_tokens':
    case 'plugin_core_no_delivery':
    case 'plugin_core_empty_turn':
    case 'plugin_core_delivery_invalid':
    case 'plugin_core_cleanup_failed':
    case 'plugin_core_commit_conflict':
    case 'plugin_core_disabled':
    case 'plugin_core_timeout':
    case 'plugin_core_interrupted':
    case 'plugin_core_cancelled':
    case 'plugin_core_delivery_missing':
      return value
    case 'plugin_core_worker_unavailable':
      return 'plugin_core_worker_unavailable'
    default:
      return 'plugin_core_failed'
  }
}

// Keep the engine schema exported so config parsing and bootstrap share one value.
export { agentEngineSchema }

function requiredBytes(value: string | undefined): Buffer {
  if (!value) throw new Error('plugin_core_delivery_missing')
  return Buffer.from(value, 'base64')
}
