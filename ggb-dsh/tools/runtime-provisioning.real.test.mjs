/** @fileoverview Validates official ZIPs and real compatibility exports; no model requests. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const workspace = fileURLToPath(new URL('../', import.meta.url))
const config = JSON.parse(await readFile(join(workspace, 'config/runtime-versions.json'), 'utf8'))
const lock = JSON.parse(await readFile(join(workspace, 'vendor/plugin-core.lock.json'), 'utf8'))
const installed = join(workspace, '.plugin-core-runtime', lock.archiveSha256)
const require = createRequire(join(installed, 'package.json'))
const compatibility = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/runtime-compatibility')).href)
const archives = resolve(process.env.GGB_RUNTIME_ARCHIVES ?? '../output/runtime-release-20261024/archives')
const output = resolve(process.env.GGB_RUNTIME_EVIDENCE ?? '../output/runtime-release-20261024')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function files(root, prefix = '') {
  const entries = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const ref = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) entries.push(...Object.entries(await files(root, ref)))
    else if (entry.isFile()) entries.push([ref, hash(await readFile(join(root, ref)))])
    else throw new Error('Unexpected official archive symlink')
  }
  return Object.fromEntries(entries)
}

for (const runtime of new Map([config.plugin.geogebra, config.geogebra].map(runtime => [runtime.version, runtime])).values()) {
  test(`official ${runtime.version} ZIP changes exactly one asset`, async t => {
    const archive = join(archives, `geogebra-${runtime.version}.zip`)
    assert.equal(hash(await readFile(archive)), runtime.sha256)
    const scratch = await mkdtemp(join(tmpdir(), 'ggb-official-'))
    t.after(() => rm(scratch, { recursive: true, force: true }))
    execFileSync('unzip', ['-q', archive, '-d', scratch])
    const root = join(scratch, 'GeoGebra')
    const before = await files(root)
    const identity = await compatibility.prepareRuntimeCompatibility(root, runtime.version)
    assert.equal(before[identity.asset], identity.originalSha256)
    const after = await files(root)
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
    assert.deepEqual(Object.keys(after).filter(ref => after[ref] !== before[ref]), [identity.asset])
    assert.equal(after[identity.asset], identity.patchedSha256)
    assert.deepEqual(await compatibility.prepareRuntimeCompatibility(root, runtime.version), identity)
    assert.deepEqual(await files(root), after)
    await assert.rejects(compatibility.prepareRuntimeCompatibility(root, '5.4.999.1'), /version_unsupported/)
    await writeFile(join(root, identity.asset), 'partial')
    await assert.rejects(compatibility.prepareRuntimeCompatibility(root, runtime.version), /asset_mismatch/)
    assert.equal(await readFile(join(root, identity.asset), 'utf8'), 'partial')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, `official-${runtime.version}.json`), JSON.stringify({
      archiveSha256: runtime.sha256, identity, files: Object.keys(before).length,
      changed: [identity.asset], idempotent: true, invalidAssetRejected: true,
    }, null, 2))
  })
}

test('Client supplies from a verified ZIP through the default installed public contract', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'ggb-client-fresh-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const command = [join(workspace, 'tools/provision-geogebra.mjs'), '--public-root', scratch,
    '--runtime-archive', join(archives, `geogebra-${config.geogebra.version}.zip`)]
  for (let attempt = 0; attempt < 2; attempt++) execFileSync(process.execPath, command)
  const manifest = JSON.parse(await readFile(join(scratch, 'geogebra-runtime-manifest.json'), 'utf8'))
  assert.deepEqual(manifest.compatibility, config.geogebra.compatibility)
  assert.equal(hash(await readFile(join(scratch, 'geogebra', manifest.compatibility.asset))), manifest.compatibility.patchedSha256)
  // Interrupted metadata publication can be resumed against already patched bytes.
  await writeFile(join(scratch, 'geogebra-runtime-manifest.json'), JSON.stringify({ ...manifest, compatibility: { id: 'old' } }))
  execFileSync(process.execPath, command)
  assert.deepEqual(JSON.parse(await readFile(join(scratch, 'geogebra-runtime-manifest.json'), 'utf8')), manifest)
  const corrupt = join(scratch, 'corrupt.zip')
  await writeFile(corrupt, 'corrupt')
  assert.throws(() => execFileSync(process.execPath, [command[0], '--public-root', join(scratch, 'bad'),
    '--runtime-archive', corrupt], { stdio: 'pipe' }), /geogebra_archive_digest_mismatch/)
  assert.equal((await readdir(join(scratch, 'bad'))).length, 0)
})

test('default installation marker and doctor bind the synchronized TGZ', async () => {
  const marker = JSON.parse(await readFile(join(installed, 'provisioned.json'), 'utf8'))
  assert.equal(marker.archiveSha256, lock.archiveSha256)
  assert.equal(marker.doctor, 'passed')
  for (const ref of ['dist/src/atomic-file.js', 'dist/src/runtime-compatibility.js']) {
    assert.equal(hash(await readFile(join(installed, ref))), lock.files[ref])
  }
  const result = JSON.parse(execFileSync(process.execPath, [require.resolve('ggb-plugins-dsh/cli'), 'doctor'], { encoding: 'utf8',
    env: { ...process.env, DSH_GGB_BROWSER: require('playwright').chromium.executablePath() } }))
  assert.equal(result.ok, true)
  assert.equal(result.data.pathSmoke, 'passed')
  assert.deepEqual(result.data.runtime.compatibility, lock.geogebra.compatibility)
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'default-doctor.json'), JSON.stringify(result, null, 2))
})
