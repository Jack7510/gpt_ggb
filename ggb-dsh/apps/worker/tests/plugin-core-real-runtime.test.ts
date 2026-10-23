import { tmpdir } from 'node:os'
import { PluginCoreProcessRunner } from '../src/plugin-core/process-runner.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { runIdSchema, type RunId, type ChannelPluginCoreBase } from '@ggb-copilot/application'
import { SqlitePluginCoreStore } from '@ggb-copilot/run-persistence'
import { composeWorker, type WorkerComposition } from '../src/composition.js'
import { WorkerDispatchClient } from '../../api/src/worker-dispatch/dispatch-client.js'
import { PluginCoreRunService } from '../../api/src/plugin-core/run-service.js'

// Deliberate opt-in: ordinary unit checks must never launch GeoGebra or Chromium.
const enabled = process.env.GGB_PLUGIN_REAL_RUNTIME === '1'
const output = resolve(process.env.GGB_E_OUTPUT_ROOT ?? '../output/installed-plugin-e/verification')
const pluginRoot = process.env.GGB_PLUGIN_TEST_ROOT
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const exec = promisify(execFile)
const pause = () => new Promise(resolveWait => setTimeout(resolveWait, 50))
interface Row { pid: number; ppid: number; group: number; state: string; command: string }
async function processes(): Promise<Row[]> {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='])
  return stdout.trim().split('\n').map(line => {
    const [pid, ppid, group, state, ...command] = line.trim().split(/\s+/u)
    return { pid: Number(pid), ppid: Number(ppid), group: Number(group), state: state!, command: command.join(' ') }
  })
}
function tree(rows: Row[], runId: RunId): Row[] {
  const root = rows.find(row => row.command.includes('dsh/executor.js') && row.command.includes(runId))
  if (!root) return []
  const owned = new Set([root.pid])
  for (let n = 0; n < rows.length; n++) {
    for (const row of rows) if (row.group === root.pid || owned.has(row.ppid)) owned.add(row.pid)
  }
  return rows.filter(row => owned.has(row.pid))
}

describe.skipIf(!enabled)('real installed runtime, mock SDK, no Provider', () => {
  let worker: WorkerComposition
  let client: WorkerDispatchClient
  let store: SqlitePluginCoreStore
  let api: PluginCoreRunService
  let request: unknown
  let tools: { createTool(name: string): { execute(input: unknown, context: unknown): Promise<unknown> } }
  const results: unknown[] = []
  const secret = 'e'.repeat(64)
  const token = 'offline-runtime-verification'
  let mockSdkCalls = 0
  let prepared = false
  let scratch: string

  beforeAll(async () => {
    if (!pluginRoot) throw new Error('GGB_PLUGIN_TEST_ROOT must name a completely provisioned installation')
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await mkdir(output, { mode: 0o700 }) // evidence directories are never reused
    prepared = true
    scratch = await mkdtemp(join(tmpdir(), 'ggb-rt-'))
    const require = createRequire(join(pluginRoot, 'package.json'))
    tools = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/server')).href)
    worker = await composeWorker({ GGB_V3_WORKER_SECRET: secret, GGB_PLUGIN_ROOT: pluginRoot,
      GGB_V3_WORKER_SOCKET_PATH: join(scratch, 'worker.sock'), GGB_PLUGIN_CORE_TOOL_SOCKET: join(scratch, 'tool.sock'),
      GGB_PLUGIN_CORE_OUTPUT_ROOT: join(output, 'runs'), GGB_V3_DSH_HOME_ROOT: join(scratch, 'homes'),
      GGB_V3_PROVIDER_BASE_URL: 'http://127.0.0.1:1' }, {
      createHarness: options => ({ close: async () => undefined, run: async () => {
        mockSdkCalls++
        for (const [key, value] of Object.entries(options.env ?? {})) {
          if (key.startsWith('GGB_PLUGIN_CORE_TOOL_')) vi.stubEnv(key, value!)
        }
        try {
          const result = await tools.createTool('ggb_build').execute({ request }, { signal: new AbortController().signal })
          results.push(result)
          return { finalResponse: 'deterministic test driver', events: [{ type: 'turn/end',
            data: { reason: { kind: 'completed' } } }] } as unknown as RunResult
        } finally { vi.unstubAllEnvs() }
      } }),
    }) // Real resource preflight; only the model Harness is substituted.
    await worker.start()
    client = new WorkerDispatchClient(worker.config.socketPath, secret, 180_000)
    store = new SqlitePluginCoreStore(join(output, 'runs.sqlite'))
    api = new PluginCoreRunService(store, client, { engine: 'plugin_core', serverPepper: secret,
      maxConcurrentRuns: 1, activeRunTtlMs: 600_000, terminalRunTtlMs: 600_000 })
  })
  afterAll(async () => {
    if (!prepared) return
    api?.stopAll()
    await api?.waitForSettlements(15_000)
    client?.close()
    await worker?.dispose()
    store?.close()
    await rm(scratch, { recursive: true, force: true })
    await writeFile(join(output, 'summary.json'), JSON.stringify({ mockSdkCalls, providerRequests: 0,
      modelDriver: 'injected mock Harness only', results }, null, 2), { mode: 0o600 })
  })
  async function start(next: unknown, base: ChannelPluginCoreBase | null = null) {
    request = next
    const runId = runIdSchema.parse(`run_${randomUUID()}`)
    await api.createRun({ runId, runToken: token, idempotencyKey: runId, providerKey: 'fake-never-sent',
      prompt: 'deterministic real-runtime test', base, requestDigest: hash(JSON.stringify(next)) })
    return runId
  }
  async function terminal(runId: RunId) {
    for (let i = 0; i < 3600; i++) {
      const record = await store.getRun(runId)
      if (record && ['completed', 'failed', 'cancelled'].includes(record.phase)) return record
      await pause()
    }
    throw new Error(`run_timeout:${runId}`)
  }
  async function delivered(runId: RunId) {
    const record = await terminal(runId)
    await writeFile(join(output, `${runId}.json`), JSON.stringify(record, null, 2), { mode: 0o600 })
    expect(record.phase, JSON.stringify({ error: record.failure, tools: results.at(-1) })).toBe('completed')
    expect(record.deliveryContract).toBe('receipt-v1')
    expect(record.delivery?.cleanup?.confirmed).toBe(true)
    expect(record.delivery?.trustedBuild?.binding.runId).toBe(runId)
    const artifacts = record.delivery!.artifacts
    for (const meta of artifacts) {
      const artifact = await api.getArtifact(runId, token, meta.artifactId)
      const bytes = Buffer.from(artifact.contentBase64, 'base64')
      expect(bytes.length).toBe(meta.sizeBytes)
      expect(hash(bytes)).toBe(meta.sha256)
      await writeFile(join(output, `${runId}.${meta.kind}`), bytes, { mode: 0o600 })
    }
    const ggb = artifacts.find(item => item.kind === 'result_ggb')!
    const value = await api.getArtifact(runId, token, ggb.artifactId)
    expect(Buffer.from(value.contentBase64, 'base64').subarray(0, 2).toString()).toBe('PK')
    return { dataBase64: value.contentBase64, sha256: ggb.sha256, name: 'real-base.ggb' }
  }
  const create = { protocolVersion: 2, prompt: 'Create point P', locale: 'en', plan: {
    program: [{ op: 'freePoint', id: 'P', x: 0, y: 0 }], requirements: [{ id: 'present', source: 'point P', checks: [{ kind: 'exists', subjects: ['P'], scope: 'initial' }] }],
    interactions: [] } }

  it('executes the published circle example through real GeoGebra and trusted delivery', async () => {
    const require = createRequire(join(pluginRoot!, 'package.json'))
    const installation = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/installation')).href)
    const body = installation.loadWorkerSkill()
    const example = JSON.parse(/```json\n([\s\S]*?)\n```/u.exec(body)![1]!)
    await delivered(await start(example.request))
  }, 180_000)

  it('builds, reloads, accepts bound receipts and atomically stores original artifact bytes', async () => {
    const base = await delivered(await start(create))
    const unchanged = hash(Buffer.from(base.dataBase64, 'base64'))
    await delivered(await start({ protocolVersion: 2, prompt: 'Make P red', locale: 'en', plan: {
      edits: [{ object: 'P', properties: { color: '#D74830' } }],
      requirements: [{ id: 'red', source: 'Make P red', checks: [{ kind: 'style', subjects: ['P'], scope: 'initial',
        properties: { color: '#D74830' } }] }], interactions: [] } }, base))
    await delivered(await start({ protocolVersion: 2, prompt: 'Create Q=(1,1)', locale: 'en', plan: {
      program: [{ op: 'native', id: 'Q', source: 'Q=(1,1)', mode: 'algebra', outputs: ['Q'] }],
      requirements: [{ id: 'q', source: 'Q=(1,1)', checks: [{ kind: 'exists', subjects: ['Q'], scope: 'initial' }] }],
      interactions: [] } }, base))
    expect(hash(Buffer.from(base.dataBase64, 'base64'))).toBe(unchanged)
  }, 240_000)

  it('delivers real verified GeoGebra bytes with no preview artifact', async () => {
    const original = PluginCoreProcessRunner.prototype.spawn
    const adapter = fileURLToPath(new URL('./fixtures/without-preview-executor.mjs', import.meta.url))
    const injected = vi.spyOn(PluginCoreProcessRunner.prototype, 'spawn').mockImplementationOnce(function (this: PluginCoreProcessRunner, args, timeoutMs, signal) {
      return original.call(this, [adapter, ...args.slice(1), '--plugin-root', pluginRoot!], timeoutMs, signal)
    })
    try {
      const runId = await start(create)
      await delivered(runId)
      const record = await store.getRun(runId)
      expect(record!.delivery!.artifacts.some(artifact => artifact.kind === 'preview')).toBe(false)
      expect(record!.delivery!.trustedBuild!.receipt).toMatchObject({ receiptSchemaVersion: 2, status: 'succeeded' })
      expect(injected).toHaveBeenCalledTimes(1)
      await writeFile(join(output, 'optional-preview.json'), JSON.stringify({ runId,
        adapter: 'real public CLI; omit preview before public executor receipt',
        previewPresent: false, cleanup: record!.delivery!.cleanup }), { mode: 0o600 })
    } finally { injected.mockRestore() }
  }, 180_000)

  it('cancels a live Chromium tree, settles only after exit, then reuses the slot for a real build', async () => {
    const runId = await start(create)
    let observed: Row[] = []
    for (let i = 0; i < 1200; i++) {
      observed = tree(await processes(), runId)
      if (observed.some(row => row.command.includes('--type=renderer'))) break
      const phase = (await store.getRun(runId))?.phase
      if (phase === 'failed' || phase === 'completed') break
      await pause()
    }
    expect(observed.some(row => row.command.includes('--type=renderer'))).toBe(true)
    await api.stop(runId, token)
    const record = await terminal(runId)
    expect(record.phase).toBe('cancelled')
    expect(record.delivery).toBeNull()
    const events = await store.listEvents(runId, 0, 100)
    const cancelled = events.filter(event => event.payload.type === 'plugin_core.cancelled')
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.payload).toMatchObject({ cleanup: { runId, confirmed: true } })
    const pids = new Set(observed.map(row => row.pid))
    const remaining = (await processes()).filter(row => pids.has(row.pid) && !row.state.startsWith('Z'))
    expect(remaining).toEqual([])
    await writeFile(join(output, 'cancel-processes.json'), JSON.stringify({ runId, observed, remaining, record, cancelled }, null, 2), { mode: 0o600 })
    await delivered(await start(create))
  }, 240_000)
})
