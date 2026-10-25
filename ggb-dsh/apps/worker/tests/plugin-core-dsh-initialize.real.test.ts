import { afterEach, expect, it } from 'vitest'
import { DeepSeekHarness, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import { PLUGIN_CORE_MODEL_POLICY_V1, runIdSchema } from '@ggb-copilot/application'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginCoreDshRunner } from '../src/plugin-core/dsh-runner.js'
import { loadInstalledPlugin } from '../src/plugin-core/installation.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

// Opt in under the deployment's systemd filesystem restrictions. No prompt is sent.
it.skipIf(process.env.GGB_DSH_INITIALIZE_SMOKE !== '1')('initializes and closes the installed DSH without calling a Provider', async () => {
  const workspace = process.cwd()
  const lockPath = join(workspace, 'vendor/plugin-core.lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { archiveSha256: string }
  const plugin = await loadInstalledPlugin(process.env.GGB_PLUGIN_ROOT
    ?? join(workspace, '.plugin-core-runtime', lock.archiveSha256), lockPath)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-initialize-')); dirs.push(dir)
  let initialized = false
  let closed = false
  const subject = new PluginCoreDshRunner({ workspaceRoot: workspace, dshHomeRoot: join(dir, 'homes'),
    provider: 'deepseek-official', baseUrl: 'http://127.0.0.1:9', modelId: PLUGIN_CORE_MODEL_POLICY_V1.model,
    reasoningEffort: PLUGIN_CORE_MODEL_POLICY_V1.reasoning,
    maxTokens: PLUGIN_CORE_MODEL_POLICY_V1.maxTokens, serverPatch: plugin.serverPatch, sdkVersion: plugin.sdkVersion,
    createHarness: options => {
      expect(options.env?.NARB_DISABLE_NATIVE_CACHE).toBe('1')
      const harness = new DeepSeekHarness(options)
      return {
        run: async (_prompt, request) => {
          await harness.start()
          initialized = true
          return { sessionId: request.sessionId, finalResponse: '', events: [], notifications: [] } as RunResult
        },
        close: async () => { await harness.close(); closed = true },
      }
    },
  }, { openTurn: () => 'offline-tool-token', closeTurn: () => {}, drainTurn: async () => {},
    socketPath: join(dir, 'unused.sock') } as never)
  await subject.run({ runId: runIdSchema.parse('run_00000000-0000-4000-8000-000000000099'),
    epoch: 1, providerKey: 'offline-no-provider', prompt: 'Not sent to DSH', baseAttached: false })
  expect(initialized).toBe(true)
  expect(closed).toBe(true)
}, 30_000)
