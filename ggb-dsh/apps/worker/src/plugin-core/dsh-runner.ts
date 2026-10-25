import { pluginCoreImageSchema, type PluginCoreImage } from '@ggb-copilot/application'
import type { PluginCoreExecutionState } from './execution-state.js'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, type DeepSeekHarnessOptions, type HarnessNotification, type RunResult, type SdkPromptContentBlock } from '@deepseek-ai/dsh-sdk-client'
import { sdkTurnOutcome, type RunId } from '@ggb-copilot/application'
import type { PluginCoreToolGatewayServer } from './tool-gateway-server.js'
import { PluginCoreEvidenceStore, type TurnEvidence } from './evidence.js'
import { sdkProgress } from './sdk-progress.js'
import { writeHostPolicy } from './host-policy.js'

interface PluginCoreHarnessPort {
  run(prompt: string | SdkPromptContentBlock[], options: { sessionId: string;
    onNotification?: (notification: HarnessNotification) => void }): Promise<RunResult>
  close(): Promise<void>
}

export interface PluginCoreDshRunnerOptions {
  readonly workspaceRoot: string
  readonly dshHomeRoot: string
  readonly provider: string
  readonly baseUrl: string
  readonly modelId: string
  readonly reasoningEffort: NonNullable<DeepSeekHarnessOptions['reasoningEffort']>
  readonly maxTokens: number
  readonly serverPatch: string
  readonly sdkVersion: string
  readonly createHarness?: (options: DeepSeekHarnessOptions) => PluginCoreHarnessPort
  readonly keepDshHome?: boolean
  readonly state?: PluginCoreExecutionState
  readonly evidence?: PluginCoreEvidenceStore
}

export interface PluginCoreTurnRequest {
  readonly runId: RunId
  readonly epoch: number
  readonly providerKey: string
  readonly prompt: string
  readonly image?: PluginCoreImage
  /** Whether this run edits an uploaded base; the model must not inspect a base that is absent. */
  readonly baseAttached: boolean
  readonly turnId?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000

/** Failed turns expose only a bounded accounting subset, never provider text. */
export class PluginCoreTurnError extends Error {
  constructor(code: string, readonly partial: RunResult,
    readonly eventsTruncated: boolean, cause: unknown) {
    super(code, { cause })
    this.name = 'PluginCoreTurnError'
  }
}

/**
 * Run one plugin-core model turn in a fresh DSH Harness session.
 *
 * This path does not use a checkpoint, model gate or multi-stage tool loop.
 * The Harness talks to the provider directly and reaches the Worker only through
 * `ggb_check` / `ggb_build` on the authenticated plugin-core socket.
 */
export class PluginCoreDshRunner {
  private readonly evidence: PluginCoreEvidenceStore
  constructor(private readonly options: PluginCoreDshRunnerOptions,
    private readonly tools: PluginCoreToolGatewayServer) {
    this.evidence = options.evidence ?? new PluginCoreEvidenceStore(options.dshHomeRoot)
  }

  async run(request: PluginCoreTurnRequest): Promise<RunResult> {
    if (request.providerKey.length === 0) throw new Error('plugin_core_provider_key_missing')
    if (request.prompt.length === 0 || request.prompt.length > 100_000) {
      throw new Error('plugin_core_prompt_invalid')
    }
    const image = request.image === undefined ? undefined : pluginCoreImageSchema.parse(request.image)
    const turnId = request.turnId ?? randomUUID()
    const home = join(this.options.dshHomeRoot, request.runId, turnId)
    const toolToken = this.tools.openTurn(request.runId, turnId, request.epoch, request.signal, request.prompt, image !== undefined)
    const evidence = this.evidence.begin(request.runId, turnId, request.epoch,
      [request.providerKey, toolToken, ...(image === undefined ? [] : [image.dataBase64])])
    let harness: PluginCoreHarnessPort | null = null
    let result: RunResult | undefined
    let failure: unknown
    try {
      await evidence.checkpoint('started')
      await mkdir(home, { recursive: true, mode: 0o700 })
      await writeHostPolicy(home)
      await writeFile(join(home, 'stream-evidence.patch.json'), JSON.stringify([{ insert: [{
        id: 'ggb-provider-stream-evidence', name: fileURLToPath(new URL('../../lib/plugin-core/provider-stream-plugin.js', import.meta.url)),
      }] }]), { mode: 0o600 })
      harness = (this.options.createHarness ?? (options => new DeepSeekHarness(options)))(
        this.harnessOptions(request, turnId, home, toolToken, evidence.providerStreamPath))
      const prompt = `${this.systemPromptFor(request.baseAttached, image !== undefined)}\n\nTask:\n${request.prompt}`
      const content: string | SdkPromptContentBlock[] = image === undefined ? prompt
        : [{ type: 'text', text: prompt }, { type: 'image', data: image.dataBase64, mimeType: image.mediaType }]
      result = await this.runBounded(request.runId, harness, content, turnId,
        request.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS, evidence, request.signal)
      evidence.returned(result)
      const outcome = sdkTurnOutcome({ events: result.events ?? [] })
      if (outcome.kind !== 'completed' && outcome.kind !== 'missing') {
        const code = outcome.kind === 'aborted' ? 'plugin_core_cancelled'
          : outcome.kind === 'max-tokens' ? 'plugin_core_max_tokens'
          : outcome.failureCode === 'MALFORMED_RESPONSE' ? 'plugin_core_malformed_response'
          : 'plugin_core_failed'
        throw Object.assign(new Error(code), { code: outcome.failureCode ?? outcome.kind })
      }
    } catch (error) { failure = error }
    const finalError = await this.finish(request.runId, turnId, home, harness, evidence, failure, image === undefined)
    if (finalError instanceof Error && finalError.message === 'plugin_core_cleanup_failed') {
      await this.options.state?.quarantine(request.runId)
    }
    this.evidence.release(turnId)
    if (finalError !== undefined) {
      const code = finalError instanceof Error && finalError.message === 'plugin_core_cleanup_failed'
        ? 'plugin_core_cleanup_failed' : request.signal?.aborted === true ? 'plugin_core_cancelled'
        : finalError instanceof Error && /^plugin_core_[a-z_]+$/u.test(finalError.message)
          ? finalError.message : 'plugin_core_failed'
      throw new PluginCoreTurnError(code, evidence.partial(), evidence.truncated, finalError)
    }
    if (result === undefined) throw new Error('plugin_core_result_missing')
    return result
  }

  private async finish(runId: RunId, turnId: string, home: string, harness: PluginCoreHarnessPort | null,
    evidence: TurnEvidence, failure: unknown, allowRetainedHome: boolean): Promise<unknown> {
    let result = failure
    try { await evidence.checkpoint(failure === undefined ? 'sdk_returned' : 'sdk_failed', failure) }
    catch (error) { result = failure === undefined ? error
      : new AggregateError([failure, error], 'plugin_core_evidence_write_failed') }
    this.tools.closeTurn(turnId)
    let closeError: unknown | null = null
    let closeTimer: NodeJS.Timeout | undefined
    try {
      await Promise.race([harness?.close(), new Promise<never>((_resolve, reject) => {
        closeTimer = setTimeout(() => reject(new Error('plugin_core_cleanup_failed')), 8000)
      })])
    } catch (error) { closeError = error }
    finally { if (closeTimer !== undefined) clearTimeout(closeTimer) }
    try { await this.tools.drainTurn(turnId) } catch (error) { closeError ??= error }
    try { await evidence.cleanup(closeError) } catch (error) {
      result = failure === undefined ? error
        : new AggregateError([failure, error], 'plugin_core_evidence_write_failed')
    }
    if (closeError !== null) result = new Error('plugin_core_cleanup_failed', { cause: result ?? closeError })
    if (this.options.state?.unsafe(runId)) closeError ??= new Error('plugin_core_cleanup_failed')
    if (closeError !== null) result = new Error('plugin_core_cleanup_failed', { cause: result ?? closeError })
    if (closeError === null && (this.options.keepDshHome !== true || !allowRetainedHome)) {
      try { await rm(home, { recursive: true, force: true }) } catch (error) {
        try { await evidence.checkpoint('home_cleanup_failed', error) } catch { /* result remains observable */ }
        result ??= new Error('plugin_core_home_cleanup_failed')
      }
    }
    return result
  }

  private harnessOptions(request: PluginCoreTurnRequest, turnId: string, home: string,
    toolToken: string, streamEvidencePath: string): DeepSeekHarnessOptions {
    const env: NodeJS.ProcessEnv = {}
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const) {
      if (process.env[name] !== undefined) env[name] = process.env[name]
    }
    Object.assign(env, {
      // TMPDIR may be mounted noexec; load native addons from the installed release.
      NARB_DISABLE_NATIVE_CACHE: '1',
      NODE_OPTIONS: '--import=' + new URL('../../lib/plugin-core/provider-stream-preload.js', import.meta.url).href,
      GGB_DSH_TOOL_STREAM_EVIDENCE: streamEvidencePath,
      DEEPSEEK_API_KEY: request.providerKey,
      DEEPSEEK_BASE_URL: this.options.baseUrl,
      GGB_DSH_SDK_VERSION: this.options.sdkVersion,
      GGB_PLUGIN_CORE_TOOL_SOCKET: this.tools.socketPath,
      GGB_PLUGIN_CORE_TOOL_TOKEN: toolToken,
      GGB_PLUGIN_CORE_TOOL_RUN_ID: request.runId,
      GGB_PLUGIN_CORE_TOOL_TURN_ID: turnId,
      GGB_PLUGIN_CORE_TOOL_EPOCH: String(request.epoch),
    })
    return { profile: 'sdk-minimal',
      patches: [this.options.serverPatch, join(home, 'stream-evidence.patch.json'), join(home, 'host-policy.patch.json')],
      processCwd: this.options.workspaceRoot, cwd: this.options.workspaceRoot, dshHome: home,
      provider: this.options.provider, model: this.options.modelId,
      reasoningEffort: this.options.reasoningEffort, maxTokens: this.options.maxTokens,
      initializeTimeoutMs: 15_000, requestTimeoutMs: 10 * 60_000, shutdownTimeoutMs: 3_000, env }
  }

  /** Base inspection needs an attachment; fixed reference topics are always available. */
  private systemPromptFor(baseAttached: boolean, imageAttached: boolean): string {
    const state = baseAttached
      ? 'A base GGB is attached to this run. Call ggb_inspect({}) to inspect it first and use its exact object names.'
      : 'No base GGB is attached to this run. Do not inspect a base with ggb_inspect({}); create a new figure with plan.program. If base inspection reports base_missing, continue with a new figure.'
    const image = imageAttached
      ? 'An image is attached. First transcribe it into complete mathematical problem text (givens, equations, labels, constraints and question). Include it in transcription on the first ggb_request, outside requestText. Preserve ambiguity; do not solve or invent conditions.'
      : 'No image is attached; transcription is optional.'
    return `Host task facts:\n${state}\n${image}\nUse the injected Worker request contract. Choose one adequate construction and submit once its checks are ready. Read references only for a specific unresolved gap; prefer fixed sections when available. Follow the injected submission-readiness rule; do not reread request or compare known alternatives before submitting.`
  }

  private async runBounded(runId: RunId, harness: PluginCoreHarnessPort, prompt: string | SdkPromptContentBlock[], turnId: string,
    timeoutMs: number, evidence: TurnEvidence, signal?: AbortSignal): Promise<RunResult> {
    if (signal?.aborted === true) throw new Error('plugin_core_cancelled')
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('plugin_core_timeout')), timeoutMs)
      if (signal !== undefined) {
        onAbort = () => reject(new Error('plugin_core_cancelled'))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }
    })
    const progress = sdkProgress(turnId, fact => this.options.state?.reportProgress(runId, fact))
    try { return await Promise.race([harness.run(prompt, { sessionId: turnId,
      onNotification: notification => { progress.notification(notification); evidence.notification(notification) } }), stopped]) }
    finally {
      progress.close()
      if (timer !== undefined) clearTimeout(timer)
      if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
}
