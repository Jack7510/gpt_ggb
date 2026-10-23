import { describe, expect, it } from 'vitest'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { installedRoot } from './fixtures/installed-plugin.js'
import { loadInstalledPlugin } from '../src/plugin-core/installation.js'
import { assertPluginCoreRuntime } from '../src/plugin-core/preflight.js'
const lock = resolve('vendor/plugin-core.lock.json')
describe('installed release admission', () => {
  it('loads the pinned package and exposes the installed SDK patch', async () => {
    const plugin = await loadInstalledPlugin(installedRoot, lock)
    expect(plugin.sdkVersion).toBe('0.2.1-rc.2')
    expect(plugin.serverPatch).toContain('dsh/server.patch.yml')
  })
  it('rejects a replaced package file before importing executable modules', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'tampered-plugin-'))
    try {
      await cp(installedRoot, join(temp, 'plugin'), { recursive: true, dereference: true, filter: path => !relative(installedRoot, path).split('/').some(part => ['node_modules', '.runtime'].includes(part)) })
      await writeFile(join(temp, 'plugin/dsh/server.js'), 'throw new Error("must not execute")')
      await expect(loadInstalledPlugin(join(temp, 'plugin'), lock)).rejects.toThrow('plugin_core_package_integrity_mismatch')
    } finally { await rm(temp, { recursive: true, force: true }) }
  })
  it('rejects an incomplete fingerprint lock before importing the package', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'invalid-plugin-lock-'))
    try {
      const path = join(temp, 'lock.json')
      await writeFile(path, JSON.stringify({ files: {}, archiveSha256: 'a'.repeat(64) }))
      await expect(loadInstalledPlugin(installedRoot, path)).rejects.toThrow('plugin_core_release_lock_invalid')
    } finally { await rm(temp, { recursive: true, force: true }) }
  })
  it('refuses an unprepared runtime without downloading or launching', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'unprepared-plugin-'))
    try {
      const root = join(temp, 'plugin')
      await cp(installedRoot, root, { recursive: true, dereference: true,
        filter: path => !relative(installedRoot, path).split('/').some(part => ['node_modules', '.runtime'].includes(part)) })
      const plugin = await loadInstalledPlugin(root, lock)
      await expect(assertPluginCoreRuntime(plugin, join(temp, 'unused-output'))).rejects.toThrow()
    } finally { await rm(temp, { recursive: true, force: true }) }
  })
})
