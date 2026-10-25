import { sweepRunFiles } from './plugin-core/retention.js'
import { assertProcessScopeSupported } from './plugin-core/process-scope.js'
import { PluginCoreExecutionState } from './plugin-core/execution-state.js'
import {
  assertPluginCoreSchema,
  createPgPool,
  runMigrations,
  type PoolType,
} from '@ggb-copilot/run-persistence'
import { PLUGIN_CORE_MODEL_POLICY_V1 } from '@ggb-copilot/application'
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import { loadWorkerEnvConfig, type WorkerEnvConfig } from './config/env.js'
import { InternalChannelServer } from './internal-channel/channel-server.js'
import { PluginCoreBaseRegistry } from './plugin-core/base-registry.js'
import { PluginCoreDshRunner } from './plugin-core/dsh-runner.js'
import { PluginCoreGateway } from './plugin-core/gateway.js'
import { InstalledPluginCoreRunner } from './plugin-core/installed-runner.js'
import { PluginCoreService } from './plugin-core/service.js'
import { loadInstalledPlugin, type InstalledPlugin } from './plugin-core/installation.js'
import { loadInstalledToolProtocol } from './plugin-core/tool-protocol.js'
import type { PluginCoreDshRunnerOptions } from './plugin-core/dsh-runner.js'
import { PluginCoreToolGatewayServer } from './plugin-core/tool-gateway-server.js'
import { assertPluginCoreRuntime } from './plugin-core/preflight.js'
import { PluginCoreEvidenceStore } from './plugin-core/evidence.js'

/**
 * Largest accepted internal-channel frame. A create normally carries identifiers
 * and a prompt; the bound stays generous enough for bounded base metadata.
 */
const MAX_CHANNEL_MESSAGE_BYTES = 16_777_216

export interface WorkerComposition {
  config: WorkerEnvConfig
  pluginIdentity: Pick<InstalledPlugin, 'packageIntegrity' | 'workerSkillSha256'>
  start(): Promise<void>
  dispose(): Promise<void>
}

/** Wire the plugin-core runner, tool gateway, DSH turn and authenticated dispatch channel. */
export async function composeWorker(env: NodeJS.ProcessEnv = process.env, dependencies: {
  createHarness?: PluginCoreDshRunnerOptions['createHarness']
  verifyResources?: (plugin: InstalledPlugin, outputRoot: string) => Promise<void>
} = {}): Promise<WorkerComposition> {
  const config = loadWorkerEnvConfig(env)
  const plugin = await loadInstalledPlugin(config.pluginCoreRoot, config.pluginCoreLockPath)
  const pool: PoolType | null = config.databaseUrl !== null ? createPgPool(config.databaseUrl) : null
  const state = new PluginCoreExecutionState(config.pluginCoreOutputRoot)
  const bases = new PluginCoreBaseRegistry()
  const evidence = new PluginCoreEvidenceStore(config.pluginCoreOutputRoot)
  const runner = await InstalledPluginCoreRunner.load({ outputRoot: config.pluginCoreOutputRoot,
    pluginRoot: plugin.root, packageIntegrity: plugin.packageIntegrity, state })
  const protocol = await loadInstalledToolProtocol(plugin.root)
  const gateway = new PluginCoreGateway(runner, { bases, evidence, state })
  const toolGatewayServer = new PluginCoreToolGatewayServer(config.pluginCoreToolSocket, gateway, 160_000, { evidence, protocol })
  const dsh = new PluginCoreDshRunner({
    workspaceRoot: config.dshWorkspaceRoot,
    dshHomeRoot: config.dshHomeRoot,
    provider: config.provider,
    baseUrl: config.providerBaseUrl,
    modelId: PLUGIN_CORE_MODEL_POLICY_V1.model,
    reasoningEffort: PLUGIN_CORE_MODEL_POLICY_V1.reasoning as NonNullable<DeepSeekHarnessOptions['reasoningEffort']>,
    maxTokens: PLUGIN_CORE_MODEL_POLICY_V1.maxTokens,
    serverPatch: plugin.serverPatch,
    sdkVersion: plugin.sdkVersion,
    ...(dependencies.createHarness ? { createHarness: dependencies.createHarness } : {}),
    keepDshHome: config.dshTraceRoot !== null,
    evidence, state,
  }, toolGatewayServer)
  const service = new PluginCoreService(dsh, {
    outputRoot: config.pluginCoreOutputRoot,
    bases, state, resetRun: runId => gateway.resetRun(runId),
    modelId: PLUGIN_CORE_MODEL_POLICY_V1.model,
    runDeadlineMs: 10 * 60_000,
    maxConcurrentRuns: config.pluginCoreMaxConcurrentRuns,
    // Re-run one malformed provider turn only when no build has executed.
    retryMalformedResponse: true,
  })

  let draining = false
  const verifyResources = dependencies.verifyResources ?? assertPluginCoreRuntime
  const channel = new InternalChannelServer(
    {
      socketPath: config.socketPath,
      secret: config.channelSecret,
      workerInstanceId: config.workerInstanceId,
      maxMessageBytes: MAX_CHANNEL_MESSAGE_BYTES,
    },
    {
      ready: async () => {
        if (draining) throw new Error('worker_draining')
        await verifyResources(plugin, config.pluginCoreOutputRoot)
        if (pool !== null) await assertPluginCoreSchema(pool)
        if (draining) throw new Error('worker_draining')
      },
      pluginCore: async (request, onProgress) => await service.run({
        runId: request.runId,
        deliveryContract: request.deliveryContract,
        providerKey: request.credential.providerKey ?? '',
        prompt: request.prompt,
        ...(request.image === undefined ? {} : { image: request.image }),
        base: request.base ?? null,
      }, onProgress),
      cancelPluginCore: async (request) => service.cancel(request.runId) === 'cancelled'
        ? 'cancelled' : 'not_found',
    },
  )

  let retentionTimer: NodeJS.Timeout | undefined
  return {
    config,
    pluginIdentity: { packageIntegrity: plugin.packageIntegrity, workerSkillSha256: plugin.workerSkillSha256 },
    async start(): Promise<void> {
      await assertProcessScopeSupported()
      await state.fenceOrphans()
      await sweepRunFiles(config.pluginCoreOutputRoot, service.activeRunIds())
      await verifyResources(plugin, config.pluginCoreOutputRoot)
      if (pool !== null && config.autoMigrate && config.migrationsDir !== null) {
        const applied = await runMigrations(pool, config.migrationsDir)
        if (applied.length > 0) console.log(`[worker] applied migrations: ${applied.join(', ')}`)
      }
      if (pool !== null) await assertPluginCoreSchema(pool)
      await toolGatewayServer.listen()
      try {
        await channel.listen()
        retentionTimer = setInterval(() => {
          void sweepRunFiles(config.pluginCoreOutputRoot, service.activeRunIds()).catch(error => {
            console.error('[worker] retention failed', error instanceof Error ? error.name : 'unknown')
          })
        }, 60 * 60_000)
        retentionTimer.unref()
      } catch (error) {
        await toolGatewayServer.close()
        throw error
      }
    },
    async dispose(): Promise<void> {
      draining = true
      if (retentionTimer) clearInterval(retentionTimer)
      await service.stopAll(config.drainGraceMs)
      await channel.close()
      await toolGatewayServer.close()
      if (pool !== null) await pool.end()
    },
  }
}
