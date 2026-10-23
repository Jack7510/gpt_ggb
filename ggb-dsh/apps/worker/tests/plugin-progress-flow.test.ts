import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryPluginCoreStore } from '@ggb-copilot/run-persistence'
import { runIdSchema, type PluginCoreProgress } from '@ggb-copilot/application'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { PluginCoreService } from '../src/plugin-core/service.js'
import type { PluginCoreDshRunner } from '../src/plugin-core/dsh-runner.js'
import { InternalChannelServer } from '../src/internal-channel/channel-server.js'
import { WorkerDispatchClient } from '../../api/src/worker-dispatch/dispatch-client.js'
import { PluginCoreRunService } from '../../api/src/plugin-core/run-service.js'
import { startApiServer } from '../../api/src/http/http-server.js'
import { createApiHandler } from '../../api/src/routes/v3.js'
import { PluginCoreRunAdapter } from '../../client/src/runtime/plugin-core-adapter.js'
import { applyPluginEvent, pluginViewState } from '../../client/src/runtime/plugin-core-projector.js'

it('streams actual tool calls through Worker → API → SSE and restores a disconnected running snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'progress-flow-'))
  const secret = 'a'.repeat(64)
  const state = new PluginCoreExecutionState(root)
  let begin!: () => void
  let finish!: () => void
  const start = new Promise<void>(resolve => { begin = resolve })
  const build = new Promise<void>(resolve => { finish = resolve })
  const gateway = new PluginCoreGateway({ check: async () => ({ ok: true }), build: async () => {
    await build
    return { ok: false, error: { code: 'verification_failed', message: 'Fixture rejection' } }
  } }, { state })
  const dsh = { run: async (request: { runId: ReturnType<typeof runIdSchema.parse> }) => {
    await start
    for (const toolName of ['ggb_check', 'ggb_build'] as const) await gateway.dispatch({
      runId: request.runId, toolName, turnId: randomUUID(), epoch: 1, arguments: {} })
    return { finalResponse: '', events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] }
  } } as unknown as PluginCoreDshRunner
  const worker = new PluginCoreService(dsh, { outputRoot: root, state, resetRun: id => gateway.resetRun(id) })
  const channel = new InternalChannelServer({ socketPath: join(root, 'channel.sock'), secret,
    workerInstanceId: 'test', maxMessageBytes: 65536 }, { pluginCore: (request, notify) => worker.run({
      runId: request.runId, deliveryContract: request.deliveryContract, prompt: request.prompt,
      providerKey: request.credential.providerKey!,
    }, notify) })
  await channel.listen()
  const dispatch = new WorkerDispatchClient(join(root, 'channel.sock'), secret, 2000)
  const store = new MemoryPluginCoreStore()
  const service = new PluginCoreRunService(store, dispatch, { engine: 'plugin_core', serverPepper: secret,
    maxConcurrentRuns: 1, activeRunTtlMs: 60000, terminalRunTtlMs: 60000 })
  const server = await startApiServer({ port: 0, listenHost: '127.0.0.1', maxBodyBytes: 65536,
    allowedOrigin: null, handler: createApiHandler({ pluginCore: service, agentEngine: 'plugin_core',
      sse: { pollMs: 5, heartbeatMs: 50 } }) })
  const adapter = new PluginCoreRunAdapter({ baseUrl: `http://127.0.0.1:${server.port}`, fetch })
  const runId = runIdSchema.parse(`run_${randomUUID()}`)
  const first = new AbortController()
  const second = new AbortController()
  try {
    await adapter.createRun({ runId, prompt: 'offline tool flow', base: null }, 'token', 'fake-key')
    const seen: PluginCoreProgress[] = []
    let cursor = 0
    await adapter.openEventStream(runId, 'token', 0, {
      onReady: () => { begin() }, onEvent: event => {
        cursor = event.eventId
        if (event.payload.type === 'plugin_core.progress') {
          seen.push(event.payload.progress)
          if (event.payload.progress.tool === 'ggb_build') first.abort()
        }
      },
    }, first.signal).catch(error => { if (!first.signal.aborted) throw error })
    expect(seen.map(p => [p.tool, p.status])).toEqual([
      ['ggb_check', 'started'], ['ggb_check', 'accepted'], ['ggb_build', 'started']])
    const running = await adapter.getRun(runId, 'token')
    expect(running.phase).toBe('running')
    expect(running.progress).toMatchObject({ tool: 'ggb_build', status: 'started', attempt: 1, limit: 3 })
    let projected = pluginViewState(running)
    await adapter.openEventStream(runId, 'token', cursor, {
      onReady: ready => {
        projected = pluginViewState(ready.run)
        expect(projected.progress).toEqual(running.progress)
        expect(ready.cursor).toBeGreaterThanOrEqual(cursor)
        finish()
      }, onEvent: event => { projected = applyPluginEvent(projected, event) },
    }, second.signal)
    expect(projected.terminal).toBe(true)
    expect(projected.phase).toBe('failed')
    expect(projected.progress?.status).toBe('rejected')
    const terminal = await adapter.getRun(runId, 'token')
    expect(terminal.progress?.buildId).toBe(running.progress?.buildId)
    expect(terminal.failure?.details?.lastBuildId).toBe(running.progress?.buildId)
  } finally {
    first.abort(); second.abort(); begin(); finish()
    service.stopAll(); await service.waitForSettlements(1000)
    await server.close(); dispatch.close(); await channel.close()
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
