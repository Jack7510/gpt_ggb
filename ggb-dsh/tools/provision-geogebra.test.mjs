/** @fileoverview Offline checks for Client runtime compatibility provisioning. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ggb-client-compat-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const ref of ['tools', 'config', 'vendor', 'public/geogebra', 'plugin']) {
    await mkdir(join(directory, ref), { recursive: true })
  }
  await copyFile(join(here, 'provision-geogebra.mjs'), join(directory, 'tools/provision-geogebra.mjs'))
  await writeFile(join(directory, 'config/runtime-versions.json'), JSON.stringify({ geogebra: { version: 'fixture', sha256: 'archive' } }))
  await writeFile(join(directory, 'vendor/plugin-core.lock.json'), JSON.stringify({ archiveSha256: 'unused', files: {} }))
  await writeFile(join(directory, 'public/geogebra/deployggb.js'), 'fixture')
  await writeFile(join(directory, 'public/geogebra-runtime-manifest.json'), JSON.stringify({ version: 'fixture', archiveSha256: 'archive' }))
  await writeFile(join(directory, 'plugin/package.json'), JSON.stringify({
    name: 'ggb-plugins-dsh', type: 'module', exports: { './runtime-compatibility': './compat.js' },
  }))
  await writeFile(join(directory, 'plugin/compat.js'), `
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export async function prepareRuntimeCompatibility(root, version) {
  if (version !== 'fixture') throw new Error('version mismatch')
  await writeFile(join(root, 'prepared'), 'fixed')
  return { id: 'verified-recipe', sha256: 'patched' }
}`)
  const args = [join(directory, 'tools/provision-geogebra.mjs'),
    '--plugin-root', join(directory, 'plugin'), '--public-root', join(directory, 'public')]
  return { directory, args }
}

test('an existing runtime is prepared, recorded and safely reused', async t => {
  const { directory, args } = await fixture(t)
  for (let attempt = 0; attempt < 2; attempt++) {
    await run(process.execPath, args)
    assert.equal(await readFile(join(directory, 'public/geogebra/prepared'), 'utf8'), 'fixed')
    const manifest = JSON.parse(await readFile(join(directory, 'public/geogebra-runtime-manifest.json'), 'utf8'))
    assert.deepEqual(manifest.compatibility, { id: 'verified-recipe', sha256: 'patched' })
  }
})

test('incompatible manifests fail before compatibility writes', async t => {
  const { directory, args } = await fixture(t)
  await writeFile(join(directory, 'public/geogebra-runtime-manifest.json'), JSON.stringify({ version: 'other' }))
  await assert.rejects(run(process.execPath, args), /geogebra_runtime_conflicts/)
  await assert.rejects(readFile(join(directory, 'public/geogebra/prepared')), { code: 'ENOENT' })
})

test('missing public compatibility contract cannot silently supply an unpatched runtime', async t => {
  const { directory, args } = await fixture(t)
  await writeFile(join(directory, 'plugin/package.json'), JSON.stringify({ name: 'ggb-plugins-dsh', exports: {} }))
  await assert.rejects(run(process.execPath, args), /geogebra_compatibility_plugin_required/)
  await assert.rejects(readFile(join(directory, 'public/geogebra/prepared')), { code: 'ENOENT' })
})

test('default installation must match the pinned compatibility module hash', async t => {
  const { directory } = await fixture(t)
  await cp(join(directory, 'plugin'), join(directory, '.plugin-core-runtime/unused'), { recursive: true })
  await writeFile(join(directory, 'vendor/plugin-core.lock.json'), JSON.stringify({
    archiveSha256: 'unused', files: { 'dist/src/runtime-compatibility.js': 'incorrect' },
  }))
  await assert.rejects(run(process.execPath, [join(directory, 'tools/provision-geogebra.mjs'),
    '--public-root', join(directory, 'public')]), /geogebra_compatibility_plugin_integrity_mismatch/)
  await assert.rejects(readFile(join(directory, 'public/geogebra/prepared')), { code: 'ENOENT' })
})
