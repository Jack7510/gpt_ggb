/** Verify the pinned TGZ and supply its synthetic integration tests by default. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadInstalledPlugin } from '../apps/worker/lib/plugin-core/installation.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))

/** No installation, network, doctor or browser: dependencies come from the frozen workspace. */
export async function prepareInstalledTests(root = workspace, suppliedRoot) {
  const lockPath = join(root, 'vendor/plugin-core.lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const archive = join(root, 'vendor', lock.archive)
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
  if (sha256 !== lock.archiveSha256) throw new Error('plugin_core_test_archive_digest_mismatch')
  const scratch = await mkdtemp(join(tmpdir(), 'ggb-installed-tests-'))
  try {
    const pluginRoot = suppliedRoot ?? join(scratch, 'package')
    if (!suppliedRoot) {
      execFileSync('tar', ['-xzf', archive, '-C', scratch])
      await symlink(join(root, 'node_modules'), join(pluginRoot, 'node_modules'), 'dir')
    }
    await loadInstalledPlugin(pluginRoot, lockPath)
    const require = createRequire(join(pluginRoot, 'package.json'))
    if (require('playwright/package.json').version !== lock.playwright) throw new Error('plugin_core_test_dependency_mismatch')
    return { pluginRoot, cleanup: () => rm(scratch, { recursive: true, force: true }) }
  } catch (error) {
    await rm(scratch, { recursive: true, force: true })
    throw error
  }
}

/** Global setup runs before test collection, including describe.skipIf evaluation. */
export default async function setup(project) {
  const installation = await prepareInstalledTests(workspace, process.env.GGB_PLUGIN_TEST_ROOT)
  project.provide('installedPluginRoot', installation.pluginRoot)
  return installation.cleanup
}
