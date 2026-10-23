import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/plugin-core/host-policy-plugin.js'
import { HOST_DISABLED_PLUGINS, writeHostPolicy } from '../src/plugin-core/host-policy.js'
import { prepareInstalledTests } from '../../../tools/installed-plugin-test-setup.mjs'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const allowed = ['ggb_build', 'ggb_check', 'ggb_inspect', 'ggb_request'].map(name => ({ name }))

describe('host-owned SDK permissions', () => {
  it('owns all disabled plugins and appends a separate execution guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-policy-')); dirs.push(root)
    const patch = JSON.parse(await readFile(await writeHostPolicy(root), 'utf8'))
    expect(patch.filter((entry: { disabled?: boolean }) => entry.disabled).map((entry: { id: string }) => entry.id))
      .toEqual([...HOST_DISABLED_PLUGINS])
    expect(patch.at(-1).insert[0].id).toBe('ggb-host-tool-policy')
  })

  it.each(['extra tool', 'missing tool', 'injected model tool'])('blocks %s before the provider and keeps a monotonic execution guard', async mode => {
    let hook!: (options: { tools?: { name: string }[] }, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>
    let guard!: (execution: { name: string }) => string | undefined
    const registry = mode === 'extra tool' ? [...allowed, { name: 'persistent_bash' }]
      : mode === 'missing tool' ? allowed.slice(1) : allowed
    apply({ tools: { schemas: () => registry, guard(fn) { guard = fn } }, on(_event, fn) { hook = fn } })
    const next = vi.fn(async function* () { yield 'must not reach provider' })
    await expect(async () => {
      for await (const _ of hook({ tools: mode === 'injected model tool' ? [...allowed, { name: 'run_code' }] : allowed }, next)) { /* drain */ }
    }).rejects.toThrow('plugin_core_host_tool_policy_violation')
    expect(next).not.toHaveBeenCalled()
    expect(guard({ name: 'tool_fs' })).toBe('plugin_core_host_tool_not_allowed')
    expect(guard({ name: 'ggb_inspect' })).toBeUndefined()
  })
})

describe('default test installation fails before collecting synthetic receipt tests', () => {
  it.each(['archive', 'fingerprint'])('rejects a corrupt %s rather than silently skipping installation tests', async mode => {
    const { cp, mkdir } = await import('node:fs/promises')
    const root = await mkdtemp(join(tmpdir(), 'bad-vendor-')); dirs.push(root)
    await mkdir(join(root, 'vendor'))
    const lock = JSON.parse(await readFile(resolve('vendor/plugin-core.lock.json'), 'utf8'))
    if (mode === 'archive') await writeFile(join(root, 'vendor', lock.archive), 'broken TGZ')
    else {
      await cp(resolve('vendor', lock.archive), join(root, 'vendor', lock.archive))
      lock.files['dsh/server.js'] = '0'.repeat(64)
    }
    await writeFile(join(root, 'vendor/plugin-core.lock.json'), JSON.stringify(lock))
    await expect(prepareInstalledTests(root)).rejects.toThrow(mode === 'archive'
      ? 'plugin_core_test_archive_digest_mismatch' : 'plugin_core_package_integrity_mismatch')
  })
})
