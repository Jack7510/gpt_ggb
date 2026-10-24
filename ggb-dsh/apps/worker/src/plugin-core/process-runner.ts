import type { Readable } from 'node:stream'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { PluginCoreProcessScope } from './process-scope.js'
export interface PluginCoreVerificationPhase {
  readonly status: string
  readonly results: number
  readonly passed: number
  readonly failed: number
  readonly unverified: number
}

export interface PluginCoreVerification {
  readonly construction: PluginCoreVerificationPhase
  readonly reload: PluginCoreVerificationPhase
  readonly interaction: { readonly status: string; readonly samples: number }
}

export interface PluginCoreError {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

/** The bounded result of one plugin check or build. */
export interface PluginCoreProcessEvidence {
  readonly cleanupConfirmed?: boolean
  readonly kind: 'completed' | 'timeout' | 'cancelled' | 'output_limit'
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly stderrTail: string
  readonly stdoutTail: string
}

export interface PluginCoreRunResult {
  /** Only an installed, bound executor response can establish this phase. */
  readonly buildPhase?: 'preflight' | 'execution'
  readonly ok: boolean
  readonly check?: unknown
  readonly execution?: PluginCoreProcessEvidence
  readonly error?: PluginCoreError
}

/** The Worker-owned base file. The model never supplies either value. */
export interface PluginCoreBaseInput {
  readonly path: string
  readonly sha256: string
}

/** Bounded result of the plugin's `inspect --ggb` command. */
export interface PluginCoreInspectResult {
  readonly execution?: PluginCoreProcessEvidence
  readonly ok: boolean
  readonly data?: unknown
  readonly error?: PluginCoreError
}

const MAX_STDOUT_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const PLUGIN_ENV = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL',
  'PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME',
  // Windows runtime variables required by Node/Chromium.
  'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
] as const

/** The plugin gets only runtime paths, never Worker secrets or provider keys. */
function pluginEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of PLUGIN_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

type ProcessKind = PluginCoreProcessEvidence['kind']
type PluginChild = ChildProcessByStdio<null, Readable, Readable>
type ProcessResult = { kind: ProcessKind; stdout: string; evidence: PluginCoreProcessEvidence }

/** Capture only bounded stdout and the stderr tail; keep byte counters exact. */
function captureOutput(child: PluginChild, exceeded: () => void) {
  const chunks: Buffer[] = []
  let stderr = Buffer.alloc(0)
  let stdoutBytes = 0
  let stderrBytes = 0
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length
    if (stdoutBytes > MAX_STDOUT_BYTES) exceeded()
    else chunks.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length
    stderr = Buffer.concat([stderr, chunk]).subarray(-MAX_STDERR_BYTES)
  })
  return (kind: ProcessKind, cleanupConfirmed: boolean, exitCode: number | null,
    signal: NodeJS.Signals | null): ProcessResult => {
    const stdout = Buffer.concat(chunks).toString('utf8')
    return { kind, stdout, evidence: { kind, cleanupConfirmed, exitCode, signal,
      stdoutBytes, stderrBytes, stderrTail: stderr.toString('utf8'), stdoutTail: stdout.slice(-4096) } }
  }
}

/** Own escalation timers and cancellation listeners for exactly one process. */
function processControls(child: PluginChild, scope: PluginCoreProcessScope, timeoutMs: number,
  signal: AbortSignal | undefined, onWatchdog: () => void) {
  let kind: ProcessKind = 'completed'
  let force: NodeJS.Timeout | undefined
  let watchdog: NodeJS.Timeout | undefined
  const fence = (): void => { watchdog ??= setTimeout(onWatchdog, 6000) }
  const stop = (reason: ProcessKind): void => {
    if (kind === 'completed') kind = reason
    fence()
    void scope.terminate()
    force ??= setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, 500)
  }
  const onAbort = (): void => stop('cancelled')
  const timer = setTimeout(() => stop('timeout'), timeoutMs)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  return { get kind() { return kind }, fence, stop, cleanup: (): void => {
    clearTimeout(timer)
    if (force !== undefined) clearTimeout(force)
    if (watchdog !== undefined) clearTimeout(watchdog)
    signal?.removeEventListener('abort', onAbort)
  } }
}

/** Bounded process transport; the installed plugin owns every operation. */
export class PluginCoreProcessRunner {
  spawn(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
    if (signal?.aborted === true) return Promise.resolve({ kind: 'cancelled', stdout: '',
      evidence: { kind: 'cancelled', cleanupConfirmed: true, exitCode: null, signal: null,
        stdoutBytes: 0, stderrBytes: 0, stderrTail: '', stdoutTail: '' } })
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: pluginEnvironment(),
      })
      const scope = new PluginCoreProcessScope(child.pid!)
      let finished = false
      let closing: Promise<boolean> | undefined
      const result = captureOutput(child, () => controls.stop('output_limit'))
      const controls = processControls(child, scope, timeoutMs, signal, () => {
        if (finished) return
        finished = true
        controls.cleanup()
        void scope.finish().finally(() => {
          child.stdout.destroy(); child.stderr.destroy()
          resolvePromise(result(controls.kind, false, null, null))
        })
      })
      child.once('error', error => { controls.cleanup(); void scope.finish().finally(() => reject(error)) })
      child.once('exit', () => { controls.fence(); closing = scope.finish() })
      child.once('close', async (code, exitSignal) => {
        if (finished) return
        finished = true
        controls.cleanup()
        const cleanupConfirmed = await (closing ?? scope.finish())
        resolvePromise(result(controls.kind, cleanupConfirmed, code, exitSignal))
      })
    })
  }
}

export function summarizeVerification(value: unknown): PluginCoreVerification {
  const report = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const phase = (input: unknown): PluginCoreVerificationPhase => {
    const record = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
    const results = Array.isArray(record.results) ? record.results : []
    return { status: typeof record.status === 'string' ? record.status : 'unknown',
      results: results.length,
      passed: results.filter(item => statusOf(item) === 'passed').length,
      failed: results.filter(item => statusOf(item) === 'failed').length,
      unverified: results.filter(item => statusOf(item) === 'unverified').length }
  }
  const interaction = report.interaction !== null && typeof report.interaction === 'object'
    ? report.interaction as Record<string, unknown> : {}
  return { construction: phase(report.construction), reload: phase(report.reload),
    interaction: { status: Array.isArray(interaction.samples) && interaction.samples.length === 0
      && interaction.status === 'passed' ? 'not_sampled'
      : typeof interaction.status === 'string' ? interaction.status : 'unknown',
      samples: Array.isArray(interaction.samples) ? interaction.samples.length : 0 } }
}

function statusOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const status = (value as Record<string, unknown>).status
  return typeof status === 'string' ? status : null
}
