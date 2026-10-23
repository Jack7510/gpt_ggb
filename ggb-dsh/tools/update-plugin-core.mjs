/** @fileoverview Pins a locally built TGZ, its exact inputs and runtime audit identities. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const workspace = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({ options: { tgz: { type: 'string' }, source: { type: 'string' } } })
if (!values.tgz || !values.source) throw new Error('Expected --tgz <built TGZ> --source <plugin checkout>')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const lockPath = join(workspace, 'vendor/plugin-core.lock.json')
const old = await json(lockPath)
const scratch = await mkdtemp(join(tmpdir(), 'ggb-vendor-update-'))

async function fingerprint(root, prefix = '') {
  const entries = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const ref = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) entries.push(...await fingerprint(root, ref))
    else if (entry.isFile()) entries.push([ref, hash(await readFile(join(root, ref)))])
    else throw new Error(`Unsupported package entry: ${ref}`)
  }
  return entries
}

try {
  const bytes = await readFile(resolve(values.tgz))
  execFileSync('tar', ['-xzf', resolve(values.tgz), '-C', scratch])
  const root = join(scratch, 'package')
  const installed = await import(pathToFileURL(join(root, 'dsh/installation.js')).href)
  const compatibility = await import(pathToFileURL(join(root, 'dist/src/runtime-compatibility.js')).href)
  const identity = installed.loadInstallation()
  installed.assertDshCompatibility(old.sdkVersion)
  const files = Object.fromEntries((await fingerprint(root)).sort(([a], [b]) => a.localeCompare(b)))
  const source = resolve(values.source)
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
  const sourceDirty = execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim().length > 0
  const sourceFiles = Object.fromEntries(Object.entries(files).filter(([ref]) => ref.startsWith('source/')))
  const geogebra = await json(join(root, 'runtime.lock.json'))
  const lock = { ...old, sourceCommit, sourceDirty, distribution: 'development-build',
    pluginVersion: identity.pluginVersion, archive: `ggb-plugins-dsh-${identity.pluginVersion}.tgz`,
    archiveSha256: hash(bytes), files, workerSkillSha256: identity.workerSkillSha256,
    executorProtocolVersion: identity.executorProtocolVersion,
    sourceSnapshotSha256: hash(JSON.stringify(sourceFiles)),
    geogebra: { version: geogebra.version, sha256: geogebra.sha256, url: geogebra.url,
      compatibility: compatibility.runtimeCompatibility(geogebra.version) } }
  const configurationPath = join(workspace, 'config/runtime-versions.json')
  const configuration = await json(configurationPath)
  configuration.updatedAt = '2026-10-24'
  configuration.geogebra.compatibility = compatibility.runtimeCompatibility(configuration.geogebra.version)
  Object.assign(configuration.plugin, { archiveSha256: lock.archiveSha256, pluginVersion: lock.pluginVersion,
    geogebra: lock.geogebra })
  await compatibility.writeAtomicFile(join(workspace, 'vendor', lock.archive), bytes)
  await compatibility.writeAtomicFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  await compatibility.writeAtomicFile(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`)
  console.log(JSON.stringify({ archive: lock.archive, sha256: lock.archiveSha256, sourceCommit, sourceDirty }))
} finally { await rm(scratch, { recursive: true, force: true }) }
