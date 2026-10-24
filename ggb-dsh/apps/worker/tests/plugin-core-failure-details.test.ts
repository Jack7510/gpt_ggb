import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runIdSchema } from '@ggb-copilot/application'
import { buildFailure } from '../src/plugin-core/failure-details.js'
import { InstalledPluginCoreRunner } from '../src/plugin-core/installed-runner.js'
import { PluginCoreProcessRunner } from '../src/plugin-core/process-runner.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreEvidenceStore } from '../src/plugin-core/evidence.js'
import { installedRoot } from './fixtures/installed-plugin.js'

const dirs: string[] = []
const fallback = { code: 'plugin_build_execution_failed', message: 'Build failed.' }
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'failure-evidence-')); dirs.push(root)
  return root
}
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('owned build failure projection', () => {
  it('preserves nested expression messages while excluding observations and object dumps', async () => {
    const root = await directory()
    const reason = 'expression unverified: probe returned line (defined=false); expected boolean'
    const check = { requirementId: 'triangle', checkId: 'triangle:3', method: 'expression', status: 'unverified',
      evidence: { message: reason, observation: { type: 'line', defined: false, error: 'private-error' }, objects: ['private-object'] } }
    await writeFile(join(root, 'run.json'), JSON.stringify({ state: 'failed', error: {
      code: 'verification_unverified', message: 'Required checks did not pass', details: { cause: [check] },
    } }))
    const result = await buildFailure(root, fallback, '')
    expect(result).toMatchObject({ details: { failures: [{ details: { cause: [{ evidence: { message: reason } }] } }] } })
    expect(JSON.stringify(result)).not.toMatch(/private-error|private-object|observation|depth_limit/)
  })

  it('keeps raw native returns separate from normalized outputs without leaking host data', async () => {
    const root = await directory()
    for (const actual of [{ rawLabels: null, outputs: null }, { rawLabels: 'A,Z', outputs: ['A', 'Z'] }]) {
      await writeFile(join(root, 'run.json'), JSON.stringify({ state: 'failed', error: {
        code: 'execution_failed', message: 'Native output rejected', details: { cause: {
          stepId: 'F_1', source: 'F_1=Element(Focus(ell),1)', operation: 'outputs',
          actual: { ...actual, token: 'secret-token', path: '/Users/private/runtime' },
        } },
      } }))
      const result = await buildFailure(root, fallback, '')
      expect(result).toMatchObject({ details: { failures: [{ details: { cause: {
        stepId: 'F_1', source: 'F_1=Element(Focus(ell),1)', operation: 'outputs', actual,
      } } }] } })
      expect(JSON.stringify(result)).not.toContain('secret-token')
      expect(JSON.stringify(result)).not.toContain('/Users/private')
    }
  })

  it('keeps the first initial error ahead of cascading checks and redacts its source', async () => {
    const root = await directory()
    const title = join(root, 'title'); await mkdir(title)
    await writeFile(join(title, 'run.json'), JSON.stringify({ state: 'failed', error: {
      code: 'execution_failed', message: 'Initial coordinates left point undefined: A',
      details: { stage: 'execution_failed', cause: { stepId: 'A', source: 'A=Point(d) /Users/private/task',
        operation: 'initial', expected: { outputs: ['A'], coordinates: [-1, 2] },
        actual: { defined: false, objectType: 'point', moveable: true, x: null, y: null } },
      run: '/Users/private/run' } } }))
    await writeFile(join(title, 'verification.json'), JSON.stringify({ results: [
      { checkId: '$canvas:0', status: 'failed', evidence: 'secondary undefined objects' },
    ] }))
    const result = await buildFailure(root, fallback, 'secondary cleanup error')
    expect(result).toMatchObject({ code: 'execution_failed', message: 'Initial coordinates left point undefined: A',
      details: { failures: [{ details: { cause: { stepId: 'A', operation: 'initial',
        source: 'A=Point(d) [server_path]', expected: { coordinates: [-1, 2] },
        actual: { defined: false, objectType: 'point', x: null, y: null } } } }] } })
    expect(JSON.stringify(result)).not.toContain('/Users/private/')
  })
  it('preserves structured receipt issues and CLI fallback when no report exists', async () => {
    const root = await directory()
    expect(await buildFailure(root, fallback, '', [{ code: 'invalid_input', message: 'dx/dy are screen pixels; length >= 20' }]))
      .toMatchObject({ message: 'dx/dy are screen pixels; length >= 20', details: { issues: [{ code: 'invalid_input' }] } })
    expect(await buildFailure(root, fallback, 'Error: poly was not created\n at private stack'))
      .toMatchObject({ message: 'Error: poly was not created' })
  })
  it('extracts run errors and failed verification subjects without raw reports or paths', async () => {
    const root = await directory()
    const title = join(root, 'title'); await mkdir(title)
    await writeFile(join(title, 'run.json'), JSON.stringify({ state: 'failed',
      error: { code: 'execution_failed', message: 'poly was not created\n at private stack',
        details: { stage: 'execution_failed', run: '/Users/private/data', token: 'private-token' } } }))
    await writeFile(join(title, 'verification.json'), JSON.stringify({ construction: {
      objects: [{ name: 'private-object' }], results: [
        { checkId: 'passed', status: 'passed' },
        { requirementId: 'shape', checkId: 'shape:1', subjects: ['poly'], status: 'failed',
          evidence: { expected: 'polygon', actual: null }, token: 'private-token' },
      ] } }))
    const result = await buildFailure(root, fallback, 'Error: poly failed /Users/private/file\n at stack')
    expect(result).toMatchObject({ code: 'execution_failed', message: 'poly was not created',
      details: { failures: [{ details: { stage: 'execution_failed' } }], checks: [{ phase: 'construction',
        checkId: 'shape:1', subjects: ['poly'], evidence: { expected: 'polygon', actual: null } }] } })
    const text = JSON.stringify(result)
    for (const privateValue of ['private-token', 'private-object', '/Users/', 'private stack']) expect(text).not.toContain(privateValue)
  })
  it('retains requirement and method identity when a large failure report is compacted', async () => {
    const root = await directory()
    const title = join(root, 'title'); await mkdir(title)
    await writeFile(join(title, 'run.json'), JSON.stringify({ state: 'failed', error: {
      code: 'verification_failed', message: 'Checks failed', details: { issues: Array.from({ length: 8 }, () => ({
        message: 'x'.repeat(1500), reason: 'y'.repeat(1500), value: 'z'.repeat(1500),
      })) } } }))
    await writeFile(join(title, 'verification.json'), JSON.stringify({ construction: { results: [
      { requirementId: 'shape', checkId: 'shape:2', method: 'perpendicular', status: 'unverified',
        evidence: { message: 'Expected a line: side (segment)' } },
    ] } }))
    const result = await buildFailure(root, fallback, '')
    expect(result.details).toMatchObject({ truncated: true, checks: [{ requirementId: 'shape',
      checkId: 'shape:2', method: 'perpendicular', evidence: { message: 'Expected a line: side (segment)' } }] })
  })

  it('ignores linked, oversized and malformed reports and never reads an external reference', async () => {
    const root = await directory(); const outside = await directory()
    await writeFile(join(outside, 'run.json'), JSON.stringify({ state: 'failed', error: { message: 'external secret' } }))
    await symlink(join(outside, 'run.json'), join(root, 'run.json'))
    await symlink(outside, join(root, 'linked-directory'))
    await writeFile(join(root, 'verification.json'), 'x'.repeat(1024 * 1024 + 1))
    expect(await buildFailure(root, fallback, '')).toMatchObject({ ...fallback, details: { failures: [], checks: [] } })
    await rm(join(root, 'run.json')); await writeFile(join(root, 'run.json'), '{')
    expect(await buildFailure(root, fallback, '')).toMatchObject(fallback)
  })
  it('bounds large failure projections while retaining check identity', async () => {
    const root = await directory()
    await writeFile(join(root, 'verification.json'), JSON.stringify({ results: Array.from({ length: 8 }, (_, i) => ({
      checkId: `shape:${i}`, status: 'failed', subjects: ['poly'],
      evidence: { actual: Array.from({ length: 8 }, () => 'x'.repeat(1500)) },
    })) }))
    const result = await buildFailure(root, fallback, '')
    expect(result).toMatchObject({ details: { truncated: true, checks: [{ checkId: 'shape:0', subjects: ['poly'] },
      ...Array.from({ length: 7 }, () => expect.any(Object))] } })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24 * 1024)
  })
  it.each(['timeout', 'cancelled', 'unconfirmed', 'aborted'] as const)('keeps the %s process boundary despite a domain report', async mode => {
    const root = await directory(); const runId = runIdSchema.parse(`run_${randomUUID()}`)
    const controller = new AbortController()
    vi.spyOn(PluginCoreProcessRunner.prototype, 'spawn').mockImplementation(async args => {
      const context = JSON.parse(await readFile(args[args.indexOf('--context') + 1]!, 'utf8'))
      await writeFile(join(context.outputRoot, 'run.json'), JSON.stringify({ state: 'failed',
        error: { code: 'execution_failed', message: 'must not override process boundary' } }))
      return { kind: mode === 'timeout' || mode === 'cancelled' ? mode : 'completed', stdout: '',
        evidence: { kind: mode === 'timeout' || mode === 'cancelled' ? mode : 'completed',
          cleanupConfirmed: mode !== 'unconfirmed', exitCode: 1, signal: null,
          stdoutBytes: 0, stderrBytes: 0, stderrTail: '', stdoutTail: '' } }
    })
    const runner = await InstalledPluginCoreRunner.load({ pluginRoot: installedRoot, outputRoot: root,
      packageIntegrity: 'a'.repeat(64), state: new PluginCoreExecutionState(root) })
    if (mode === 'aborted') controller.abort()
    const result = await runner.build({}, runId, controller.signal, undefined, { protocolVersion: 3,
      requestId: randomUUID(), toolCallId: randomUUID(), turnId: randomUUID(), epoch: 1,
      runId, buildId: randomUUID(), toolName: 'ggb_build', arguments: {} })
    expect(result.error?.code).toBe('plugin_build_execution_failed')
    expect(JSON.stringify(result.error)).not.toContain('must not override')
    expect(result.execution?.cleanupConfirmed).toBe(mode !== 'unconfirmed')
  })
  it('returns actionable CLI failures through the model boundary and keeps delivery unaccepted', async () => {
    const root = await directory()
    const runId = runIdSchema.parse(`run_${randomUUID()}`); const turnId = randomUUID()
    const evidence = new PluginCoreEvidenceStore(root)
    evidence.begin(runId, turnId, 1, ['secret-provider-value'])
    vi.spyOn(PluginCoreProcessRunner.prototype, 'spawn').mockImplementation(async args => {
      const context = JSON.parse(await readFile(args[args.indexOf('--context') + 1]!, 'utf8'))
      const title = join(context.outputRoot, 'title'); await mkdir(title)
      await writeFile(join(title, 'run.json'), JSON.stringify({ state: 'failed', error: {
        code: 'execution_failed', message: 'poly not created secret-provider-value /Users/private/file',
        details: { stage: 'execution_failed' } } }))
      return { kind: 'completed', stdout: '', evidence: { kind: 'completed', cleanupConfirmed: true,
        exitCode: 1, signal: null, stdoutBytes: 0, stderrBytes: 1, stderrTail: 'Error: poly not created', stdoutTail: '' } }
    })
    const state = new PluginCoreExecutionState(root)
    const runner = await InstalledPluginCoreRunner.load({ pluginRoot: installedRoot, outputRoot: root,
      packageIntegrity: 'a'.repeat(64), state })
    const gateway = new PluginCoreGateway(runner, { state, evidence })
    const result = await gateway.dispatch({ protocolVersion: 3, runId, turnId, epoch: 1,
      requestId: randomUUID(), toolCallId: randomUUID(), toolName: 'ggb_build', arguments: {} })
    expect(result).toMatchObject({ status: 'rejected', errors: [{ code: 'execution_failed',
      message: 'poly not created [redacted] [server_path]' }] })
    expect(state.candidate(runId)).toBeNull()
    expect(JSON.stringify(result)).not.toContain('stderrTail')
    expect(JSON.stringify(result)).not.toContain('secret-provider-value')
    const knowledge = await gateway.dispatch({ protocolVersion: 3, runId, turnId, epoch: 1,
      requestId: randomUUID(), toolCallId: randomUUID(), toolName: 'ggb_inspect', arguments: { reference: 'interactions' } })
    expect(knowledge).toMatchObject({ status: 'accepted', result: { topic: 'interactions' } })
    expect(JSON.stringify(knowledge)).toContain('20')
  })
})
