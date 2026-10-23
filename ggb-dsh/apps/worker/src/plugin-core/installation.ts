import { INTERNAL_CHANNEL_PROTOCOL_VERSION } from '@ggb-copilot/application'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface PluginReleaseLock {
  pluginVersion: string; archiveSha256: string; sdkVersion: string; cordisVersion: string
  executorProtocolVersion: number; hostProtocolVersion: number; receiptSchemaVersion: number; channelProtocolVersion: number
  workerSkillSha256: string; playwright: string
  geogebra: { version: string; sha256: string }
  files: Record<string, string>
}
export interface InstalledPlugin {
  root: string; serverPatch: string; sdkVersion: string; packageIntegrity: string
  assertRuntimeReady(): Promise<unknown>
}

/** Verify the release payload before importing any installed executable module. */
export async function loadInstalledPlugin(root: string, lockPath: string): Promise<InstalledPlugin> {
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as PluginReleaseLock
  const required = ['package.json', 'dsh/installation.js', 'dsh/server.patch.yml', 'dsh/server.js',
    'dist/src/host-protocol.js', 'dist/src/draft-requests.js', 'dist/src/draft-arguments.js', 'dist/src/execution-contract.js', 'dist/src/check.js', 'dsh/executor.js', 'dist/src/cli.js', 'skills/ggb-construction/worker.md']
  if (!lock.files || required.some(ref => !/^[a-f0-9]{64}$/.test(lock.files[ref] ?? ''))
    || !/^[a-f0-9]{64}$/.test(lock.archiveSha256)) throw new Error('plugin_core_release_lock_invalid')
  const canonical = await realpath(root)
  for (const [ref, sha256] of Object.entries(lock.files)) {
    if (ref.startsWith('/') || ref.split('/').includes('..')) throw new Error('plugin_core_release_lock_invalid')
    const path = join(canonical, ref)
    if (await realpath(path) !== path || !(await stat(path)).isFile()
      || createHash('sha256').update(await readFile(path)).digest('hex') !== sha256) {
      throw new Error('plugin_core_package_integrity_mismatch')
    }
  }
  const req = createRequire(join(canonical, 'package.json'))
  const module = await import(pathToFileURL(req.resolve('ggb-plugins-dsh/installation')).href)
  const installation = module.loadInstallation()
  const host = createRequire(import.meta.url)
  if (host('@deepseek-ai/dsh-sdk-client/package.json').version !== lock.sdkVersion
    || createRequire(host.resolve('@deepseek-ai/dsh-sdk-client/package.json'))('@deepseek-ai/cordis/package.json').version !== lock.cordisVersion) {
    throw new Error('plugin_core_sdk_identity_mismatch')
  }
  module.assertDshCompatibility(lock.sdkVersion)
  if (installation.pluginVersion !== lock.pluginVersion || installation.workerSkillSha256 !== lock.workerSkillSha256
    || lock.executorProtocolVersion !== 3 || installation.executorProtocolVersion !== lock.executorProtocolVersion
    || installation.hostProtocolVersion !== lock.hostProtocolVersion || installation.receiptSchemaVersion !== lock.receiptSchemaVersion
    || installation.runtimeIdentity.geogebraVersion !== lock.geogebra.version
    || installation.runtimeIdentity.geogebraSha256 !== lock.geogebra.sha256
    || installation.runtimeIdentity.playwrightVersion !== lock.playwright || lock.channelProtocolVersion !== INTERNAL_CHANNEL_PROTOCOL_VERSION) {
    throw new Error('plugin_core_release_identity_mismatch')
  }
  return { root: canonical, serverPatch: installation.serverPatch, sdkVersion: lock.sdkVersion,
    packageIntegrity: lock.archiveSha256, assertRuntimeReady: module.assertRuntimeReady }
}
