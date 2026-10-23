import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLUGIN_CORE_PROGRESS_LIMIT, runIdSchema, type PluginCoreProgress } from '@ggb-copilot/application'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { InternalChannelServer } from '../src/internal-channel/channel-server.js'
import { WorkerDispatchClient } from '../../api/src/worker-dispatch/dispatch-client.js'

const runId = runIdSchema.parse(`run_${randomUUID()}`)
const call = { runId, turnId: randomUUID(), epoch: 1, arguments: { secret: '/private/provider-key' } }

describe('Worker factual progress', () => {
  it('emits paired tool facts, real quota reservations and no fictitious fourth build', async () => {
    const state = new PluginCoreExecutionState('/unused')
    const facts: PluginCoreProgress[] = []
    const stop = state.observeProgress(runId, p => { facts.push(p) })
    const gateway = new PluginCoreGateway({ check: async () => ({ ok: true }), reference: async () => ({}),
      build: async () => ({ ok: false, error: { code: 'verification_failed', message: 'failed' } }) }, { state })
    await gateway.dispatch({ ...call, toolName: 'ggb_inspect', arguments: { reference: 'request' } })
    await gateway.dispatch({ ...call, toolName: 'ggb_check' })
    for (let i = 0; i < 4; i++) await gateway.dispatch({ ...call, toolName: 'ggb_build' })
    expect(facts.filter(p => p.tool === 'ggb_build' && p.status === 'started').map(p => p.attempt)).toEqual([1, 2, 3])
    expect(facts.filter(p => p.tool === 'ggb_build' && p.status === 'rejected')).toHaveLength(4)
    expect(facts.map(p => p.sequence)).toEqual(facts.map((_, i) => i + 1))
    expect(facts[0]?.callId).toBe(facts[1]?.callId)
    expect(JSON.stringify(facts)).not.toMatch(/secret|private|provider-key/)
    stop()
    await gateway.dispatch({ ...call, toolName: 'ggb_check' })
    expect(facts).toHaveLength(11)
  })
  it('bounds progress and isolates throwing observers from execution', async () => {
    const state = new PluginCoreExecutionState('/unused')
    const observer = vi.fn(() => { throw new Error('observer failed') })
    const stop = state.observeProgress(runId, observer)
    const gateway = new PluginCoreGateway({ check: async () => ({ ok: true }), build: async () => ({ ok: true }) }, { state })
    for (let i = 0; i < 80; i++) expect((await gateway.dispatch({ ...call, toolName: 'ggb_check' })).status).toBe('accepted')
    expect(observer).toHaveBeenCalledTimes(PLUGIN_CORE_PROGRESS_LIMIT)
    stop()
  })
  it('reports process exceptions and refunds before a repeated budget slot', async () => {
    const state = new PluginCoreExecutionState('/unused')
    const facts: PluginCoreProgress[] = []
    state.observeProgress(runId, p => { facts.push(p) })
    const gateway = new PluginCoreGateway({ check: async () => { throw new Error('process failed') },
      build: async () => ({ ok: false, buildPhase: 'preflight', error: { code: 'invalid_request', message: 'rejected' },
        execution: { kind: 'completed', exitCode: 0, signal: null, cleanupConfirmed: true,
          stdoutBytes: 0, stderrBytes: 0, stdoutTail: '', stderrTail: '' } }) }, { state })
    await expect(gateway.dispatch({ ...call, toolName: 'ggb_check' })).rejects.toThrow('process failed')
    for (let i = 0; i < 2; i++) await gateway.dispatch({ ...call, toolName: 'ggb_build' })
    expect(facts.map(p => p.status)).toEqual(['started', 'failed', 'started', 'rejected', 'started', 'rejected'])
    expect(facts.filter(p => p.status === 'started' && p.tool === 'ggb_build').map(p => p.attempt)).toEqual([1, 1])
    expect(facts[2]?.buildId).not.toBe(facts[4]?.buildId)
  })
  it('keeps the result waiter alive and closes observation after the final result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'progress-channel-'))
    const path = join(root, 'channel.sock')
    let late: (() => void) | undefined
    const progress = { tool: 'ggb_check' as const, status: 'started' as const,
      callId: randomUUID(), occurredAt: new Date().toISOString(), sequence: 1 }
    const server = new InternalChannelServer({ socketPath: path, secret: 'a'.repeat(64),
      workerInstanceId: 'test', maxMessageBytes: 65536 }, { pluginCore: async (_request, notify) => {
      notify(progress)
      notify(progress)
      notify({ ...progress, sequence: 2, tool: 'shell' } as never)
      late = () => { notify({ ...progress, sequence: 3 }) }
      return { finalResponse: 'final', error: null, delivery: null }
    } })
    const client = new WorkerDispatchClient(path, 'a'.repeat(64), 1000)
    const seen: PluginCoreProgress[] = []
    try {
      await server.listen()
      const result = await client.runPluginCore({ runId, providerKey: 'fake', prompt: 'offline' }, undefined,
        async p => { await Promise.resolve(); seen.push(p) })
      expect(result.finalResponse).toBe('final')
      expect(seen).toEqual([progress])
      late!()
      expect(seen).toHaveLength(1)
    } finally { client.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
  })
})
