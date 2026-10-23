import { readFileSync } from 'node:fs'
import { agentEngineSchema, type AgentEngine } from '@ggb-copilot/application'

/** Everything the API process needs from the environment; parsed once at boot. */
export interface ApiEnvConfig {
  port: number
  listenHost: '0.0.0.0' | '127.0.0.1'
  agentEngine: AgentEngine
  /** Plugin-core runs are single-flight by default. */
  pluginCoreMaxConcurrentRuns: number
  serverPepper: string
  workerSocketPath: string
  workerSecret: string
  dispatchAckTimeoutMs: number
  maxBodyBytes: number
  allowedOrigin: string | null
  allowedHosts: readonly string[]
  /** Built Client PWA shell served by the API; empty disables static serving. */
  clientDistDir: string | null
  /** Provisioned fixed GeoGebra runtime; defaults to `<client-dist>/geogebra`. */
  geogebraRoot: string | null
  /** Pinned release metadata the provisioned runtime is validated against. */
  runtimeVersionsPath: string
  databaseUrl: string | null
  /** Local two-process development adapter; production always uses databaseUrl. */
  sqlitePath: string | null
  autoMigrate: boolean
  migrationsDir: string | null
  retention: {
    activeRunTtlMs: number
    terminalRunTtlMs: number
    artifactTtlMs: number
  }
  ssePollMs: number
  sseHeartbeatMs: number
  /** §15: bounded window that lets in-flight requests finish after admission stops. */
  drainGraceMs: number
  /** §5.1 TTL janitor cadence and per-statement batch bound. */
  janitorIntervalMs: number
  janitorBatchSize: number
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

function csvEnv(env: NodeJS.ProcessEnv, name: string): readonly string[] {
  const raw = optionalString(env, name)
  return raw === null ? [] : raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
}

/** Like `intEnv`, but 0 is meaningful (disable the drain grace window). */
function nonNegativeIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${raw}`)
  }
  return value
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string {
  const file = env[`${name}_FILE`]
  const raw = file !== undefined ? readFileSync(file, 'utf8').trim() : (env[name] ?? '')
  if (!HEX_64.test(raw)) {
    throw new Error(`${name} (or ${name}_FILE) must be 64 lowercase hex characters`)
  }
  return raw
}

function boolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === '1' || raw === 'true'
}

export function loadApiEnvConfig(env: NodeJS.ProcessEnv = process.env): ApiEnvConfig {
  const listenHost = env.GGB_V3_LISTEN_HOST ?? '0.0.0.0'
  if (listenHost !== '0.0.0.0' && listenHost !== '127.0.0.1') {
    throw new Error('GGB_V3_LISTEN_HOST must be 0.0.0.0 or 127.0.0.1')
  }
  return {
    port: intEnv(env, 'PORT', 8080),
    listenHost,
    agentEngine: agentEngineSchema.parse(env.GGB_AGENT_ENGINE ?? 'plugin_core'),
    pluginCoreMaxConcurrentRuns: intEnv(env, 'GGB_PLUGIN_CORE_MAX_CONCURRENT_RUNS', 1),
    serverPepper: readSecret(env, 'GGB_V3_SERVER_PEPPER'),
    workerSocketPath: env.GGB_V3_WORKER_SOCKET_PATH ?? '/tmp/ggb-worker.sock',
    workerSecret: readSecret(env, 'GGB_V3_WORKER_SECRET'),
    dispatchAckTimeoutMs: intEnv(env, 'GGB_V3_DISPATCH_ACK_TIMEOUT_MS', 10_000),
    maxBodyBytes: intEnv(env, 'GGB_V3_MAX_BODY_BYTES', 41_943_040),
    allowedOrigin: optionalString(env, 'GGB_V3_ALLOWED_ORIGIN'),
    allowedHosts: csvEnv(env, 'GGB_V3_ALLOWED_HOSTS'),
    clientDistDir: optionalString(env, 'GGB_V3_CLIENT_DIST_DIR'),
    geogebraRoot: optionalString(env, 'GGB_V3_GEOGEBRA_ROOT'),
    runtimeVersionsPath: env.GGB_V3_RUNTIME_VERSIONS_PATH ?? 'config/runtime-versions.json',
    databaseUrl: optionalString(env, 'GGB_V3_DATABASE_URL'),
    sqlitePath: optionalString(env, 'GGB_V3_SQLITE_PATH'),
    autoMigrate: boolEnv(env, 'GGB_V3_AUTO_MIGRATE', false),
    migrationsDir: optionalString(env, 'GGB_V3_MIGRATIONS_DIR'),
    retention: {
      activeRunTtlMs: intEnv(env, 'GGB_V3_TTL_ACTIVE_RUN_MS', 86_400_000),
      terminalRunTtlMs: intEnv(env, 'GGB_V3_TTL_TERMINAL_RUN_MS', 604_800_000),
      artifactTtlMs: intEnv(env, 'GGB_V3_TTL_ARTIFACT_MS', 2_592_000_000),
    },
    ssePollMs: intEnv(env, 'GGB_V3_SSE_POLL_MS', 1_000),
    sseHeartbeatMs: intEnv(env, 'GGB_V3_SSE_HEARTBEAT_MS', 15_000),
    drainGraceMs: nonNegativeIntEnv(env, 'GGB_V3_DRAIN_GRACE_MS', 15_000),
    janitorIntervalMs: intEnv(env, 'GGB_V3_JANITOR_INTERVAL_MS', 60_000),
    janitorBatchSize: intEnv(env, 'GGB_V3_JANITOR_BATCH_SIZE', 200),
  }
}
