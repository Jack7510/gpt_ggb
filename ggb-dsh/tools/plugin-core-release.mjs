/** @fileoverview Verifies the distribution, sidecar and both release identities. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Reject an inconsistent release before installation, tests or publication. */
export async function verifyPluginCoreRelease(workspace) {
  const lock = JSON.parse(await readFile(join(workspace, 'vendor/plugin-core.lock.json'), 'utf8'))
  if (!/^ggb-plugins-dsh-[\d.]+\.tgz$/.test(lock.archive)) throw new Error('plugin_core_release_archive_invalid')
  const archive = join(workspace, 'vendor', lock.archive)
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
  if (sha256 !== lock.archiveSha256) throw new Error('plugin_core_archive_digest_mismatch')
  const sidecar = await readFile(`${archive}.sha256`, 'utf8')
  if (sidecar !== `${sha256}  ${lock.archive}\n`) throw new Error('plugin_core_sidecar_digest_mismatch')
  const configuration = JSON.parse(await readFile(join(workspace, 'config/runtime-versions.json'), 'utf8'))
  if (configuration.plugin.archiveSha256 !== sha256) throw new Error('plugin_core_configuration_digest_mismatch')
  return { archive, sha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyPluginCoreRelease(fileURLToPath(new URL('../', import.meta.url)))))
}
