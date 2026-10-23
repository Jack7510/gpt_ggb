import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { channelPluginCoreDeliverySchema, PLUGIN_CORE_LIMITS, toolArgumentsDigest, type PluginCoreBuildBinding, type RunId,
  type ChannelPluginCoreDelivery, type PluginCoreTrustedBuild } from '@ggb-copilot/application'
import { PluginCoreProcessRunner, type PluginCoreBaseInput, type PluginCoreInspectResult, type PluginCoreRunResult } from './process-runner.js'
import type { PluginCoreToolRequest } from './gateway.js'
import type { PluginCoreExecutionState } from './execution-state.js'
import { createConstructionRecord } from './construction-record.js'
import { buildFailure } from './failure-details.js'

interface ReceiptArtifact { kind: 'result_ggb' | 'verification' | 'manifest' | 'preview';
  ref: string; bytes: number; sha256: string; contentType: string }
interface Receipt { status: string; verification: { reportSha256: string; reportBytes: number; summary: ChannelPluginCoreDelivery['verification'] };
  artifacts: ReceiptArtifact[]; issues: unknown }
type Operation = 'check' | 'inspect' | 'build'
interface OperationResult {
  protocolVersion: 3; operation: Operation; contextSha256: string; packageIntegrity: string
  phase: 'preflight' | 'execution'; ok: boolean; data: unknown; receipt: Receipt | null
  error: { code: string; message: string; details?: unknown } | null
}
interface InstalledContracts {
  parseExecutionResult(input: unknown): OperationResult
  summarizeHostVerification(input: unknown): unknown
  projectInspect(input: unknown): unknown
  validateHostMaterial(manifest: unknown, facts: { file: string; runtimeVersion: string; sha256: string }): void
  parseBuildReceipt(input: unknown): Receipt
  validateHostDelivery(request: unknown, report: unknown, manifest: unknown): void
  loadReference(topic: string): unknown
}
export interface InstalledRunnerOptions {
  pluginRoot: string
  outputRoot: string
  /** SHA-256 of the exact installed distribution, fixed by installation admission. */
  packageIntegrity: string
  state: PluginCoreExecutionState
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Installed execution path, shared by development and deployment composition. */
export class InstalledPluginCoreRunner {
  private constructor(private readonly options: InstalledRunnerOptions,
    private readonly transport: PluginCoreProcessRunner,
    private readonly executor: string, private readonly contracts: InstalledContracts,
    private readonly identity: Pick<PluginCoreBuildBinding,
      'pluginName' | 'pluginVersion' | 'runtimeIdentity' | 'packageIntegrity'>) {}

  static async load(options: InstalledRunnerOptions): Promise<InstalledPluginCoreRunner> {
    if (!/^[a-f0-9]{64}$/u.test(options.packageIntegrity)) throw new Error('plugin_core_installation_integrity_missing')
    const req = createRequire(join(resolve(options.pluginRoot), 'package.json'))
    const load = async (name: string) => await import(pathToFileURL(req.resolve(`ggb-plugins-dsh/${name}`)).href)
    const [schemas, gates, installation, execution] = await Promise.all([load('schemas'), load('delivery-contract'), load('installation'), load('execution-schemas')])
    if (execution.EXECUTOR_PROTOCOL_VERSION !== 3) throw new Error('plugin_core_executor_version_mismatch')
    for (const key of ['ggbBytes', 'previewBytes', 'reportBytes', 'manifestBytes'] as const) {
      if (schemas.LIMITS[key] !== PLUGIN_CORE_LIMITS[key]) throw new Error('plugin_core_artifact_limits_mismatch')
    }
    const identity = installation.loadInstallation()
    const transport = new PluginCoreProcessRunner()
    return new InstalledPluginCoreRunner(options, transport,
      req.resolve('ggb-plugins-dsh/executor'), { parseBuildReceipt: schemas.parseBuildReceipt,
        summarizeHostVerification: gates.summarizeHostVerification,
        validateHostDelivery: gates.validateHostDelivery, validateHostMaterial: gates.validateHostMaterial,
        parseExecutionResult: execution.parseExecutionResult, projectInspect: execution.projectInspect,
        loadReference: installation.loadReference }, { pluginName: identity.pluginName,
        pluginVersion: identity.pluginVersion, runtimeIdentity: identity.runtimeIdentity,
        packageIntegrity: options.packageIntegrity })
  }

  async check(request: unknown, runId: RunId, signal?: AbortSignal,
    base?: PluginCoreBaseInput, call?: PluginCoreToolRequest): Promise<PluginCoreRunResult> {
    const invocation = await this.invoke('check', request, runId, signal, base, call)
    if (!invocation.result) return { ok: false, execution: invocation.outcome.evidence,
      error: { code: 'plugin_check_execution_failed', message: 'Check execution did not complete safely.' } }
    const result = invocation.result
    return { ok: result.ok, check: result.ok ? result.data : undefined,
      execution: invocation.outcome.evidence, ...(result.error ? { error: result.error } : {}) }
  }

  async inspect(base: PluginCoreBaseInput, runId: RunId, signal?: AbortSignal,
    call?: PluginCoreToolRequest): Promise<PluginCoreInspectResult> {
    const invocation = await this.invoke('inspect', {}, runId, signal, base, call)
    if (!invocation.result) return { ok: false, execution: invocation.outcome.evidence,
      error: { code: 'plugin_inspect_execution_failed', message: 'Inspect execution did not complete safely.' } }
    const result = invocation.result
    if (result.ok && (result.data as { sha256: string }).sha256 !== base.sha256) {
      throw new Error('plugin_core_inspect_base_mismatch')
    }
    return { ok: result.ok, data: result.ok ? this.contracts.projectInspect(result.data) : undefined,
      execution: invocation.outcome.evidence, ...(result.error ? { error: result.error } : {}) }
  }

  async reference(topic: string): Promise<unknown> {
    return this.contracts.loadReference(topic)
  }

  /** buildId and authenticated identities are mandatory in installed mode. */
  async build(request: unknown, runId: RunId, signal?: AbortSignal,
    base?: PluginCoreBaseInput, call?: PluginCoreToolRequest & { buildId: string }): Promise<PluginCoreRunResult> {
    if (!call?.requestId || !call.toolCallId || call.protocolVersion !== 3) throw new Error('plugin_core_build_identity_missing')
    this.options.state.invalidate(runId)
    const { root, binding, outcome, result } = await this.invoke('build', request, runId, signal, base, call)
    if (base && digest(await readFile(base.path)) !== base.sha256) throw new Error('plugin_core_base_changed')
    if (!result) {
      const error = { code: 'plugin_build_execution_failed', message: 'Build process did not complete safely.' }
      return { ok: false, execution: outcome.evidence,
        error: outcome.kind === 'completed' && outcome.evidence.cleanupConfirmed && !outcome.evidence.signal && !signal?.aborted
          ? await buildFailure(root, error, outcome.evidence.stderrTail) : error }
    }
    const receipt = this.contracts.parseBuildReceipt(result.receipt)
    for (const [key, value] of Object.entries(binding)) {
      if (toolArgumentsDigest((receipt as unknown as Record<string, unknown>)[key]) !== toolArgumentsDigest(value)) {
        throw new Error('plugin_core_receipt_binding_mismatch')
      }
    }
    if (!result.ok) return { ok: false, execution: outcome.evidence, buildPhase: result.phase,
      error: await buildFailure(root, result.error!, outcome.evidence.stderrTail, receipt.issues) }
    const delivery = await this.accept(root, request, receipt, binding, base, signal)
    this.options.state.accept(runId, delivery)
    return { ok: true, check: { delivery: { id: delivery.id }, verification: delivery.verification }, execution: outcome.evidence }
  }

  /** One host-owned context and one public executor response for every operation. */
  private async invoke(operation: Operation, request: unknown, runId: RunId, signal?: AbortSignal,
    base?: PluginCoreBaseInput, call?: PluginCoreToolRequest & { buildId?: string }) {
    const buildId = call?.buildId ?? randomUUID()
    const root = await this.directory(runId, buildId)
    const binding: PluginCoreBuildBinding = { runId, turnId: call?.turnId ?? randomUUID(), epoch: call?.epoch ?? 1,
      requestId: call?.requestId ?? randomUUID(), toolCallId: call?.toolCallId ?? randomUUID(), buildId,
      domainRequestDigest: toolArgumentsDigest(request), baseSha256: base?.sha256 ?? null, ...this.identity }
    const context = { protocolVersion: 2, ...binding, baseRef: base?.path ?? null,
      outputRoot: root, deadline: new Date(Math.min(this.options.state.deadline(runId),
        Date.now() + (operation === 'build' ? 150_000 : 45_000))).toISOString() }
    for (const key of ['pluginName', 'pluginVersion', 'runtimeIdentity', 'packageIntegrity']) delete (context as Record<string, unknown>)[key]
    await Promise.all([writeFile(join(root, 'request.json'), JSON.stringify(request), { mode: 0o600 }),
      writeFile(join(root, 'context.json'), JSON.stringify(context), { mode: 0o600 })])
    const outcome = await this.transport.spawn([this.executor, '--operation', operation, '--request', join(root, 'request.json'),
      '--context', join(root, 'context.json'), '--package-integrity', this.options.packageIntegrity], operation === 'build' ? 155_000 : 50_000, signal)
    if (!outcome.evidence.cleanupConfirmed) await this.options.state.quarantine(runId)
    let result: OperationResult | null = null
    if (outcome.kind === 'completed' && outcome.evidence.exitCode === 0 && !outcome.evidence.signal
      && outcome.evidence.cleanupConfirmed && !signal?.aborted) {
      result = this.contracts.parseExecutionResult(JSON.parse(outcome.stdout))
      if (result.operation !== operation || result.contextSha256 !== toolArgumentsDigest(context)
        || result.packageIntegrity !== this.options.packageIntegrity) throw new Error('plugin_core_execution_binding_mismatch')
    }
    return { root, binding, outcome, result }
  }

  private async directory(runId: RunId, buildId: string): Promise<string> {
    const parent = join(resolve(this.options.outputRoot), runId, 'builds')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const root = join(parent, buildId)
    await mkdir(root, { mode: 0o700 }) // no reuse of an existing build
    return await realpath(root)
  }

  private async accept(root: string, request: unknown, receipt: Receipt,
    binding: PluginCoreBuildBinding, base?: PluginCoreBaseInput, signal?: AbortSignal): Promise<ChannelPluginCoreDelivery> {
    const bytes = new Map<string, Buffer>()
    for (const artifact of receipt.artifacts) {
      bytes.set(artifact.kind, await readArtifact(root, artifact))
    }
    const report = JSON.parse(bytes.get('verification')!.toString('utf8'))
    const manifest = JSON.parse(bytes.get('manifest')!.toString('utf8'))
    const domain = { ...(request as object), outputDir: root,
      ...(binding.baseSha256 ? { base: { path: base!.path, sha256: binding.baseSha256 } } : {}) }
    this.contracts.validateHostDelivery(domain, report, manifest)
    this.contracts.validateHostMaterial(manifest, {
      file: basename(receipt.artifacts.find(a => a.kind === 'result_ggb')!.ref),
      runtimeVersion: (binding.runtimeIdentity as { geogebraVersion: string }).geogebraVersion,
      sha256: digest(bytes.get('result_ggb')!),
    })
    if (digest(bytes.get('verification')!) !== receipt.verification.reportSha256
      || bytes.get('verification')!.length !== receipt.verification.reportBytes) throw new Error('plugin_core_report_mismatch')
    if (toolArgumentsDigest(this.contracts.summarizeHostVerification(report))
      !== toolArgumentsDigest(receipt.verification.summary)) throw new Error('plugin_core_report_summary_mismatch')
    signal?.throwIfAborted()
    const trustedBuild: PluginCoreTrustedBuild = { binding,
      receipt: receipt as unknown as PluginCoreTrustedBuild['receipt'], receiptSha256: toolArgumentsDigest(receipt) }
    if (base && digest(await readFile(base.path)) !== base.sha256) throw new Error('plugin_core_base_changed')
    signal?.throwIfAborted()
    const ggb = bytes.get('result_ggb')!
    const construction = createConstructionRecord(request, binding, report)
    return channelPluginCoreDeliverySchema.parse({ id: digest(ggb), ggbBase64: ggb.toString('base64'), ggbBytes: ggb.length,
      screenshotBase64: bytes.get('preview')?.toString('base64') ?? null,
      verification: receipt.verification.summary, trustedBuild,
      ...(construction === null ? {} : { construction }),
      reportBase64: bytes.get('verification')!.toString('base64'),
      manifestBase64: bytes.get('manifest')!.toString('base64') })
  }
}

/** Reject links, traversal and oversized files before reading; retain checked bytes. */
async function readArtifact(root: string, artifact: ReceiptArtifact): Promise<Buffer> {
  const path = resolve(await realpath(root), artifact.ref)
  const rel = relative(await realpath(root), await realpath(path))
  if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(path) !== await realpath(path)) {
    throw new Error('plugin_core_artifact_escape')
  }
  const limit = artifact.kind === 'result_ggb' ? PLUGIN_CORE_LIMITS.ggbBytes
    : artifact.kind === 'preview' ? PLUGIN_CORE_LIMITS.previewBytes : PLUGIN_CORE_LIMITS.reportBytes
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit || stat.size !== artifact.bytes) throw new Error('plugin_core_artifact_size')
    const bytes = Buffer.alloc(stat.size + 1)
    let read = 0
    while (read < bytes.length) {
      const part = await file.read(bytes, read, bytes.length - read, read)
      if (part.bytesRead === 0) break
      read += part.bytesRead
    }
    if (read !== artifact.bytes || digest(bytes.subarray(0, read)) !== artifact.sha256) throw new Error('plugin_core_artifact_digest')
    return bytes.subarray(0, read)
  } finally { await file.close() }
}
