import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const configuration = JSON.parse(await readFile(join(repositoryRoot, 'config', 'runtime-versions.json'), 'utf8'))
// The applet document fetches `/geogebra/deployggb.js` from the Client origin, so the
// runtime is provisioned into the Client public directory (§9/§10 migration of
// `geogebra-runtime.ts` into `apps/client` resource resolution).
const publicRoot = join(repositoryRoot, 'apps', 'client', 'public')
const targetRoot = join(publicRoot, 'geogebra')
const manifestPath = join(publicRoot, 'geogebra-runtime-manifest.json')

if (existsSync(join(targetRoot, 'deployggb.js')) && existsSync(manifestPath)) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version === configuration.geogebra.version && manifest.archiveSha256 === configuration.geogebra.sha256) {
    console.log(`GeoGebra ${manifest.version} is already provisioned.`)
    process.exit(0)
  }
  throw new Error('geogebra_runtime_conflicts_with_configuration')
}

const temporary = join(tmpdir(), `ggb-runtime-${process.pid}`)
const archive = join(temporary, 'runtime.zip')
const extracted = join(temporary, 'extracted')
mkdirSync(extracted, { recursive: true })

try {
  const response = await fetch(configuration.geogebra.source)
  if (!response.ok) throw new Error(`geogebra_download_failed_${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== configuration.geogebra.sha256) throw new Error('geogebra_archive_digest_mismatch')
  writeFileSync(archive, bytes, { mode: 0o600 })
  const unzip = spawnSync('unzip', ['-q', archive, '-d', extracted], { stdio: 'inherit' })
  if (unzip.error?.code === 'ENOENT') throw new Error('unzip_command_required')
  if (unzip.status !== 0) throw new Error('geogebra_archive_extract_failed')
  if (!existsSync(join(extracted, 'GeoGebra', 'deployggb.js'))
    || !existsSync(join(extracted, 'GeoGebra', 'HTML5', '5.0', 'web3d', 'web3d.nocache.js'))) {
    throw new Error('geogebra_archive_layout_invalid')
  }
  mkdirSync(dirname(targetRoot), { recursive: true })
  if (existsSync(targetRoot)) throw new Error('geogebra_vendor_directory_not_empty')
  // The archive nests the runtime under `GeoGebra/`; strip that level so the applet
  // document's `/geogebra/deployggb.js` URL resolves.
  renameSync(join(extracted, 'GeoGebra'), targetRoot)
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    version: configuration.geogebra.version,
    source: configuration.geogebra.source,
    archiveSha256: digest,
  }, null, 2)}\n`, { mode: 0o644 })
  console.log(`Provisioned GeoGebra ${configuration.geogebra.version} from its verified official archive.`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
