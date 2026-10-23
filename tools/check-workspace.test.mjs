import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPlan, runChecks } from './check-workspace.mjs'

test('accepts current workspace checks without maintaining a second phase list', () => {
  for (const workspace of ['ggb-dsh']) {
    const manifest = fileURLToPath(new URL(`../${workspace}/package.json`, import.meta.url))
    const { scripts } = JSON.parse(readFileSync(manifest, 'utf8'))
    for (const script of ['check', 'check:fast']) {
      assert.equal(checkPlan(workspace, script, [], scripts).length, scripts[script].split(' && ').length)
    }
  }
})

test('uses existing script order and forwards test arguments without shell interpretation', () => {
  assert.deepEqual(checkPlan('ggb-dsh', 'check', [], { check: 'pnpm run build && pnpm run test' }), [
    { label: 'build', args: ['exec', 'pnpm', 'run', 'build'] },
    { label: 'test', args: ['exec', 'pnpm', 'run', 'test'] },
  ])
  assert.deepEqual(checkPlan('ggb-dsh', 'test', ['a test.ts', '$(false)'], { test: 'vitest run' })[0].args,
    ['exec', 'vitest', 'run', 'a test.ts', '$(false)'])
  assert.throws(() => checkPlan('ggb-shared', 'test', [], {}), /workspace/)
  assert.throws(() => checkPlan('elsewhere', 'test', [], {}), /workspace/)
  assert.throws(() => checkPlan('ggb-dsh', 'verify:plugin-core', [], {}), /offline/)
  assert.throws(() => checkPlan('ggb-dsh', 'check', ['--skip'], { check: 'node check.mjs' }), /arguments/)
  assert.throws(() => checkPlan('ggb-dsh', 'check', [], { check: 'node ok.mjs && node bad.mjs; false' }), /syntax/)
})

test('records success and failure timings and never executes steps after failure', () => {
  const cwd = realpathSync(mkdtempSync(resolve(tmpdir(), 'check-workspace-')))
  try {
    const reportPath = resolve(cwd, 'reports', 'check.json')
    const steps = [
      { label: 'success', args: ['-e', 'if(process.cwd() !== process.argv[1]) process.exit(2)', cwd] },
      { label: 'failure', args: ['-e', 'process.exit(7)'] },
      { label: 'must-not-run', args: ['-e', "require('node:fs').writeFileSync('unexpected', '')"] },
    ]
    assert.equal(runChecks(cwd, steps, reportPath, process.execPath), 7)
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(report.plannedSteps, 3)
    assert.deepEqual(report.steps.map(step => step.exitCode), [0, 7])
    assert.ok(report.steps.every(step => step.durationMs >= 0 && step.startedAt && step.finishedAt))
    assert.ok(report.durationMs >= 0)
    assert.equal(existsSync(resolve(cwd, 'unexpected')), false)
    assert.equal(runChecks(cwd, steps.slice(0, 1), reportPath, process.execPath), 0)
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).steps.length, 1)
    assert.equal(runChecks(cwd, steps, reportPath, resolve(cwd, 'missing-executable')), 1)
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).steps[0].error, 'ENOENT')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
