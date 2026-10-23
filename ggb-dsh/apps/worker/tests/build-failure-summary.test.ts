import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { runIdSchema, pluginCoreBuildFailureSchema } from '@ggb-copilot/application'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import type { PluginCoreRunResult } from '../src/plugin-core/process-runner.js'

const runId = runIdSchema.parse(`run_${randomUUID()}`)
const other = runIdSchema.parse(`run_${randomUUID()}`)
const completed = { kind: 'completed' as const, exitCode: 0, signal: null, cleanupConfirmed: true,
  stdoutBytes: 0, stderrBytes: 0, stdoutTail: '', stderrTail: '' }
async function dispatch(result: PluginCoreRunResult | Error) {
  const state = new PluginCoreExecutionState('/unused')
  const gateway = new PluginCoreGateway({ check: async () => ({ ok: true }),
    build: async () => { if (result instanceof Error) throw result; return result } }, { state })
  try { await gateway.dispatch({ toolName: 'ggb_build', runId, turnId: randomUUID(), epoch: 1, arguments: {} }) }
  catch { /* Unknown runner throws still leave an attempted build record. */ }
  return state
}

describe('last build failure evidence', () => {
  it.each([
    [{ ok: false, buildPhase: 'preflight', execution: completed, error: { code: 'invalid_request', message: 'Missing checks' } }, 'structure_rejected'],
    [{ ok: false, buildPhase: 'execution', execution: { ...completed, exitCode: 1 }, error: { code: 'verification_failed', message: 'CLI failed' } }, 'execution_failed'],
    [{ ok: false, buildPhase: 'execution', execution: completed, error: { code: 'verification_failed', message: 'Required checks failed' } }, 'verification_failed'],
    [new Error('/server/private/report.json'), 'execution_failed'],
  ] as const)('classifies actual phase and process facts: %s', async (result, kind) => {
    const state = await dispatch(result)
    expect(state.buildFailure(runId)).toMatchObject({ kind, lastBuildId: expect.any(String) })
    expect(state.buildFailure(other)).toEqual({ kind: 'not_built', failedChecks: [], reasons: [] })
    state.release(runId)
    expect(state.buildFailure(runId).kind).toBe('not_built')
  })
  it('keeps only three checks/reasons, redacts paths and credentials, and drops raw reports', async () => {
    const state = await dispatch({ ok: false, buildPhase: 'execution', execution: completed,
      error: { code: 'verification_failed', message: 'See /server/private/report.json sk-fake-secret',
        details: { checks: Array.from({ length: 10 }, (_, i) => ({ requirementId: 'req', checkId: `req:${i}`,
          method: 'perpendicular', status: 'unverified', evidence: { message: 'Expected a line: s (segment)' } })),
          raw: 'unrelated-user-data' } } })
    const summary = state.buildFailure(runId)
    expect(pluginCoreBuildFailureSchema.safeParse(summary).success).toBe(true)
    expect(summary.failedChecks).toHaveLength(3)
    expect(summary.reasons).toHaveLength(3)
    expect(summary.reasons[0]).toContain('Expected a line')
    expect(JSON.stringify(summary)).not.toMatch(/private|sk-fake-secret|unrelated-user-data/)
  })
  it('keeps overlapping runs and their last build identities independent', () => {
    const state = new PluginCoreExecutionState('/unused')
    const first = randomUUID(), second = randomUUID(), third = randomUUID()
    state.startBuild(runId, first)
    state.startBuild(other, second)
    state.startBuild(runId, third)
    expect(state.buildFailure(runId)?.lastBuildId).toBe(third)
    expect(state.buildFailure(other)?.lastBuildId).toBe(second)
    state.release(runId)
    expect(state.buildFailure(other)?.lastBuildId).toBe(second)
  })
  it('clears a previous failure after a successful build without inventing a failure for an SDK error', () => {
    const state = new PluginCoreExecutionState('/unused')
    const first = randomUUID()
    state.startBuild(runId, first)
    expect(state.buildFailure(runId)?.lastBuildId).toBe(first)
    const second = randomUUID()
    state.startBuild(runId, second)
    state.finishBuild(runId, second)
    expect(state.buildFailure(runId)).toBeUndefined()
    expect(state.missingDeliveryFailure(runId)).toMatchObject({ lastBuildId: second,
      kind: 'execution_failed', error: { code: 'accepted_receipt_missing' } })
  })
  it('rejects arbitrary fields, oversized summaries and inconsistent build identity', () => {
    const plain = { kind: 'not_built', failedChecks: [], reasons: [] }
    for (const value of [{ ...plain, path: '/server/private' }, { ...plain, lastBuildId: randomUUID() },
      { ...plain, reasons: ['x'.repeat(513)] }, { ...plain, kind: 'execution_failed' }]) {
      expect(pluginCoreBuildFailureSchema.safeParse(value).success).toBe(false)
    }
  })
})
