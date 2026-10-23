import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runIdSchema } from '@ggb-copilot/application'
import { releaseRunFiles, sweepRunFiles } from '../src/plugin-core/retention.js'
import { assertProcessScopeSupported } from '../src/plugin-core/process-scope.js'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
it('removes execution bytes after cleanup and expires only confirmed inactive diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retention-')); dirs.push(root)
  const runId = runIdSchema.parse(`run_${randomUUID()}`)
  const dir = join(root, runId)
  await mkdir(join(dir, 'builds'), { recursive: true })
  await writeFile(join(dir, 'base.ggb'), 'base')
  await writeFile(join(dir, 'diagnostics.json'), 'evidence')
  await releaseRunFiles(root, runId, 1)
  await expect(readFile(join(dir, 'base.ggb'))).rejects.toMatchObject({ code: 'ENOENT' })
  await sweepRunFiles(root, new Set([runId]), Number.MAX_SAFE_INTEGER)
  expect(await readFile(join(dir, 'diagnostics.json'), 'utf8')).toBe('evidence')
  await sweepRunFiles(root, new Set(), Number.MAX_SAFE_INTEGER)
  await expect(readFile(join(dir, 'terminal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('preserves quarantine, unknown cleanup and links outside the output root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retention-')); dirs.push(root)
  for (const mode of ['unknown', 'quarantine', 'link']) {
    const runId = runIdSchema.parse(`run_${randomUUID()}`)
    const dir = join(root, runId)
    if (mode === 'link') { await symlink(root, dir); continue }
    await mkdir(dir)
    await writeFile(join(dir, 'base.ggb'), mode)
    if (mode === 'quarantine') {
      await writeFile(join(dir, 'quarantine.json'), '{}')
      await writeFile(join(dir, 'terminal.json'), JSON.stringify({ runId, cleanupConfirmed: true, expiresAt: 1 }))
      await releaseRunFiles(root, runId)
    }
    await sweepRunFiles(root, new Set(), Number.MAX_SAFE_INTEGER)
    expect(await readFile(join(dir, 'base.ggb'), 'utf8')).toBe(mode)
  }
})
it('refuses unsupported process inventory at startup', async () => {
  await expect(assertProcessScopeSupported('win32')).rejects.toThrow('platform_unsupported')
  await expect(assertProcessScopeSupported('linux', async () => { throw new Error('ENOENT') }))
    .rejects.toThrow('process_inventory_unavailable')
  await expect(assertProcessScopeSupported('linux', async () => [])).resolves.toBeUndefined()
})

it('persists increasing epochs and fences unknown ownership across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'epoch-')); dirs.push(root)
  const runId = runIdSchema.parse(`run_${randomUUID()}`)
  const first = new PluginCoreExecutionState(root)
  expect(await first.acquireEpoch(runId)).toBe(1)
  await first.releaseOwner(runId)
  const restarted = new PluginCoreExecutionState(root)
  expect(await restarted.acquireEpoch(runId)).toBe(2)
  const competing = new PluginCoreExecutionState(root)
  await competing.fenceOrphans()
  expect(await competing.quarantinedCount()).toBe(1)
  await expect(competing.acquireEpoch(runId)).rejects.toThrow('cleanup_failed')
  expect(await competing.quarantinedCount()).toBe(1)
})
