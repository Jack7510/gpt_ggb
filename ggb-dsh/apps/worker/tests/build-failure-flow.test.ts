import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryPluginCoreStore } from '@ggb-copilot/run-persistence'
import { runIdSchema, type PluginCoreBuildFailure } from '@ggb-copilot/application'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { PluginCoreService } from '../src/plugin-core/service.js'
import { PluginCoreTurnError, type PluginCoreDshRunner } from '../src/plugin-core/dsh-runner.js'
import { InternalChannelServer } from '../src/internal-channel/channel-server.js'
import { WorkerDispatchClient } from '../../api/src/worker-dispatch/dispatch-client.js'
import { PluginCoreRunService } from '../../api/src/plugin-core/run-service.js'
import { startApiServer } from '../../api/src/http/http-server.js'
import { createApiHandler } from '../../api/src/routes/v3.js'
import { PluginCoreRunAdapter } from '../../client/src/runtime/plugin-core-adapter.js'
import { pluginViewState } from '../../client/src/runtime/plugin-core-projector.js'
import { failureMessage } from '../../client/src/app/failure-message.js'

const secret = 'a'.repeat(64)
const completed = { kind: 'completed' as const, exitCode: 0, signal: null, cleanupConfirmed: true,
  stdoutBytes: 0, stderrBytes: 0, stdoutTail: '', stderrTail: '' }

describe('build failure through Worker, authenticated channel, API, store and client', () => {
  it.each(['not_built', 'structure_rejected', 'execution_failed', 'verification_failed', 'sdk_failed_after_build'] as const)(
    'preserves actual evidence for %s, including terminal SSE reconnect', async mode => {
      const root = await mkdtemp(join(tmpdir(), 'build-failure-flow-'))
      const state = new PluginCoreExecutionState(root)
      let builds = 0
      let lastBuildId: string | undefined
      const gateway = new PluginCoreGateway({ check: async () => ({ ok: true }),
        reference: async () => ({ topic: 'request', content: 'fixture' }),
        build: async (_request, _runId, _signal, _base, call) => {
          builds += 1
          lastBuildId = call!.buildId
          return { ok: false, buildPhase: mode === 'structure_rejected' ? 'preflight' : 'execution',
            execution: mode === 'execution_failed' ? { ...completed, exitCode: 1 } : completed,
            error: { code: mode === 'structure_rejected' ? 'invalid_request' : 'verification_failed',
              message: mode === 'structure_rejected' ? 'Missing checks' : 'Required checks did not pass',
              ...(mode === 'structure_rejected' ? {} : { details: { checks: [{
                requirementId: 'shape', checkId: `shape:${builds}`, method: 'perpendicular', status: 'unverified',
                evidence: { message: 'Expected a line: side (segment)' },
              }] } }) } }
        } }, { state })
      const dsh = { run: async (request: { runId: ReturnType<typeof runIdSchema.parse> }) => {
        const calls = mode === 'not_built' ? 0 : mode === 'verification_failed' ? 4 : 1
        for (let i = 0; i < calls; i++) await gateway.dispatch({ toolName: 'ggb_build', runId: request.runId,
          turnId: randomUUID(), epoch: 1, arguments: {} })
        const result = { finalResponse: 'Unable to deliver', events: [
          { type: 'tool/call', data: { name: calls ? 'ggb_build' : 'ggb_inspect' } },
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ] }
        if (mode === 'sdk_failed_after_build') throw new PluginCoreTurnError('plugin_core_max_tokens', result as never, false, new Error('max-tokens'))
        return result
      } } as unknown as PluginCoreDshRunner
      const worker = new PluginCoreService(dsh, { outputRoot: root, state, resetRun: id => gateway.resetRun(id) })
      const channel = new InternalChannelServer({ socketPath: join(root, 'channel.sock'), secret,
        workerInstanceId: 'test', maxMessageBytes: 16 * 1024 * 1024 }, { pluginCore: (request, onProgress) => worker.run({
          runId: request.runId, deliveryContract: request.deliveryContract, prompt: request.prompt,
          providerKey: request.credential.providerKey!,
        }, onProgress) })
      await channel.listen()
      const dispatch = new WorkerDispatchClient(join(root, 'channel.sock'), secret, 2000)
      const store = new MemoryPluginCoreStore()
      const service = new PluginCoreRunService(store, dispatch, { engine: 'plugin_core', serverPepper: secret,
        maxConcurrentRuns: 2, activeRunTtlMs: 60000, terminalRunTtlMs: 60000 })
      const server = await startApiServer({ port: 0, listenHost: '127.0.0.1', maxBodyBytes: 65536,
        allowedOrigin: null, handler: createApiHandler({ pluginCore: service, agentEngine: 'plugin_core',
          sse: { pollMs: 5, heartbeatMs: 50 } }) })
      const adapter = new PluginCoreRunAdapter({ baseUrl: `http://127.0.0.1:${server.port}`, fetch })
      const runId = runIdSchema.parse(`run_${randomUUID()}`)
      try {
        await adapter.createRun({ runId, prompt: 'draw', base: null }, 'token', 'fake-key')
        let view = await adapter.getRun(runId, 'token')
        for (let i = 0; !view.terminal && i < 100; i++) {
          await new Promise(resolve => setTimeout(resolve, 5))
          view = await adapter.getRun(runId, 'token')
        }
        expect(view.phase).toBe('failed')
        const details = view.failure!.details!
        expect(details.kind).toBe(mode === 'sdk_failed_after_build' ? 'verification_failed' : mode)
        expect(details.lastBuildId).toBe(lastBuildId)
        expect(view.failure!.message).not.toMatch(/last build was rejected by verification/)
        expect(view.failure!.message).not.toContain(view.failure!.code)
        expect(view.failure!.code).toBe(mode === 'sdk_failed_after_build' ? 'plugin_core_max_tokens' : 'plugin_core_no_delivery')
        if (mode === 'verification_failed') {
          expect(builds).toBe(3) // fourth request is a quota rejection, not a new build
          expect(details.failedChecks[0]?.checkId).toBe('shape:3')
        }
        const event = (await store.listEvents(runId, 0, 20)).find(e => e.payload.type === 'plugin_core.failed')!
        expect(event.payload).toMatchObject({ details })
        expect(view.progress?.status).toBe(mode === 'not_built' ? undefined : 'rejected')
        expect(view.progress?.tool).toBe(mode === 'not_built' ? undefined : 'ggb_build')
        const notices: string[] = []
        await adapter.openEventStream(runId, 'token', event.eventId, {
          onReady: ready => { notices.push(failureMessage(pluginViewState(ready.run).failure!, 'zh-CN')) },
          onEvent: () => { throw new Error('reconnect should not replay acknowledged events') },
        }, new AbortController().signal)
        expect(notices).toHaveLength(1)
        if (mode !== 'not_built') expect(notices[0]).toContain(lastBuildId)
        if (details.kind === 'verification_failed') expect(notices[0]).toContain('Expected a line')
        expect(state.buildFailure(runId).kind).toBe('not_built') // result survives resource release
      } finally {
        service.stopAll(); await service.waitForSettlements(1000); await server.close(); dispatch.close(); await channel.close()
        await rm(root, { recursive: true, force: true })
      }
    }, 10000)
})
