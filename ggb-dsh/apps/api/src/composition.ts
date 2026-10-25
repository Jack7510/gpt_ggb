import {
  MemoryPluginCoreStore, PgPluginCoreStore, SqlitePluginCoreStore,
  assertPluginCoreSchema, createPgPool, runMigrations, type PoolType,
} from '@ggb-copilot/run-persistence'
import { createMetrics, renderMetrics, type Metrics } from '@ggb-copilot/application'
import { loadApiEnvConfig, type ApiEnvConfig } from './config/env.js'
import { createStaticAssets } from './http/static-assets.js'
import { startApiServer, type RunningApiServer } from './http/http-server.js'
import { createLegacyNativeRunGuard } from './legacy/native-run-probe.js'
import { createApiHandler } from './routes/v3.js'
import { WorkerDispatchClient } from './worker-dispatch/dispatch-client.js'
import { PluginCoreRunService } from './plugin-core/run-service.js'

export interface ApiComposition {
  config: ApiEnvConfig
  /** §15: this process's metrics registry; no per-run label ever enters it. */
  metrics: Metrics
  /** §15: stops admission before the process drains and the workers are released. */
  beginDrain(): void
  start(): Promise<RunningApiServer>
  dispose(): Promise<void>
}

/**
 * Wires env → plugin-core store → channel → service → routes. Tests inject a
 * fake store/channel by constructing PluginCoreRunService directly.
 */
export function composeApi(env: NodeJS.ProcessEnv = process.env): ApiComposition {
  const config = loadApiEnvConfig(env)
  const pool: PoolType | null = config.databaseUrl !== null
    ? createPgPool(config.databaseUrl) : null
  let pluginSqlite: SqlitePluginCoreStore | null = null
  const pluginStore = pool !== null ? new PgPluginCoreStore(pool)
    : config.sqlitePath !== null
      ? (pluginSqlite = new SqlitePluginCoreStore(config.sqlitePath))
      : new MemoryPluginCoreStore()
  const workerChannel = new WorkerDispatchClient(
    config.workerSocketPath,
    config.workerSecret,
    config.dispatchAckTimeoutMs,
  )
  const pluginCoreService = new PluginCoreRunService(pluginStore, workerChannel, {
    engine: config.agentEngine,
    serverPepper: config.serverPepper,
    maxConcurrentRuns: config.pluginCoreMaxConcurrentRuns,
    activeRunTtlMs: config.retention.activeRunTtlMs,
    terminalRunTtlMs: config.retention.terminalRunTtlMs,
  })
  const metrics = createMetrics()
  const legacyNativeRuns = createLegacyNativeRunGuard({
    pool,
    sqlitePath: config.sqlitePath,
    serverPepper: config.serverPepper,
  })
  const handler = createApiHandler({
    sse: { pollMs: config.ssePollMs, heartbeatMs: config.sseHeartbeatMs },
    metrics,
    pluginCore: pluginCoreService,
    legacyNativeRuns,
    agentEngine: config.agentEngine,
    checkWorkerReady: () => workerChannel.probe(),
  })
  // Validated before listening: an incomplete or mismatched GeoGebra runtime fails boot
  // instead of serving a partial applet (§10 static service, §11 fixed runtime).
  const staticAssets = createStaticAssets({
    clientDistDir: config.clientDistDir,
    geogebraRoot: config.geogebraRoot,
    runtimeVersionsPath: config.runtimeVersionsPath,
  })
  let pluginJanitor: NodeJS.Timeout | null = null

  return {
    config,
    metrics,
    beginDrain(): void {
      pluginCoreService.beginDrain()
    },
    async start(): Promise<RunningApiServer> {
      if (pool !== null && config.autoMigrate && config.migrationsDir !== null) {
        const applied = await runMigrations(pool, config.migrationsDir)
        if (applied.length > 0) console.log(`[api] applied migrations: ${applied.join(', ')}`)
      }
      if (pool !== null) await assertPluginCoreSchema(pool)
      await pluginCoreService.sweepExpired()
      pluginJanitor = setInterval(() => {
        void pluginCoreService.sweepExpired().catch((error: unknown) => {
          console.error('[api] plugin-core sweep failed', error)
        })
      }, config.janitorIntervalMs)
      pluginJanitor.unref()
      return await startApiServer({
        port: config.port,
        listenHost: config.listenHost,
        maxBodyBytes: config.maxBodyBytes,
        allowedOrigin: config.allowedOrigin,
        allowedHosts: config.allowedHosts,
        handler,
        ...(staticAssets === null ? {} : { staticAssets }),
      })
    },
    async dispose(): Promise<void> {
      if (pluginJanitor !== null) clearInterval(pluginJanitor)
      pluginCoreService.stopAll()
      await pluginCoreService.waitForSettlements(config.drainGraceMs)
      // §15: one last structured line so the counters survive a scale-down.
      const samples = metrics.snapshot()
      if (samples.length > 0) console.log(`[api] metrics ${renderMetrics(samples)}`)
      workerChannel.close()
      if (!await pluginCoreService.waitForSettlements(2000)) throw new Error('plugin_core_settlement_pending')
      if (pool !== null) await pool.end()
      pluginSqlite?.close()
    },
  }
}
