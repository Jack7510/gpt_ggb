import type { HostDraftSession } from './tool-protocol.js'
import type { PluginCoreReferenceHistory } from './reference-history.js'
import type { PluginCoreImageInputContract } from './image-input-contract.js'
import { summarizeBuildFailure } from './build-failure-summary.js'
import type { PluginCoreExecutionState } from './execution-state.js'
import { randomUUID } from 'node:crypto'
import { runIdSchema, toolArgumentsDigest, type RunId } from '@ggb-copilot/application'
import { redactEvidence, type PluginCoreEvidenceStore, type ToolCallEvidence } from './evidence.js'
import type { PluginCoreBaseRegistry } from './base-registry.js'
import type { PluginCoreRunResult } from './process-runner.js'

export type PluginCoreToolName = 'ggb_inspect' | 'ggb_request' | 'ggb_check' | 'ggb_build'

interface PluginCoreProcessRunnerPort {
  check(request: unknown, runId: RunId, signal?: AbortSignal, base?: import('./process-runner.js').PluginCoreBaseInput, call?: PluginCoreToolRequest): Promise<PluginCoreRunResult>
  build(request: unknown, runId: RunId, signal?: AbortSignal, base?: import('./process-runner.js').PluginCoreBaseInput,
    call?: PluginCoreToolRequest & { buildId: string }): Promise<PluginCoreRunResult>
  inspect?(base: import('./process-runner.js').PluginCoreBaseInput, runId: RunId, signal?: AbortSignal, call?: PluginCoreToolRequest): Promise<import('./process-runner.js').PluginCoreInspectResult>
  reference?(topic: string): Promise<unknown>
  references?(topics: string[]): Promise<unknown>
}

export interface PluginCoreToolRequest {
  readonly toolName: PluginCoreToolName
  readonly runId: RunId
  readonly turnId: string
  readonly epoch: number
  readonly requestId?: string
  readonly toolCallId?: string
  readonly argumentsDigest?: string
  readonly protocolVersion?: 3
  readonly draftSession?: HostDraftSession
  readonly referenceHistory?: PluginCoreReferenceHistory
  readonly imageInput?: PluginCoreImageInputContract
  readonly wireArguments?: unknown
  /** The plugin request object. The runner removes any model-supplied output path. */
  readonly arguments: unknown
}

export interface PluginCoreToolError {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

export interface PluginCoreFailedCheck {
  readonly requirementId: string
  readonly checkId: string
  readonly method: string
  readonly status: string
  readonly reason?: string
}

/** Bounded, path-free build facts for the model to repair from. */
export interface PluginCoreToolReport {
  readonly status: 'accepted' | 'rejected'
  readonly buildId?: string
  readonly phase?: 'preflight' | 'execution'
  readonly verification?: unknown
  readonly failedChecks: readonly PluginCoreFailedCheck[]
  readonly issueCount: number
  readonly error?: { readonly code: string; readonly message: string }
}

/** The bounded result the model receives. Server paths and raw reports never cross this boundary. */
export interface PluginCoreToolResult {
  readonly status: 'accepted' | 'rejected'
  readonly toolName: PluginCoreToolName
  readonly result: unknown | null
  readonly errors: readonly PluginCoreToolError[]
  readonly report?: PluginCoreToolReport
  readonly buildBudget?: { readonly used: number; readonly limit: number; readonly remaining: number }
}

export interface PluginCoreGatewayOptions {
  /** A run may build at most this many times. The host repairs the request between builds. */
  readonly maxBuildsPerRun?: number
  readonly state?: PluginCoreExecutionState
  readonly evidence?: PluginCoreEvidenceStore
  /** Worker-owned base GGBs; never model input. */
  readonly bases?: PluginCoreBaseRegistry
}

const DEFAULT_MAX_BUILDS_PER_RUN = 3

/** Own plugin-core tool admission and the model-facing projection. */
export class PluginCoreGateway {
  private readonly builds = new Map<string, number>()
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly runner: PluginCoreProcessRunnerPort,
    private readonly options: PluginCoreGatewayOptions = {}) {}

  /** Dispatch one authenticated plugin-core tool call. */
  async dispatch(request: PluginCoreToolRequest, signal?: AbortSignal): Promise<PluginCoreToolResult> {
    const previous = this.queues.get(request.runId) ?? Promise.resolve()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => hold)
    this.queues.set(request.runId, tail)
    await previous
    try {
      return await this.dispatchAudited(request, signal)
    } finally {
      release()
      if (this.queues.get(request.runId) === tail) this.queues.delete(request.runId)
    }
  }

  private async dispatchAudited(request: PluginCoreToolRequest,
    signal?: AbortSignal): Promise<PluginCoreToolResult> {
    const turn = this.options.evidence?.get(request.turnId)
    const wireArguments = request.wireArguments ?? request.arguments
    const call = await turn?.beginCall({ requestId: request.requestId ?? randomUUID(),
      toolCallId: request.toolCallId ?? randomUUID(), toolName: request.toolName,
      protocolVersion: request.protocolVersion ?? 3, arguments: wireArguments,
      argumentsDigest: request.argumentsDigest ?? toolArgumentsDigest(wireArguments),
      domainRequestDigest: toolArgumentsDigest(request.arguments) })
    const callId = randomUUID()
    try {
      const result = this.withBudget(request.runId, await this.executeSaved(request, signal, call, callId))
      this.options.state?.reportProgress(request.runId, { tool: request.toolName, status: result.status, callId,
        ...(result.report?.buildId ? { buildId: result.report.buildId } : {}) })
      await call?.update(result.status)
      return (turn?.model(result) ?? redactEvidence(result, [], true)) as PluginCoreToolResult
    } catch (error) {
      if (error instanceof Error && error.name === 'DraftError') {
        this.options.state?.reportProgress(request.runId, { tool: request.toolName, status: 'rejected', callId })
        await call?.failed(error)
        const code = 'code' in error && typeof error.code === 'string' ? error.code : 'invalid_input'
        return this.withBudget(request.runId, this.rejected(request.toolName, code, error.message))
      }
      this.options.state?.reportProgress(request.runId, { tool: request.toolName, status: 'failed', callId })
      if (error instanceof Error && error.message === 'plugin_core_cleanup_failed') {
        await this.options.state?.quarantine(request.runId)
      }
      await call?.failed(error)
      throw error
    }
  }

  /** The installed plugin owns draft assembly; only resolved snapshots reach execution. */
  private async executeSaved(request: PluginCoreToolRequest, signal?: AbortSignal,
    call?: ToolCallEvidence, callId = randomUUID()): Promise<PluginCoreToolResult> {
    signal?.throwIfAborted()
    const draft = request.draftSession
    if (!draft) return await this.execute(request, signal, call, callId)
    if (request.toolName === 'ggb_request') {
      this.options.state?.reportProgress(request.runId, { tool: request.toolName, status: 'started', callId })
      if (request.imageInput?.canSave(request.arguments) === false) {
        const result = this.rejected('ggb_request', 'image_transcription_required',
          'An image is attached. Before the first save, include nonempty transcription with the complete mathematical problem text: givens, equations, labels, constraints and question. Preserve ambiguity; do not solve or invent conditions. Repairs may omit saved transcription, but cannot clear it.')
        await call?.result({ ok: false, error: result.errors[0] })
        return result
      }
      const result = draft.operate(request.arguments)
      request.imageInput?.accepted()
      if (isRecord(request.arguments) && request.arguments.action !== 'read') this.options.state?.invalidate(request.runId)
      await call?.result(result)
      return { status: 'accepted', toolName: request.toolName, result, errors: [] }
    }
    if (request.toolName === 'ggb_inspect') return await this.execute(request, signal, call, callId)
    const snapshot = request.toolName === 'ggb_check' ? draft.forCheck(request.arguments) : draft.forBuild(request.arguments)
    await call?.update('resolved', { domainRequestDigest: snapshot.domainRequestDigest, revision: snapshot.revision })
    const { draftSession: _session, ...resolved } = request
    const result = await this.execute({ ...resolved, arguments: snapshot.request }, signal, call, callId)
    if (request.toolName === 'ggb_check' && result.status === 'accepted') {
      return { ...result, result: { ...(isRecord(result.result) ? result.result : {}), ...draft.acceptCheck(snapshot) } }
    }
    return result
  }

  private async execute(request: PluginCoreToolRequest, signal?: AbortSignal,
    call?: ToolCallEvidence, callId = randomUUID()): Promise<PluginCoreToolResult> {
    if (signal?.aborted === true) throw new Error('plugin_core_tool_cancelled')
    const runId = runIdSchema.parse(request.runId)
    const pluginRequest = request.arguments
    if (request.toolName !== 'ggb_build') this.options.state?.reportProgress(request.runId, {
      tool: request.toolName, status: 'started', callId })
    const base = this.options.bases?.get(runId)
    if (request.toolName === 'ggb_inspect') {
      const args = pluginRequest as { reference?: unknown; references?: unknown; refresh?: unknown } | null
      if (args?.references !== undefined) {
        if (args.reference !== undefined || !Array.isArray(args.references)
          || !args.references.every(topic => typeof topic === 'string') || !this.runner.references) {
          return this.rejected('ggb_inspect', 'reference_unavailable', 'Reference batch is unavailable or invalid.')
        }
        await call?.update('started', { operation: 'reference', topics: args.references })
        try {
          const result = request.referenceHistory
            ? await request.referenceHistory.read(args.references, topics => this.runner.references!(topics), args.refresh === true)
            : await this.runner.references(args.references)
          await call?.result({ ok: true, check: result })
          return { status: 'accepted', toolName: 'ggb_inspect', errors: [], result }
        } catch (error) {
          if (error instanceof Error && error.message === 'ggb_reference_response_oversized') {
            await call?.failed(error)
            return this.rejected('ggb_inspect', 'reference_limit_exceeded', 'Read fewer topics; the complete reference batch exceeds the byte limit.')
          }
          throw error
        }
      }
      if (args?.reference !== undefined) {
        if (typeof args.reference !== 'string' || !this.runner.reference) {
          return this.rejected('ggb_inspect', 'reference_unavailable', 'Reference topic is unavailable.')
        }
        await call?.update('started', { operation: 'reference' })
        const result = request.referenceHistory
          ? await request.referenceHistory.read([args.reference], topics => this.runner.reference!(topics[0]!), args.refresh === true)
          : await this.runner.reference(args.reference)
        await call?.result({ ok: true, check: result })
        return { status: 'accepted', toolName: 'ggb_inspect', errors: [], result }
      }
      if (base === undefined) {
        return this.rejected('ggb_inspect', 'base_missing',
          'No base GGB is attached to this run; create a new figure instead.')
      }
      if (this.runner.inspect === undefined) {
        return this.rejected('ggb_inspect', 'inspect_unavailable', 'Inspect is unavailable.')
      }
      await call?.update('started', { operation: 'inspect', baseSha256: base.sha256 })
      const inspected = await this.runner.inspect(base, runId, signal, request)
      if (inspected.execution?.cleanupConfirmed === false) await this.options.state?.quarantine(runId)
      await call?.result(inspected)
      if (!inspected.ok) {
        return this.rejected('ggb_inspect', inspected.error?.code ?? 'inspect_failed',
          inspected.error?.message ?? 'The base GGB could not be read.', inspected.error?.details)
      }
      return { status: 'accepted', toolName: 'ggb_inspect', errors: [],
        result: inspected.data }
    }
    if (request.toolName === 'ggb_check') {
      await call?.update('started', { operation: 'check', baseSha256: base?.sha256 ?? null })
      const result = await this.runner.check(pluginRequest, runId, signal, base, request)
      if (result.execution?.cleanupConfirmed === false) await this.options.state?.quarantine(runId)
      await call?.result(result)
      return this.project(request.toolName, result)
    }
    if (request.toolName !== 'ggb_build') {
      return this.rejected(request.toolName as PluginCoreToolName, 'unknown_tool',
        `Unknown plugin-core tool: ${String(request.toolName)}`)
    }
    return await this.build(request, pluginRequest, runId, signal, call, callId)
  }

  private async build(request: PluginCoreToolRequest, pluginRequest: unknown,
    runId: RunId, signal?: AbortSignal, call?: ToolCallEvidence, callId = randomUUID()): Promise<PluginCoreToolResult> {
    const base = this.options.bases?.get(runId)
    const builds = this.builds.get(runId) ?? 0
    const limit = this.options.maxBuildsPerRun ?? DEFAULT_MAX_BUILDS_PER_RUN
    if (builds >= limit) {
      return this.rejected(request.toolName, 'build_limit_reached',
        `This run already used ${String(limit)} builds. Report the remaining evidence; do not build again.`)
    }
    // Reserve before the side effect so a crash or timeout still counts as an attempt.
    this.builds.set(runId, builds + 1)
    const buildId = randomUUID()
    this.options.state?.reportProgress(runId, { tool: 'ggb_build', status: 'started', callId,
      buildId, attempt: builds + 1, limit })
    this.options.state?.invalidate(runId)
    this.options.state?.startBuild(runId, buildId)
    await call?.update('started', { operation: 'build', buildId, baseSha256: base?.sha256 ?? null })
    const result = await this.runner.build(pluginRequest, runId, signal, base, { ...request, buildId })
    const projected = this.project(request.toolName, result, buildId)
    this.options.state?.finishBuild(runId, buildId, result.ok ? undefined
      : summarizeBuildFailure(result, buildId, projected.report!))
    if (result.execution?.cleanupConfirmed === false) await this.options.state?.quarantine(runId)
    await call?.result(result)
    // Structural preflight failures never started a browser. Refund that attempt so the
    // model can fix the request instead of losing its execution budget.
    if (!result.ok && result.buildPhase === 'preflight' && result.execution?.kind === 'completed'
      && result.execution.exitCode === 0 && !result.execution.signal && result.execution.cleanupConfirmed === true && !signal?.aborted) {
      this.builds.set(runId, builds)
    }
    return projected
  }

  /** Read the same serialized ledger that reserves and refunds actual builds. */
  private withBudget(runId: RunId, result: PluginCoreToolResult): PluginCoreToolResult {
    const used = this.builds.get(runId) ?? 0
    const limit = this.options.maxBuildsPerRun ?? DEFAULT_MAX_BUILDS_PER_RUN
    return { ...result, buildBudget: { used, limit, remaining: Math.max(0, limit - used) } }
  }

  /** Forget per-run counters after the run reaches a terminal state. */
  resetRun(runId: RunId): void {
    this.builds.delete(runId)
  }

  private project(toolName: PluginCoreToolName, result: PluginCoreRunResult,
    buildId?: string): PluginCoreToolResult {
    const report = buildReport(result, buildId)
    if (!result.ok) {
      const message = result.error?.message ?? 'The plugin did not produce a delivery.'
      const hint = verificationHint(result.error?.details)
      return { ...this.rejected(toolName, result.error?.code ?? 'plugin_error',
        hint === null ? message : `${message}; ${hint}`, result.error?.details), report }
    }
    return { status: 'accepted', toolName, errors: [], result: result.check ?? null, report }
  }

  private rejected(toolName: PluginCoreToolName, code: string, message: string,
    details?: unknown): PluginCoreToolResult {
    return { status: 'rejected', toolName, result: null,
      errors: [{ code, message, ...(details === undefined ? {} : { details }) }] }
  }
}

/** Project bounded build facts without exposing verification paths or raw reports. */
function buildReport(result: PluginCoreRunResult, buildId?: string): PluginCoreToolReport {
  const check = isRecord(result.check) ? result.check : null
  const scan = scanChecks(result.error?.details)
  return {
    status: result.ok ? 'accepted' : 'rejected',
    ...(buildId === undefined ? {} : { buildId }),
    ...(result.buildPhase === undefined ? {} : { phase: result.buildPhase }),
    verification: check?.verification ?? null,
    failedChecks: scan.failedChecks,
    issueCount: scan.issueCount,
    ...(result.error === undefined ? {} : { error: {
      code: result.error.code, message: result.error.message } }),
  }
}

/** Summarize the first rejected verification checks for model-facing repair. */
function verificationHint(details: unknown): string | null {
  const scan = scanChecks(details, 3)
  const summary = scan.failedChecks
    .map(check => `${check.checkId} ${check.method} ${check.status}${check.reason ? `: ${check.reason}` : ''}`).join('; ')
  return summary.length === 0 ? null : summary.slice(0, 600)
}

interface CheckScan {
  readonly failedChecks: readonly PluginCoreFailedCheck[]
  readonly issueCount: number
}

/** Collect bounded rejected checks and count all failures in one traversal. */
function scanChecks(details: unknown, limit = 12): CheckScan {
  const seen = new Set<string>()
  const failedChecks: PluginCoreFailedCheck[] = []
  let issueCount = 0
  let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || nodes++ > 500 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
    const record = value as Record<string, unknown>
    const requirement = typeof record.requirementId === 'string' ? record.requirementId : null
    const check = typeof record.checkId === 'string' ? record.checkId : null
    const status = typeof record.status === 'string' ? record.status : null
    if (requirement !== null && check !== null && status !== null && status !== 'passed') {
      const method = typeof record.method === 'string' ? record.method : 'check'
      const key = `${check}:${method}:${status}`
      const evidence = isRecord(record.evidence) ? record.evidence : null
      const reason = typeof evidence?.message === 'string' && evidence.message !== '[depth_limit]'
        ? evidence.message.slice(0, 256) : undefined
      if (!seen.has(key)) {
        seen.add(key)
        issueCount += 1
        if (failedChecks.length < limit) {
          failedChecks.push({ requirementId: requirement, checkId: check, method, status,
            ...(reason === undefined ? {} : { reason }) })
        }
      } else if (reason !== undefined) {
        const index = failedChecks.findIndex(item => item.checkId === check && item.method === method && item.status === status)
        const previous = failedChecks[index]
        if (previous && previous.reason === undefined) failedChecks[index] = { ...previous, reason }
      }
    }
    for (const item of Object.values(record)) visit(item, depth + 1)
  }
  visit(details, 0)
  return { failedChecks, issueCount }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
