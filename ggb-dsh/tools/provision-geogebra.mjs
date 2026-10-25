/** @fileoverview Supplies Client engine assets and verified plugin compatibility fixes. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, realpath, mkdtemp, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const configuration = JSON.parse(await readFile(join(repositoryRoot, 'config', 'runtime-versions.json'), 'utf8'))
// The applet document fetches `/geogebra/deployggb.js` from the Client origin, so the
// runtime is provisioned into the Client public directory (§9/§10 migration of
// `geogebra-runtime.ts` into `apps/client` resource resolution).
const { values } = parseArgs({ options: {
  'plugin-root': { type: 'string' }, 'public-root': { type: 'string' },
  'runtime-archive': { type: 'string' },
} })
const publicRoot = resolve(values['public-root'] ?? join(repositoryRoot, 'apps', 'client', 'public'))
const targetRoot = join(publicRoot, 'geogebra')
const manifestPath = join(publicRoot, 'geogebra-runtime-manifest.json')
const lock = values['plugin-root'] ? null
  : JSON.parse(await readFile(join(repositoryRoot, 'vendor/plugin-core.lock.json'), 'utf8'))
const pluginRoot = resolve(values['plugin-root'] ?? join(repositoryRoot, '.plugin-core-runtime', lock.archiveSha256))
const require = createRequire(join(pluginRoot, 'package.json'))
let compatibilityModule
try { compatibilityModule = require.resolve('ggb-plugins-dsh/runtime-compatibility') }
catch { throw new Error('geogebra_compatibility_plugin_required: provision the updated plugin, or pass --plugin-root for a development installation') }
if (!values['plugin-root']) {
  const canonical = await realpath(pluginRoot)
  if (compatibilityModule !== join(canonical, 'dist/src/runtime-compatibility.js')) throw new Error('geogebra_compatibility_plugin_integrity_mismatch')
  for (const ref of ['dist/src/runtime-compatibility.js', 'dist/src/atomic-file.js']) {
    const expected = lock.files[ref]
    const path = join(canonical, ref)
    const actual = createHash('sha256').update(await readFile(path)).digest('hex')
    if (!expected || actual !== expected || await realpath(path) !== path) throw new Error('geogebra_compatibility_plugin_integrity_mismatch')
  }
}
const { prepareRuntimeCompatibility, writeAtomicFile } = await import(pathToFileURL(compatibilityModule).href)

if (existsSync(join(targetRoot, 'deployggb.js')) && existsSync(manifestPath)) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version === configuration.geogebra.version && manifest.archiveSha256 === configuration.geogebra.sha256) {
    const compatibility = await prepareRuntimeCompatibility(targetRoot, manifest.version)
    await writeAtomicFile(manifestPath, `${JSON.stringify({ ...manifest, compatibility }, null, 2)}\n`)
    console.log(`GeoGebra ${manifest.version} is provisioned with ${compatibility.patchId}.`)
    process.exit(0)
  }
  throw new Error('geogebra_runtime_conflicts_with_configuration')
}

await mkdir(publicRoot, { recursive: true })
const temporary = await mkdtemp(join(publicRoot, '.geogebra-'))
const archive = join(temporary, 'runtime.zip')
const extracted = join(temporary, 'extracted')
mkdirSync(extracted, { recursive: true })

try {
  let bytes
  if (values['runtime-archive']) bytes = await readFile(resolve(values['runtime-archive']))
  else {
    const response = await fetch(configuration.geogebra.source)
    if (!response.ok) throw new Error(`geogebra_download_failed_${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
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
  const compatibility = await prepareRuntimeCompatibility(join(extracted, 'GeoGebra'), configuration.geogebra.version)
  mkdirSync(dirname(targetRoot), { recursive: true })
  if (existsSync(targetRoot)) throw new Error('geogebra_vendor_directory_not_empty')
  // The archive nests the runtime under `GeoGebra/`; strip that level so the applet
  // document's `/geogebra/deployggb.js` URL resolves.
  renameSync(join(extracted, 'GeoGebra'), targetRoot)
  await writeAtomicFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    version: configuration.geogebra.version,
    source: configuration.geogebra.source,
    archiveSha256: digest,
    compatibility,
  }, null, 2)}\n`)
  console.log(`Provisioned GeoGebra ${configuration.geogebra.version} from its verified official archive.`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
