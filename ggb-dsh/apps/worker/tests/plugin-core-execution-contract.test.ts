import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIdSchema, toolArgumentsDigest } from '@ggb-copilot/application'
import { InstalledPluginCoreRunner } from '../src/plugin-core/installed-runner.js'
import { PluginCoreProcessRunner } from '../src/plugin-core/process-runner.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { installedRoot } from './fixtures/installed-plugin.js'

const dirs: string[] = []
const runId = runIdSchema.parse(`run_${randomUUID()}`)
const base = { path: '/private/host/base.ggb', sha256: 'b'.repeat(64) }
const check = { validation: 'structural', mode: 'create', programSteps: 1, requirements: 1, samples: 0 }
const object = { name: 'A', type: 'point', defined: true, dependent: false, moveable: true,
  fixed: false, visible: true, color: '#000000', lineThickness: 1, lineStyle: 0, filling: null,
  labelVisible: true, caption: '', definition: 'x'.repeat(600), value: null, x: 0, y: 0, slider: null }
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function fixture(mutate?: (response: Record<string, unknown>) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'executor-adapter-')); dirs.push(dir)
  const spawn = vi.spyOn(PluginCoreProcessRunner.prototype, 'spawn').mockImplementation(async args => {
    const operation = args[args.indexOf('--operation') + 1]
    const context = JSON.parse(await readFile(args[args.indexOf('--context') + 1]!, 'utf8'))
    const response = { protocolVersion: 3, operation, contextSha256: toolArgumentsDigest(context),
      packageIntegrity: 'a'.repeat(64), phase: operation === 'check' ? 'preflight' : 'execution',
      ok: true, error: null, receipt: null, data: operation === 'check' ? check : {
        sha256: base.sha256, bytes: 123, version: '5.0', entries: ['geogebra.xml'], view: null,
        objects: Array.from({ length: 101 }, (_, i) => ({ ...object, name: 'A' + i })) } }
    mutate?.(response)
    return { kind: 'completed', stdout: JSON.stringify(response), evidence: {
      kind: 'completed', exitCode: 0, cleanupConfirmed: true, signal: null,
      stdoutBytes: 0, stderrBytes: 0, stdoutTail: '', stderrTail: '' } }
  })
  const runner = await InstalledPluginCoreRunner.load({ pluginRoot: installedRoot, outputRoot: dir,
    packageIntegrity: 'a'.repeat(64), state: new PluginCoreExecutionState(dir) })
  return { runner, spawn }
}

describe('installed check/inspect executor contract, no CLI coupling', () => {
  it('uses the public executor and the plugin-owned inspect projection', async () => {
    const { runner, spawn } = await fixture()
    expect(await runner.check({}, runId)).toMatchObject({ ok: true, check })
    const result = await runner.inspect(base, runId)
    expect(result).toMatchObject({ ok: true, data: { truncated: true } })
    const data = result.data as { objects: { definition: string }[] }
    expect(data.objects).toHaveLength(100)
    expect(data.objects[0]!.definition).toHaveLength(500)
    for (const [args] of spawn.mock.calls) {
      expect(args[0]).toContain('dsh/executor.js')
      expect(args).not.toContain('--ggb')
    }
  })
  it.each(['context', 'package', 'operation', 'shape', 'late_shape', 'base', 'version'] as const)('rejects a substituted %s result', async mode => {
    const { runner } = await fixture(response => {
      if (mode === 'context') response.contextSha256 = '0'.repeat(64)
      if (mode === 'package') response.packageIntegrity = '0'.repeat(64)
      if (mode === 'operation') { response.operation = 'check'; response.phase = 'preflight'; response.data = check }
      if (mode === 'shape') response.data = { sha256: base.sha256, objects: [{}] }
      if (mode === 'late_shape') (response.data as { objects: Record<string, unknown>[] }).objects[100]!.visible = 'yes'
      if (mode === 'base') (response.data as { sha256: string }).sha256 = '0'.repeat(64)
      if (mode === 'version') response.protocolVersion = 1
    })
    await expect(runner.inspect(base, runId)).rejects.toThrow()
  })
})
