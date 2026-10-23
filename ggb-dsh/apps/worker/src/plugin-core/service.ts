import { noDeliveryMessage } from './build-failure-summary.js'
import type { PluginCoreBuildFailure, PluginCoreImage } from '@ggb-copilot/application'
import { releaseRunFiles } from './retention.js'
import { PluginCoreExecutionState } from './execution-state.js'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import {
  dshModelCallObservations, sdkTurnOutcome, type ChannelPluginCoreDelivery,
  type ChannelPluginCoreModelCall, type PluginCoreCleanup, type RunId,
} from '@ggb-copilot/application'
import { PluginCoreBaseRegistry, type PluginCoreBase } from './base-registry.js'
import { PluginCoreTurnError, type PluginCoreDshRunner } from './dsh-runner.js'

export interface PluginCoreServiceOptions {
  /** Must equal the PluginCoreProcessRunner output root. */
  readonly outputRoot: string
  /** Release the completed run quota ledger after tools have drained. */
  readonly resetRun?: (runId: RunId) => void
  readonly state?: PluginCoreExecutionState
  /** Shared with the tool gateway so ggb_inspect/ggb_build can read the base. */
  readonly bases?: PluginCoreBaseRegistry
  readonly maxConcurrentRuns?: number
  /** Retry an empty assistant turn once. A new session is used; no tool call is replayed. */
  readonly retryEmptyTurn?: boolean
  /** Opt-in retry for one malformed-response turn. Defaults to off. */
  readonly retryMalformedResponse?: boolean
  /** One end-to-end deadline shared by the first turn and the empty-turn retry. */
  readonly runDeadlineMs?: number
  /** Pinned model identity for the formal usage ledger. */
  readonly modelId?: string
}

/** Worker-owned base input. The API supplies bytes; the Worker computes the digest. */
export interface PluginCoreBaseInput {
  readonly dataBase64: string
  readonly sha256: string
  readonly name: string | null
}

export interface PluginCoreUsage {
  readonly calls: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly reasoningTokens: number | null
  readonly cacheReadTokens: number | null
  readonly complete: boolean
}

export interface PluginCoreDiagnostics {
  readonly eventTypes: Record<string, number>
  readonly toolCalls: number
}

export interface PluginCoreServiceResult {
  readonly cleanup?: PluginCoreCleanup
  readonly finalResponse: string
  readonly delivery: ChannelPluginCoreDelivery | null
  readonly error: { readonly code: string; readonly message: string; readonly details?: PluginCoreBuildFailure } | null
  readonly usage: PluginCoreUsage | null
  readonly diagnostics: PluginCoreDiagnostics | null
  readonly modelId: string
  readonly durationMs: number
  readonly modelCalls: ChannelPluginCoreModelCall[]
  readonly modelCallsTruncated: boolean
}

const DEFAULT_MAX_CONCURRENT_RUNS = 1
const MAX_BASE_BYTES = 8 * 1024 * 1024
const MAX_FINAL_RESPONSE_CHARS = 200_000
const HEX_64 = /^[a-f0-9]{64}$/

interface TurnAttempts {
  results: RunResult[]
  /** Any attempt dropped events, so usage and call facts are incomplete. */
  truncated: boolean
}

/** Own one independent plugin-core run and its bounded delivery projection. */
export class PluginCoreService {
  private active = 0
  private readonly bases: PluginCoreBaseRegistry
  private readonly state: PluginCoreExecutionState
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly dsh: PluginCoreDshRunner,
    private readonly options: PluginCoreServiceOptions) {
    this.state = options.state ?? new PluginCoreExecutionState(options.outputRoot)
    this.bases = options.bases ?? new PluginCoreBaseRegistry()
  }

  activeRunIds(): ReadonlySet<string> { return new Set(this.controllers.keys()) }

  /** Cancel one in-flight turn; the Worker kills the DSH and plugin process trees. */
  cancel(runId: RunId): 'cancelled' | 'not_found' {
    const controller = this.controllers.get(runId)
    if (controller === undefined) return 'not_found'
    controller.abort(new Error('plugin_core_cancelled'))
    return 'cancelled'
  }

  /** Abort every in-flight turn and wait at most `graceMs` for their cleanup. */
  async stopAll(graceMs = 0): Promise<void> {
    for (const controller of this.controllers.values()) {
      controller.abort(new Error('plugin_core_shutdown'))
    }
    const deadline = Date.now() + graceMs
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    if (this.active > 0) {
      for (const runId of this.controllers.keys()) await this.state.quarantine(runId as RunId)
      throw new Error('plugin_core_cleanup_failed')
    }
  }

  /** Run one prompt through the plugin-core DSH path. The provider key stays in memory. */
  async run(input: { readonly runId: RunId; readonly deliveryContract?: 'legacy' | 'receipt-v1'; readonly providerKey: string;
    readonly prompt: string; readonly image?: PluginCoreImage; readonly base?: PluginCoreBaseInput | null }): Promise<PluginCoreServiceResult> {
    const result = await this.execute(input)
    return { ...result, cleanup: { runId: input.runId, confirmed: !this.state.unsafe(input.runId) && result.cleanup?.confirmed !== false,
      completedAt: new Date().toISOString() } }
  }

  private async execute(input: { readonly runId: RunId; readonly deliveryContract?: 'legacy' | 'receipt-v1'; readonly providerKey: string;
    readonly prompt: string; readonly image?: PluginCoreImage; readonly base?: PluginCoreBaseInput | null }): Promise<PluginCoreServiceResult> {
    const started = Date.now()
    const modelId = this.options.modelId ?? 'unknown'
    const limit = this.options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS
    const rejected = this.rejectAdmission(input)
    if (rejected) return rejected
    this.active += 1
    const controller = new AbortController()
    this.controllers.set(input.runId, controller)
    const deadline = started + (this.options.runDeadlineMs ?? 10 * 60_000)
    this.state.setDeadline(input.runId, deadline)
    const attempts: TurnAttempts = { results: [], truncated: false }
    let ownsFiles = false
    try {
      if (this.active + await this.state.quarantinedCount() > limit) {
        return failureResult('plugin_core_busy', 'Execution capacity is quarantined.', modelId, 0, [], false)
      }
      await this.state.assertRunSafe(input.runId)
      const epoch = await this.state.acquireEpoch(input.runId)
      ownsFiles = true
      this.state.invalidate(input.runId)
      await rm(join(this.options.outputRoot, input.runId, 'terminal.json'), { force: true })
      const prepared = await this.prepareBase(input.runId, input.base ?? null)
      if (!prepared.ok) {
        return failureResult(prepared.error!.code, prepared.error!.message,
          modelId, Date.now() - started, [], false)
      }
      if (prepared.base === null) this.bases.delete(input.runId)
      else this.bases.set(input.runId, prepared.base)
      attempts.results.push(await this.turnWithRetry(input, controller, deadline,
        prepared.base !== null, epoch, attempts))
      if ((this.options.retryEmptyTurn ?? true) && attempts.results.length === 1
        && this.state.buildFailure(input.runId)?.kind === 'not_built'
        && isEmptyTurn(attempts.results[0]!)) {
        attempts.results.push(await this.turn(input, controller, deadline, prepared.base !== null, epoch))
      }
      return await this.completeTurns(input.runId, attempts, controller, modelId, started)
    } catch (error) {
      return await this.failedTurn(error, input.runId, attempts, controller, modelId, started)
    } finally {
      await this.releaseResources(input.runId, ownsFiles)
    }
  }

  private rejectAdmission(input: { runId: RunId; deliveryContract?: string }): PluginCoreServiceResult | null {
    const expected = 'receipt-v1'
    if (input.deliveryContract !== expected) {
      return failureResult('plugin_core_contract_mismatch', 'Worker delivery contract does not match admission.',
        this.options.modelId ?? 'unknown', 0, [], false)
    }
    const modelId = this.options.modelId ?? 'unknown'
    const limit = this.options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS
    if (this.controllers.has(input.runId)) {
      return { ...failureResult('plugin_core_busy', 'This run already owns execution resources.', modelId, 0, [], false),
        cleanup: { runId: input.runId, confirmed: false, completedAt: new Date().toISOString() } }
    }
    if (this.active >= limit) {
      return failureResult('plugin_core_busy', 'The plugin-core build capacity is full. Retry later.',
        modelId, 0, [], false)
    }
    return null
  }

  private async completeTurns(runId: RunId, attempts: TurnAttempts, controller: AbortController,
    modelId: string, started: number): Promise<PluginCoreServiceResult> {
    const results = attempts.results
    const last = results[results.length - 1]!
    if (sdkTurnOutcome({ events: last.events ?? [] }).kind !== 'completed') {
      throw new Error('plugin_core_sdk_completion_missing')
    }
    const usage = withUnknownUsage(combineUsage(results), attempts.truncated)
    const diagnostics = combineDiagnostics(results)
    const calls = modelCalls(results, attempts.truncated)
    await this.record(runId, usage, diagnostics)
    const projected = await this.project(runId, last.finalResponse, usage, diagnostics,
      modelId, Date.now() - started, calls.calls, calls.truncated)
    if (controller.signal.aborted) throw new Error('plugin_core_cancelled')
    return projected
  }

  private async releaseResources(runId: RunId, ownsFiles: boolean): Promise<void> {
    this.state.release(runId)
    if (!this.state.unsafe(runId)) this.bases.delete(runId)
    this.options.resetRun?.(runId)
    if (ownsFiles && !this.state.unsafe(runId)) {
      try { await this.state.releaseOwner(runId); await releaseRunFiles(this.options.outputRoot, runId) }
      catch (error) { console.error('[worker] run file cleanup failed', runId, error instanceof Error ? error.name : 'unknown') }
    }
    this.controllers.delete(runId)
    this.active -= 1
  }

  /** Preserve failed-turn accounting without exposing the private evidence. */
  private async failedTurn(error: unknown, runId: RunId, attempts: TurnAttempts,
    controller: AbortController, modelId: string, started: number): Promise<PluginCoreServiceResult> {
    const results = attempts.results
    if (error instanceof PluginCoreTurnError) {
      results.push(error.partial)
      attempts.truncated ||= error.eventsTruncated
    }
    const aborted = controller.signal.aborted
    const cleanupFailed = error instanceof Error && error.message === 'plugin_core_cleanup_failed'
    if (cleanupFailed) await this.state.quarantine(runId)
    const code = cleanupFailed ? 'plugin_core_cleanup_failed' : aborted ? 'plugin_core_cancelled'
      : error instanceof Error && /^plugin_core_[a-z_]+$/u.test(error.message)
        ? error.message : 'plugin_core_failed'
    const message = aborted ? 'The plugin-core turn was cancelled.'
      : code === 'plugin_core_max_tokens'
        ? 'The model reached the output-token limit before completing the turn.'
        : 'The plugin-core turn did not complete.'
    let usage = results.length === 0 ? null : combineUsage(results)
    if (error instanceof PluginCoreTurnError && usage?.calls === 0) usage = null
    if (usage !== null) usage = withUnknownUsage(usage, attempts.truncated)
    if (usage !== null) await this.record(runId, usage, combineDiagnostics(results))
    const calls = modelCalls(results, attempts.truncated)
    const details = this.state.buildFailure(runId)
    return { ...failureResult(code, message,
      modelId, Date.now() - started, calls.calls, calls.truncated, usage),
    error: { code, message, ...(details === undefined ? {} : { details }) },
    cleanup: { runId, confirmed: !this.state.unsafe(runId), completedAt: new Date().toISOString() },
    diagnostics: results.length === 0 ? null : combineDiagnostics(results) }
  }

  private async turn(input: { readonly runId: RunId; readonly deliveryContract?: 'legacy' | 'receipt-v1'; readonly providerKey: string;
    readonly prompt: string; readonly image?: PluginCoreImage }, controller: AbortController, deadline: number,
    baseAttached: boolean, epoch: number): Promise<RunResult> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('plugin_core_timeout')
    try {
      return await this.dsh.run({ runId: input.runId, epoch,
        providerKey: input.providerKey, prompt: input.prompt, baseAttached,
        ...(input.image === undefined ? {} : { image: input.image }),
        timeoutMs: remaining, signal: controller.signal })
    } catch (error) {
      if (error instanceof PluginCoreTurnError) throw error
      if (controller.signal.aborted) throw new Error('plugin_core_cancelled')
      if (Date.now() >= deadline) throw new Error('plugin_core_timeout')
      throw error
    }
  }

  /**
   * Retry one malformed provider turn only when no tool call ran. The first
   * attempt still contributes usage accounting; a tool-call turn is never replayed.
   */
  private async turnWithRetry(input: { readonly runId: RunId; readonly deliveryContract?: 'legacy' | 'receipt-v1'; readonly providerKey: string;
    readonly prompt: string; readonly image?: PluginCoreImage }, controller: AbortController, deadline: number,
    baseAttached: boolean, epoch: number, attempts: TurnAttempts): Promise<RunResult> {
    try {
      return await this.turn(input, controller, deadline, baseAttached, epoch)
    } catch (error) {
      if ((this.options.retryMalformedResponse ?? false) === false
        || !isMalformedResponse(error) || error.eventsTruncated
        || hasToolCall(error.partial) || this.state.buildFailure(input.runId)?.kind !== 'not_built') throw error
      attempts.results.push(error.partial)
      attempts.truncated ||= error.eventsTruncated
      return await this.turn(input, controller, deadline, baseAttached, epoch)
    }
  }

  /** Write the Worker-owned base and bind it to the run before the model turn. */
  private async prepareBase(runId: RunId, input: PluginCoreBaseInput | null):
  Promise<{ ok: true; base: PluginCoreBase | null } | { ok: false; error: PluginCoreServiceResult['error'] }> {
    if (input === null) return { ok: true, base: null }
    let bytes: Buffer
    try { bytes = Buffer.from(input.dataBase64, 'base64') } catch {
      return { ok: false, error: { code: 'base_invalid',
        message: 'The base GGB is not valid base64.' } }
    }
    if (bytes.length === 0 || bytes.length > MAX_BASE_BYTES) {
      return { ok: false, error: { code: 'base_too_large',
        message: `The base GGB must be 1..${String(MAX_BASE_BYTES)} bytes.` } }
    }
    if (bytes.subarray(0, 2).toString() !== 'PK') {
      return { ok: false, error: { code: 'base_invalid',
        message: 'The base file is not a GGB ZIP archive.' } }
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== input.sha256) {
      return { ok: false, error: { code: 'base_digest_mismatch',
        message: 'The base GGB digest does not match the uploaded file.' } }
    }
    const dir = join(this.options.outputRoot, runId)
    const path = join(dir, 'base.ggb')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(path, bytes, { mode: 0o600 })
    return { ok: true, base: { path, sha256, name: input.name } }
  }

  private async project(runId: RunId, finalResponse: string, usage: PluginCoreUsage,
    diagnostics: PluginCoreDiagnostics, modelId: string, durationMs: number,
    calls: ChannelPluginCoreModelCall[], callsTruncated: boolean):
  Promise<PluginCoreServiceResult> {
    const delivery = this.state.candidate(runId)
    const details = this.state.missingDeliveryFailure(runId)
    const empty = finalResponse.trim().length === 0 && diagnostics.toolCalls === 0 && details.kind === 'not_built'
    return { finalResponse: this.bounded(finalResponse), delivery, usage, diagnostics,
      modelId, durationMs, modelCalls: calls, modelCallsTruncated: callsTruncated,
      cleanup: { runId, confirmed: !this.state.unsafe(runId), completedAt: new Date().toISOString() },
      error: delivery === null ? empty
        ? { code: 'plugin_core_empty_turn',
            message: 'The model produced an empty turn; no build was attempted.', details }
        : { code: 'plugin_core_no_delivery',
            message: noDeliveryMessage(details), details }
        : null }
  }

  /** Local, append-only diagnostic ledger; production accounting stays with the model gate. */
  private async record(runId: RunId, usage: PluginCoreUsage,
    diagnostics: PluginCoreDiagnostics): Promise<void> {
    try {
      const dir = join(this.options.outputRoot, runId)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const record = { runId, createdAt: new Date().toISOString(), usage, diagnostics }
      await writeFile(join(dir, 'usage.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    } catch { /* the ledger is diagnostic; the run result remains authoritative */ }
  }

  private bounded(value: string): string {
    return value.length <= MAX_FINAL_RESPONSE_CHARS ? value
      : `${value.slice(0, MAX_FINAL_RESPONSE_CHARS)}\n[truncated]`
  }
}

/** An empty assistant attempt with no tool call. Retry it once; a partial turn is not replayed. */
function isEmptyTurn(result: RunResult): boolean {
  if (result.finalResponse.trim().length > 0) return false
  const events = Array.isArray(result.events) ? result.events : []
  return !events.some(event => event.type === 'assistant/message' || event.type === 'tool/call')
}

function failureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isMalformedResponse(error: unknown): error is PluginCoreTurnError {
  return error instanceof PluginCoreTurnError
    && failureCode(error.cause) === 'MALFORMED_RESPONSE'
}

function hasToolCall(result: RunResult): boolean {
  const events = Array.isArray(result.events) ? result.events : []
  return events.some(event => event.type === 'tool/call'
    || event.type === 'tool/result')
}

function modelCalls(results: readonly RunResult[], truncated = false): {
  calls: ChannelPluginCoreModelCall[]
  truncated: boolean
} {
  // The array is mutable on purpose: it is serialized through the channel schema.

  const all = results.flatMap(result => result.events === undefined
    ? [] : dshModelCallObservations(result))
  return {
    calls: all.slice(0, 32).map(call => ({
      callOrdinal: call.callOrdinal,
      outcome: call.outcome,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      reasoningTokens: call.reasoningTokens,
      cacheReadTokens: call.cacheReadTokens,
      usageComplete: call.usageComplete,
    })),
    truncated: truncated || all.length > 32,
  }
}

/** Evidence truncation makes token totals unknowable, not merely incomplete. */
function withUnknownUsage(usage: PluginCoreUsage, truncated: boolean): PluginCoreUsage {
  return truncated ? { ...usage, inputTokens: null, outputTokens: null,
    reasoningTokens: null, cacheReadTokens: null, complete: false } : usage
}

function failureResult(code: string, message: string, modelId: string,
  durationMs: number, calls: ChannelPluginCoreModelCall[],
  truncated: boolean, usage: PluginCoreUsage | null = null): PluginCoreServiceResult {
  return {
    finalResponse: '', delivery: null, usage, diagnostics: null,
    modelId, durationMs, modelCalls: calls, modelCallsTruncated: truncated,
    error: { code, message },
  }
}

function combineUsage(results: readonly RunResult[]): PluginCoreUsage {
  const parts = results.map(usageOf)
  const sum = (key: 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cacheReadTokens'):
  number | null => parts.every(part => part[key] !== null)
    ? parts.reduce((total, part) => total + (part[key] as number), 0) : null
  return { calls: parts.reduce((total, part) => total + part.calls, 0),
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    reasoningTokens: sum('reasoningTokens'), cacheReadTokens: sum('cacheReadTokens'),
    complete: parts.every(part => part.complete) }
}

function combineDiagnostics(results: readonly RunResult[]): PluginCoreDiagnostics {
  const eventTypes: Record<string, number> = {}
  let toolCalls = 0
  for (const result of results) {
    const part = diagnosticsOf(result)
    toolCalls += part.toolCalls
    for (const [type, count] of Object.entries(part.eventTypes)) {
      eventTypes[type] = (eventTypes[type] ?? 0) + count
    }
  }
  return { eventTypes, toolCalls }
}

function usageOf(result: RunResult): PluginCoreUsage {
  const observations = Array.isArray(result.events) ? dshModelCallObservations(result) : []
  if (observations.length === 0) {
    return { calls: 0, inputTokens: null, outputTokens: null,
      reasoningTokens: null, cacheReadTokens: null, complete: false }
  }
  const total = (key: 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cacheReadTokens'):
  number | null => observations.every(item => item[key] !== null)
    ? observations.reduce((sum, item) => sum + (item[key] as number), 0) : null
  return { calls: observations.length, inputTokens: total('inputTokens'),
    outputTokens: total('outputTokens'), reasoningTokens: total('reasoningTokens'),
    cacheReadTokens: total('cacheReadTokens'),
    complete: observations.every(item => item.usageComplete) }
}

function diagnosticsOf(result: RunResult): PluginCoreDiagnostics {
  const eventTypes: Record<string, number> = {}
  const events = Array.isArray(result.events) ? result.events : []
  for (const event of events) eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1
  const toolCalls = Object.entries(eventTypes)
    .filter(([type]) => /^tool\//u.test(type))
    .reduce((sum, [, count]) => sum + count, 0)
  return { eventTypes, toolCalls }
}
