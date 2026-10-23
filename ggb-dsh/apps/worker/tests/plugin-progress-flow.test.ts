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
import { PluginCoreDshRunner } from '../src/plugin-core/dsh-runner.js'
import { PluginCoreToolGatewayServer } from '../src/plugin-core/tool-gateway-server.js'
import { toolProtocol, serverPatch } from './fixtures/installed-plugin.js'
import { InternalChannelServer } from '../src/internal-channel/channel-server.js'
import { WorkerDispatchClient } from '../../api/src/worker-dispatch/dispatch-client.js'
import { PluginCoreRunService } from '../../api/src/plugin-core/run-service.js'
import { startApiServer } from '../../api/src/http/http-server.js'
import { createApiHandler } from '../../api/src/routes/v3.js'
import { PluginCoreRunAdapter } from '../../client/src/runtime/plugin-core-adapter.js'
import { applyPluginEvent, pluginViewState } from '../../client/src/runtime/plugin-core-projector.js'

it('streams live SDK and tool facts through Worker → API → SSE and restores complete reconnect snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'progress-flow-'))
  const secret = 'a'.repeat(64)
  const state = new PluginCoreExecutionState(root)
  let begin!: () => void
  let finish!: () => void
  let endTurn!: () => void
  const start = new Promise<void>(resolve => { begin = resolve })
  const build = new Promise<void>(resolve => { finish = resolve })
  const turn = new Promise<void>(resolve => { endTurn = resolve })
  const gateway = new PluginCoreGateway({ check: async () => ({ ok: true }), build: async () => {
    await build
    return { ok: false, error: { code: 'verification_failed', message: 'Fixture rejection' } }
  } }, { state })
  const runId = runIdSchema.parse(`run_${randomUUID()}`)
  const tools = new PluginCoreToolGatewayServer(join(root, 'tools.sock'), gateway, 160_000, { protocol: toolProtocol })
  const dsh = new PluginCoreDshRunner({ workspaceRoot: root, dshHomeRoot: join(root, 'homes'),
    provider: 'deepseek', baseUrl: 'http://127.0.0.1:1', modelId: 'offline', reasoningEffort: 'off',
    maxTokens: 512, serverPatch, sdkVersion: '0.2.1-rc.2', state,
    createHarness: () => ({ close: async () => {}, run: async (_prompt, options) => {
      await start
      const notify = (type: string) => options.onNotification?.({ method: 'session.event', params: {
        sessionId: options.sessionId, event: { type, data: { turn: 1, step: 1 } },
      } } as never)
      notify('step/start')
      for (const toolName of ['ggb_check', 'ggb_build'] as const) await gateway.dispatch({
        runId, toolName, turnId: options.sessionId, epoch: 1, arguments: {} })
      await turn
      notify('step/end'); notify('turn/end')
      return { finalResponse: '', events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] } as never
    } }),
  }, tools)
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
  const first = new AbortController()
  const second = new AbortController()
  const third = new AbortController()
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
      ['model', 'started'], ['ggb_check', 'started'], ['ggb_check', 'accepted'], ['ggb_build', 'started']])
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
      }, onEvent: event => {
        cursor = event.eventId
        projected = applyPluginEvent(projected, event)
        if (event.payload.type === 'plugin_core.progress' && event.payload.progress.status === 'rejected') second.abort()
      },
    }, second.signal).catch(error => { if (!second.signal.aborted) throw error })
    const rejected = await adapter.getRun(runId, 'token')
    expect(rejected.progress).toMatchObject({ tool: 'ggb_build', status: 'rejected', attempt: 1, limit: 3 })
    expect(rejected.progress?.buildId).toBe(running.progress?.buildId)
    await adapter.openEventStream(runId, 'token', cursor, {
      onReady: ready => {
        projected = pluginViewState(ready.run)
        expect(projected.progress).toEqual(rejected.progress)
        endTurn()
      }, onEvent: event => { projected = applyPluginEvent(projected, event) },
    }, third.signal)
    expect(projected.terminal).toBe(true)
    expect(projected.phase).toBe('failed')
    expect(projected.progress).toMatchObject({ tool: 'model', status: 'finished', step: 1, attempt: 1, limit: 3 })
    const terminal = await adapter.getRun(runId, 'token')
    expect(terminal.progress?.buildId).toBe(running.progress?.buildId)
    expect(terminal.failure?.details?.lastBuildId).toBe(running.progress?.buildId)
    expect(pluginViewState(terminal).progress).toEqual(projected.progress)
  } finally {
    first.abort(); second.abort(); third.abort(); begin(); finish(); endTurn()
    service.stopAll(); await service.waitForSettlements(1000)
    await server.close(); dispatch.close(); await channel.close()
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
