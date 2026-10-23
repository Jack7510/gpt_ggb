import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runIdSchema } from '@ggb-copilot/application'
import { PluginCoreProcessRunner } from '../src/plugin-core/process-runner.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { PluginCoreService } from '../src/plugin-core/service.js'
import type { PluginCoreDshRunner } from '../src/plugin-core/dsh-runner.js'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('execution ownership and slot quarantine', () => {
  it('cancels a real process tree including an observed detached descendant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'process-tree-')); dirs.push(dir)
    const pidFile = join(dir, 'pid')
    const script = join(dir, 'runner.mjs')
    await writeFile(script, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)
    const abort = new AbortController()
    const result = new PluginCoreProcessRunner()
      .spawn([script], 5000, abort.signal)
    let pid = 0
    for (let i = 0; i < 80; i++) {
      try { pid = Number(await readFile(pidFile, 'utf8')); break } catch { await new Promise(r => setTimeout(r, 10)) }
    }
    expect(pid).toBeGreaterThan(0)
    await new Promise(r => setTimeout(r, 150)) // ownership snapshot before cancellation
    abort.abort()
    const outcome = await result
    expect(outcome.evidence).toMatchObject({ kind: 'cancelled', cleanupConfirmed: true })
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)

  it('rejects an admission/Worker contract mismatch before executing a model turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contract-fence-')); dirs.push(dir)
    const run = vi.fn()
    const service = new PluginCoreService({ run } as unknown as PluginCoreDshRunner, { outputRoot: dir })
    const result = await service.run({ runId: runIdSchema.parse(`run_${randomUUID()}`),
      deliveryContract: 'legacy', providerKey: 'fake', prompt: 'fake' })
    expect(result.error?.code).toBe('plugin_core_contract_mismatch')
    expect(run).not.toHaveBeenCalled()
  })

  it('persists quarantine and refuses a new slot after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slot-quarantine-')); dirs.push(dir)
    const first = runIdSchema.parse(`run_${randomUUID()}`)
    const state = new PluginCoreExecutionState(dir)
    const dsh = { run: async () => { throw new Error('plugin_core_cleanup_failed') } } as unknown as PluginCoreDshRunner
    const service = new PluginCoreService(dsh, { outputRoot: dir, state })
    const failed = await service.run({ runId: first, deliveryContract: 'receipt-v1', providerKey: 'fake', prompt: 'fake' })
    expect(failed.error?.code).toBe('plugin_core_cleanup_failed')
    expect(failed.cleanup?.confirmed).toBe(false)
    const restarted = new PluginCoreService(dsh, { outputRoot: dir })
    const blocked = await restarted.run({ runId: runIdSchema.parse(`run_${randomUUID()}`), deliveryContract: 'receipt-v1', providerKey: 'fake', prompt: 'fake' })
    expect(blocked.error?.code).toBe('plugin_core_busy')
    expect(JSON.parse(await readFile(join(dir, first, 'quarantine.json'), 'utf8')).runId).toBe(first)
  })
})
