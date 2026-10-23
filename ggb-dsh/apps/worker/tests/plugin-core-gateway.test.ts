import { describe, expect, it, vi } from 'vitest'
import { runIdSchema } from '@ggb-copilot/application'

import { PluginCoreBaseRegistry } from '../src/plugin-core/base-registry.js'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import type { PluginCoreRunResult } from '../src/plugin-core/process-runner.js'

const runId = runIdSchema.parse('run_00000000-0000-4000-8000-000000000001')
const digest = 'a'.repeat(64)

const delivered: PluginCoreRunResult = { ok: true, check: { delivery: { id: digest },
  verification: { construction: { status: 'passed' }, reload: { status: 'passed' } } } }

function gateway() {
  const runner = {
    check: vi.fn(async (): Promise<PluginCoreRunResult> => ({ ok: true, check: { validation: 'structural' } })),
    build: vi.fn(async (): Promise<PluginCoreRunResult> => delivered),
  }
  return { runner, gateway: new PluginCoreGateway(runner) }
}

describe('plugin-core gateway', () => {
  it('projects a successful check without server paths', async () => {
    const { gateway: subject, runner } = gateway()
    const result = await subject.dispatch({ toolName: 'ggb_check', runId, turnId: 'turn', epoch: 1,
      arguments: { protocolVersion: 2, prompt: 'draw a circle' } })
    expect(result).toMatchObject({ status: 'accepted', toolName: 'ggb_check',
      result: { validation: 'structural' } })
    expect(runner.check).toHaveBeenCalledOnce()
    expect(runner.build).not.toHaveBeenCalled()
  })

  it('returns delivery facts and strips server paths', async () => {
    const { gateway: subject } = gateway()
    const result = await subject.dispatch({ toolName: 'ggb_build', runId, turnId: 'turn', epoch: 1,
      arguments: { protocolVersion: 2, prompt: 'draw a circle' } })
    expect(result.status).toBe('accepted')
    expect(result.result).toMatchObject({ delivery: { id: digest },
    verification: { construction: { status: 'passed' }, reload: { status: 'passed' } } })
    expect(result.report).toMatchObject({ status: 'accepted', buildId: expect.any(String),
      verification: { construction: { status: 'passed' }, reload: { status: 'passed' } },
      failedChecks: [], issueCount: 0 })
    expect(JSON.stringify(result)).not.toContain('/server/secret')
    expect(JSON.stringify(result)).not.toContain('runDir')
  })

  it('rejects a failed build and preserves the stable error code', async () => {
    const runner = {
      check: vi.fn(async (): Promise<PluginCoreRunResult> => ({ ok: true })),
      build: vi.fn(async (): Promise<PluginCoreRunResult> => ({ ok: false,
        error: { code: 'plugin_build_rejected', message: 'verification failed' } })),
    }
    const subject = new PluginCoreGateway(runner)
    const result = await subject.dispatch({ toolName: 'ggb_build', runId, turnId: 'turn', epoch: 1,
      arguments: { protocolVersion: 2, prompt: 'draw a circle' } })
    expect(result).toMatchObject({ status: 'rejected', result: null,
      errors: [{ code: 'plugin_build_rejected', message: 'verification failed' }] })
  })

  it('names the first rejected checks for model-facing repair', async () => {
    const runner = {
      check: vi.fn(async (): Promise<PluginCoreRunResult> => ({ ok: true })),
      build: vi.fn(async (): Promise<PluginCoreRunResult> => ({ ok: false, error: {
        code: 'verification_failed', message: 'Required checks did not pass',
        details: { failures: [{ details: { cause: [
          { requirementId: 'foci', checkId: 'foci:2', method: 'type', status: 'failed' },
          { requirementId: 'bisector', checkId: 'bisector:4', method: 'perpendicular', status: 'unverified' },
        ] } }] },
      } })),
    }
    const subject = new PluginCoreGateway(runner)
    const result = await subject.dispatch({ toolName: 'ggb_build', runId, turnId: 'turn', epoch: 1,
      arguments: { protocolVersion: 2, prompt: 'draw a circle' } })
    expect(result).toMatchObject({ status: 'rejected',
      errors: [{ code: 'verification_failed',
        message: expect.stringContaining('foci:2 type failed; bisector:4 perpendicular unverified') }],
      report: { status: 'rejected', buildId: expect.any(String), issueCount: 2,
        failedChecks: [
          { requirementId: 'foci', checkId: 'foci:2', method: 'type', status: 'failed' },
          { requirementId: 'bisector', checkId: 'bisector:4', method: 'perpendicular', status: 'unverified' },
        ] } })
  })

  it('bounds builds per run and resets on a terminal run', async () => {
    const { gateway: subject, runner } = gateway()
    for (let index = 0; index < 3; index += 1) {
      const result = await subject.dispatch({ toolName: 'ggb_build', runId, turnId: 'turn', epoch: 1,
        arguments: { protocolVersion: 2, prompt: 'draw a circle' } })
      expect(result.status).toBe('accepted')
    }
    const blocked = await subject.dispatch({ toolName: 'ggb_build', runId, turnId: 'turn', epoch: 1,
      arguments: { protocolVersion: 2, prompt: 'draw a circle' } })
    expect(blocked).toMatchObject({ status: 'rejected', errors: [{ code: 'build_limit_reached' }] })
    expect(runner.build).toHaveBeenCalledTimes(3)
    subject.resetRun(runId)
    const afterReset = await subject.dispatch({ toolName: 'ggb_build', runId, turnId: 'turn', epoch: 1,
      arguments: { protocolVersion: 2, prompt: 'draw a circle' } })
    expect(afterReset.status).toBe('accepted')
  })

  it('does not consume a build when structural preflight rejects', async () => {
    const runner = {
      check: vi.fn(async (): Promise<PluginCoreRunResult> => ({ ok: true })),
      build: vi.fn()
        .mockResolvedValueOnce({ ok: false, buildPhase: 'preflight', execution: { kind: 'completed', exitCode: 0, signal: null, cleanupConfirmed: true }, error: { code: 'invalid_input', message: 'invalid' } })
        .mockResolvedValue(delivered),
    }
    const subject = new PluginCoreGateway(runner)
    const rejected = await subject.dispatch({ toolName: 'ggb_build', runId, turnId: 'turn', epoch: 1,
      arguments: { protocolVersion: 2, prompt: 'draw a circle' } })
    expect(rejected).toMatchObject({ status: 'rejected',
      errors: [{ code: 'invalid_input' }] })
    for (let index = 0; index < 3; index += 1) {
      const result = await subject.dispatch({ toolName: 'ggb_build', runId, turnId: 'turn', epoch: 1,
        arguments: { protocolVersion: 2, prompt: 'draw a circle' } })
      expect(result.status).toBe('accepted')
    }
    expect(runner.build).toHaveBeenCalledTimes(4)
  })

  it('inspects the Worker base and passes it to check/build', async () => {
    const bases = new PluginCoreBaseRegistry()
    bases.set(runId, { path: '/server/base.ggb', sha256: digest, name: 'base.ggb' }, expect.objectContaining({ buildId: expect.any(String) }))
    const inspect = vi.fn(async () => ({ ok: true, data: { sha256: digest, bytes: 10,
      objects: [{ name: 'A', type: 'point' }] } }))
    const runner = {
      check: vi.fn(async (): Promise<PluginCoreRunResult> => ({ ok: true, check: { ok: true } })),
      build: vi.fn(async (): Promise<PluginCoreRunResult> => delivered),
      inspect,
    }
    const subject = new PluginCoreGateway(runner, { bases })
    const inspected = await subject.dispatch({ toolName: 'ggb_inspect', runId,
      turnId: 'turn', epoch: 1, arguments: { schemaVersion: 1 } })
    expect(inspected).toMatchObject({ status: 'accepted', toolName: 'ggb_inspect',
      result: { sha256: digest, objects: [{ name: 'A', type: 'point' }] } })
    await subject.dispatch({ toolName: 'ggb_check', runId, turnId: 'turn', epoch: 1,
      arguments: { protocolVersion: 2, prompt: 'edit' } })
    expect(runner.check).toHaveBeenCalledWith(expect.anything(), runId, undefined,
      { path: '/server/base.ggb', sha256: digest, name: 'base.ggb' }, expect.objectContaining({ toolName: 'ggb_check' }))
    await subject.dispatch({ toolName: 'ggb_build', runId, turnId: 'turn', epoch: 1,
      arguments: { protocolVersion: 2, prompt: 'edit' } })
    expect(runner.build).toHaveBeenCalledWith(expect.anything(), runId, undefined,
      { path: '/server/base.ggb', sha256: digest, name: 'base.ggb' }, expect.objectContaining({ buildId: expect.any(String) }))
  })

  it.each(['execution', 'missing', 'nonzero', 'signal', 'unclean'] as const)('does not refund an error code with %s phase evidence', async mode => {
    const result = { ok: false, buildPhase: mode === 'execution' ? 'execution' : mode === 'missing' ? undefined : 'preflight',
      execution: { kind: 'completed', exitCode: mode === 'nonzero' ? 1 : 0,
        signal: mode === 'signal' ? 'SIGTERM' : null, cleanupConfirmed: mode !== 'unclean' },
      error: { code: 'invalid_input', message: 'same code can occur after dispatch' } }
    const runner = { check: vi.fn(), build: vi.fn(async () => result) }
    const subject = new PluginCoreGateway(runner as unknown as ConstructorParameters<typeof PluginCoreGateway>[0])
    const call = () => subject.dispatch({ toolName: 'ggb_build', runId, turnId: 'turn', epoch: 1, arguments: {} })
    for (let i = 0; i < 3; i++) expect((await call()).status).toBe('rejected')
    expect(await call()).toMatchObject({ errors: [{ code: 'build_limit_reached' }] })
    expect(runner.build).toHaveBeenCalledTimes(3)
  })

  it('rejects inspect when no base is attached', async () => {
    const { gateway: subject } = gateway()
    const result = await subject.dispatch({ toolName: 'ggb_inspect', runId,
      turnId: 'turn', epoch: 1, arguments: { schemaVersion: 1 } })
    expect(result).toMatchObject({ status: 'rejected', errors: [{ code: 'base_missing' }] })
  })

  it('rejects an unknown tool name', async () => {
    const { gateway: subject } = gateway()
    const result = await subject.dispatch({ toolName: 'plan_submit' as never, runId,
      turnId: 'turn', epoch: 1, arguments: {} })
    expect(result).toMatchObject({ status: 'rejected', errors: [{ code: 'unknown_tool' }] })
  })
})
