import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginCoreProcessRunner } from '../src/plugin-core/process-runner.js'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function execute(script: string, timeout = 2000) {
  const dir = await mkdtemp(join(tmpdir(), 'process-transport-')); dirs.push(dir)
  const path = join(dir, 'entry.mjs'); await writeFile(path, script)
  return await new PluginCoreProcessRunner().spawn([path], timeout)
}
describe('bounded installed process transport', () => {
  it('waits for stdout close and exposes exact nonzero status instead of trusting JSON', async () => {
    const result = await execute(`process.stderr.write('x'.repeat(80*1024)+'cause');process.stdout.write('{"ok":true}');process.exitCode=7`)
    expect(result.evidence).toMatchObject({ exitCode: 7, cleanupConfirmed: true })
    expect(result.evidence.stderrTail).toHaveLength(64 * 1024)
    expect(result.stdout).toBe('{"ok":true}')
  })
  it('bounds stdout and kills overflow', async () => {
    expect((await execute(`process.stdout.write('x'.repeat(2*1024*1024))`)).evidence.kind).toBe('output_limit')
  })
  it('terminates a timed out process and proves cleanup', async () => {
    expect((await execute('setInterval(()=>{},1000)', 50)).evidence).toMatchObject({ kind: 'timeout', cleanupConfirmed: true })
  })
})
