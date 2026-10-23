import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { DeepSeekHarnessOptions, RunResult } from '@deepseek-ai/dsh-sdk-client'
import { MemoryPluginCoreStore } from '@ggb-copilot/run-persistence'
import { runIdSchema } from '@ggb-copilot/application'
import { composeWorker } from '../src/composition.js'
import { loadWorkerEnvConfig } from '../src/config/env.js'
import { WorkerDispatchClient } from '../../api/src/worker-dispatch/dispatch-client.js'
import { PluginCoreRunService } from '../../api/src/plugin-core/run-service.js'

const pluginRoot = process.env.GGB_PLUGIN_TEST_ROOT
const release = JSON.parse(await readFile(resolve('vendor/plugin-core.lock.json'), 'utf8'))
const secret = 'a'.repeat(64)
describe('default installed composition', () => {
  it('selects the lock hash installation and exposes no legacy runner option', () => {
    const env = loadWorkerEnvConfig({ GGB_V3_WORKER_SECRET: secret })
    expect(env.pluginCoreRoot).toBe(resolve('.plugin-core-runtime', release.archiveSha256))
    expect(env).not.toHaveProperty('pluginCoreRunnerPath')
  })

  it.skipIf(!pluginRoot)('routes API receipt-v1 through channel 4, installed SDK patch and a real plugin preflight (SDK mocked)', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'default-installed-chain-'))
    const require = createRequire(join(pluginRoot!, 'package.json'))
    const { createTool } = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/server')).href)
    const request = JSON.parse(await readFile(new URL('./fixtures/verified-build.json', import.meta.url), 'utf8')).request
    let captured: DeepSeekHarnessOptions | undefined
    let toolStatus: unknown
    const verifyResources = vi.fn(async () => undefined) // no runtime/doctor claim
    const worker = await composeWorker({ GGB_V3_WORKER_SECRET: secret, GGB_PLUGIN_ROOT: pluginRoot,
      GGB_V3_WORKER_SOCKET_PATH: join(temp, 'worker.sock'), GGB_PLUGIN_CORE_TOOL_SOCKET: join(temp, 'tool.sock'),
      GGB_PLUGIN_CORE_OUTPUT_ROOT: join(temp, 'runs'), GGB_V3_DSH_HOME_ROOT: join(temp, 'homes'),
      GGB_V3_PROVIDER_BASE_URL: 'http://127.0.0.1:1' }, {
      verifyResources,
      createHarness: options => {
        captured = options
        return { close: async () => undefined, run: async () => {
          for (const [key, value] of Object.entries(options.env ?? {})) {
            if (key.startsWith('GGB_PLUGIN_CORE_TOOL_')) vi.stubEnv(key, value!)
          }
          try { toolStatus = await createTool('ggb_check').execute({ request }, { signal: new AbortController().signal }) }
          finally { vi.unstubAllEnvs() }
          return { finalResponse: 'mocked SDK completed; check only', events: [{ type: 'turn/end',
            data: { reason: { kind: 'completed' } } }] } as unknown as RunResult
        } }
      },
    })
    const client = new WorkerDispatchClient(worker.config.socketPath, secret, 2000)
    const store = new MemoryPluginCoreStore()
    const api = new PluginCoreRunService(store, client, { engine: 'plugin_core', serverPepper: secret,
      maxConcurrentRuns: 1, activeRunTtlMs: 60_000, terminalRunTtlMs: 60_000 })
    try {
      await worker.start()
      const runId = runIdSchema.parse(`run_${randomUUID()}`)
      await api.createRun({ runId, runToken: 'test-token', idempotencyKey: runId,
        providerKey: 'fake-provider-key', prompt: 'offline fixture', base: null, requestDigest: 'b'.repeat(64) })
      for (let n = 0; n < 200 && (await store.getRun(runId))?.phase !== 'failed'; n++) await new Promise(r => setTimeout(r, 20))
      expect((await store.getRun(runId))?.phase).toBe('failed') // a check cannot deliver
      expect((await store.getRun(runId))?.deliveryContract).toBe('receipt-v1')
      expect(toolStatus).toMatchObject({ status: 'accepted' })
      expect(captured?.patches).toEqual([require.resolve('ggb-plugins-dsh/server.patch.yml'), expect.stringContaining('stream-evidence.patch.json'), expect.stringContaining('host-policy.patch.json')])
      expect(captured?.reasoningEffort).toBe('high')
      expect(captured?.env?.GGB_DSH_SDK_VERSION).toBe('0.2.1-rc.2')
      expect(verifyResources).toHaveBeenCalledOnce()
    } finally { client.close(); await worker.dispose(); await rm(temp, { recursive: true, force: true }) }
  }, 15_000)
})
