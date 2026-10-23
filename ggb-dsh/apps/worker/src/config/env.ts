import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentEngineSchema, type AgentEngine } from '@ggb-copilot/application'

/** Everything the worker process needs from the environment; parsed once at boot. */
export interface WorkerEnvConfig {
  workerInstanceId: string
  agentEngine: AgentEngine
  socketPath: string
  channelSecret: string
  databaseUrl: string | null
  /** Local two-process development adapter; production always uses databaseUrl. */
  autoMigrate: boolean
  migrationsDir: string | null
  /** Maximum time to wait for plugin-core cleanup after shutdown begins. */
  drainGraceMs: number
  /** Host workspace holding the release lock; never a DSH source checkout. */
  dshWorkspaceRoot: string
  /** Root for per-run DSH homes; each run gets `<dshHomeRoot>/<runId>`. */
  dshHomeRoot: string
  /** Debug-only trace root; `null` disables tracing and restores DSH-home deletion. */
  dshTraceRoot: string | null
  /** Server-owned provider configuration; the client can never override it (§7.2). */
  provider: 'deepseek-official'
  providerBaseUrl: string
  pluginCoreMaxConcurrentRuns: number
  pluginCoreToolSocket: string
  pluginCoreOutputRoot: string
  pluginCoreRoot: string
  pluginCoreLockPath: string
}

const HEX_64 = /^[a-f0-9]{64}$/

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`)
  }
  return value
}

function optionalString(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]
  return raw === undefined || raw === '' ? null : raw
}

function boolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === '1' || raw === 'true'
}

/** Reads the shared 0600 socket secret injected into both processes (§7.5). */
function readSecret(env: NodeJS.ProcessEnv, name: string): string {
  const file = env[`${name}_FILE`]
  const raw = file !== undefined ? readFileSync(file, 'utf8').trim() : (env[name] ?? '')
  if (!HEX_64.test(raw)) {
    throw new Error(`${name} (or ${name}_FILE) must be 64 lowercase hex characters`)
  }
  return raw
}

export function loadWorkerEnvConfig(env: NodeJS.ProcessEnv = process.env): WorkerEnvConfig {
  const dshWorkspaceRoot = env.GGB_V3_DSH_WORKSPACE_ROOT ?? process.cwd()
  const pluginCoreLockPath = resolve(dshWorkspaceRoot, 'vendor/plugin-core.lock.json')
  const release = JSON.parse(readFileSync(pluginCoreLockPath, 'utf8')) as { archiveSha256: string }
  const socketPath = env.GGB_V3_WORKER_SOCKET_PATH ?? '/tmp/ggb-worker.sock'
  const configuredProviderUrl = env.GGB_V3_PROVIDER_BASE_URL ?? 'https://api.deepseek.com/anthropic'
  // DSH 0.2 uses Messages; migrate only the known legacy official roots.
  const providerBaseUrl = ['https://api.deepseek.com', 'https://api.deepseek.com/',
    'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/'].includes(configuredProviderUrl)
    ? 'https://api.deepseek.com/anthropic' : configuredProviderUrl
  const agentEngine = agentEngineSchema.parse(env.GGB_AGENT_ENGINE ?? 'plugin_core')
  return {
    workerInstanceId: env.GGB_V3_WORKER_INSTANCE_ID ?? `worker-${process.pid}`,
    agentEngine,
    socketPath,
    channelSecret: readSecret(env, 'GGB_V3_WORKER_SECRET'),
    databaseUrl: optionalString(env, 'GGB_V3_DATABASE_URL'),
    autoMigrate: boolEnv(env, 'GGB_V3_AUTO_MIGRATE', false),
    migrationsDir: optionalString(env, 'GGB_V3_MIGRATIONS_DIR'),
    drainGraceMs: intEnv(env, 'GGB_V3_WORKER_DRAIN_MS', 15_000),
    dshWorkspaceRoot,
    dshHomeRoot: env.GGB_V3_DSH_HOME_ROOT ?? '/tmp/ggb-dsh-home',
    // Debug only. When set, every model request and raw answer is written here and the per-run DSH
    // homes are kept instead of deleted in `finally`. Unset restores the shipped behaviour exactly.
    dshTraceRoot: env.GGB_V3_DSH_TRACE_ROOT ?? null,
    provider: 'deepseek-official',
    providerBaseUrl,
    pluginCoreMaxConcurrentRuns: intEnv(env, 'GGB_PLUGIN_CORE_MAX_CONCURRENT_RUNS', 1),
    pluginCoreToolSocket: env.GGB_PLUGIN_CORE_TOOL_SOCKET ?? `${socketPath}.plugin-core`,
    pluginCoreOutputRoot: env.GGB_PLUGIN_CORE_OUTPUT_ROOT
      ?? resolve(dshWorkspaceRoot, '..', 'output', 'plugin-core-runs'),
    pluginCoreRoot: env.GGB_PLUGIN_ROOT ?? resolve(dshWorkspaceRoot, '.plugin-core-runtime', release.archiveSha256),
    pluginCoreLockPath,
  }
}
