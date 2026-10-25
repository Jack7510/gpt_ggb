import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { runIdSchema } from '@ggb-copilot/application'
import { MemoryPluginCoreStore } from '@ggb-copilot/run-persistence'
import { InternalChannelServer } from '../src/internal-channel/channel-server.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { WorkerDispatchClient } from '../../api/src/worker-dispatch/dispatch-client.js'
import { PluginCoreRunService } from '../../api/src/plugin-core/run-service.js'
import { createApiHandler } from '../../api/src/routes/v3.js'
import { startApiServer, type RunningApiServer } from '../../api/src/http/http-server.js'

const secret = 'a'.repeat(64)
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0 })

async function setup(checkWorker = true) {
  const root = await mkdtemp(join(tmpdir(), 'ggb-ready-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ready = vi.fn(async () => undefined)
  const run = vi.fn(async () => { throw new Error('probe must never execute a run') })
  const worker = new InternalChannelServer({ socketPath: join(root, 'worker.sock'), secret,
    workerInstanceId: 'worker-ready', maxMessageBytes: 65536 }, { ready, pluginCore: run })
  await worker.listen()
  cleanups.push(() => worker.close())
  const client = new WorkerDispatchClient(join(root, 'worker.sock'), secret, 150)
  const service = new PluginCoreRunService(new MemoryPluginCoreStore(), client, {
    engine: 'plugin_core', serverPepper: secret, maxConcurrentRuns: 1,
    activeRunTtlMs: 60000, terminalRunTtlMs: 60000,
  })
  const api: RunningApiServer = await startApiServer({ port: 0, listenHost: '127.0.0.1',
    maxBodyBytes: 65536, allowedOrigin: null, handler: createApiHandler({
      agentEngine: 'plugin_core', pluginCore: service,
      ...(checkWorker ? { checkWorkerReady: () => client.probe() } : {}),
      legacyNativeRuns: { check: async () => 'not_found' }, sse: { pollMs: 20, heartbeatMs: 50 },
    }) })
  cleanups.push(() => api.close())
  cleanups.push(async () => client.close())
  return { worker, client, ready, run, service, socketPath: join(root, 'worker.sock'), url: `http://127.0.0.1:${api.port}/api/v3/health` }
}

describe('deployment readiness without Provider or browser execution', () => {
  it('fails closed when no Worker probe is configured', async () => {
    const f = await setup(false)
    expect((await fetch(`${f.url}/ready`)).status).toBe(503)
    expect(f.ready).not.toHaveBeenCalled()
  })

  it('uses a fresh authenticated handshake on each HTTP probe, recovers after resource repair', async () => {
    const f = await setup()
    expect((await fetch(`${f.url}/ready`)).status).toBe(200)
    f.ready.mockRejectedValueOnce(new Error('runtime_missing secret-data-not-for-response'))
    const unavailable = await fetch(`${f.url}/ready`)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ status: 'unavailable' })
    expect((await fetch(`${f.url}/ready`)).status).toBe(200)
    expect(f.ready).toHaveBeenCalledTimes(3)
    expect(f.run).not.toHaveBeenCalled()
  })

  it('keeps liveness separate and rejects drain without probing the Worker', async () => {
    const f = await setup()
    f.service.beginDrain()
    expect((await fetch(`${f.url}/live`)).status).toBe(200)
    expect((await fetch(`${f.url}/ready`)).status).toBe(503)
    expect(f.ready).not.toHaveBeenCalled()
  })

  it('rechecks API drain after the Worker handshake completes', async () => {
    const f = await setup()
    f.ready.mockImplementationOnce(async () => { f.service.beginDrain() })
    expect((await fetch(`${f.url}/ready`)).status).toBe(503)
    expect(f.ready).toHaveBeenCalledOnce()
  })

  it('rejects a disconnected Worker and a mismatched channel secret', async () => {
    const f = await setup()
    const wrong = new WorkerDispatchClient(f.socketPath, 'b'.repeat(64), 100)
    await expect(wrong.probe()).rejects.toThrow()
    wrong.close()
    expect(f.ready).not.toHaveBeenCalled()
    await f.worker.close()
    expect((await fetch(`${f.url}/ready`)).status).toBe(503)
  })

  it('bounds an unresponsive handshake and closes the probe socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggb-timeout-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'silent.sock')
    let closed!: () => void
    const disconnected = new Promise<void>(resolve => { closed = resolve })
    const server: Server = createServer(socket => { socket.resume(); socket.on('close', closed) })
    await new Promise<void>(resolve => server.listen(path, resolve))
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const client = new WorkerDispatchClient(path, secret, 50)
    await expect(client.probe()).rejects.toThrow()
    await disconnected
    client.close()
  })
})

it('retains execution ownership and quarantine when volatile runtime is removed and Worker is recreated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ggb-persistence-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const persistent = join(root, 'state/plugin-core-runs')
  const runtime = join(root, 'run/ggb-dsh')
  await mkdir(runtime, { recursive: true })
  const runId = runIdSchema.parse('run_00000000-0000-4000-8000-000000000811')
  await new PluginCoreExecutionState(persistent).acquireEpoch(runId)
  await rm(runtime, { recursive: true })
  const restarted = new PluginCoreExecutionState(persistent)
  await restarted.fenceOrphans()
  await expect(restarted.assertRunSafe(runId)).rejects.toThrow('plugin_core_cleanup_failed')
  expect(JSON.parse(await readFile(join(persistent, runId, 'owner.json'), 'utf8')).epoch).toBe(1)
  const again = new PluginCoreExecutionState(persistent)
  await expect(again.assertRunSafe(runId)).rejects.toThrow('plugin_core_cleanup_failed')
})
