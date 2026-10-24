/** @fileoverview Release counterexamples and the real vendor updater contract. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { verifyPluginCoreRelease } from './plugin-core-release.mjs'

const workspace = fileURLToPath(new URL('../', import.meta.url))
const archive = JSON.parse(await readFile(join(workspace, 'vendor/plugin-core.lock.json'), 'utf8')).archive
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ggb-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['tools', 'vendor', 'config']) await mkdir(join(root, dir))
  const sha256 = digest('fixture')
  await writeFile(join(root, 'vendor', archive), 'fixture')
  await writeFile(join(root, 'vendor', `${archive}.sha256`), `${sha256}  ${archive}\n`)
  await writeFile(join(root, 'vendor/plugin-core.lock.json'), JSON.stringify({ archive, archiveSha256: sha256 }))
  await writeFile(join(root, 'config/runtime-versions.json'), JSON.stringify({ plugin: { archiveSha256: sha256 } }))
  return root
}

test('the actual vendor payload, sidecar, lock and configuration agree', async () => {
  await verifyPluginCoreRelease(workspace)
  execFileSync('shasum', ['-a', '256', '-c', `${archive}.sha256`], { cwd: join(workspace, 'vendor') })
})

for (const [file, message] of [
  [archive, 'archive_digest_mismatch'], [`${archive}.sha256`, 'sidecar_digest_mismatch'],
  ['plugin-core.lock.json', 'archive_digest_mismatch'],
]) test(`rejects a changed ${file}`, async t => {
  const root = await fixture(t)
  const value = file.endsWith('.json') ? JSON.stringify({ archive, archiveSha256: '0'.repeat(64) }) : 'changed'
  await writeFile(join(root, 'vendor', file), value)
  await assert.rejects(verifyPluginCoreRelease(root), new RegExp(message))
})

test('rejects a configuration which names another payload', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'config/runtime-versions.json'), JSON.stringify({ plugin: { archiveSha256: '0'.repeat(64) } }))
  await assert.rejects(verifyPluginCoreRelease(root), /configuration_digest_mismatch/)
})

test('the real updater publishes a matching checksum sidecar', async t => {
  const root = await fixture(t)
  for (const file of ['update-plugin-core.mjs', 'plugin-core-release.mjs']) {
    await copyFile(join(workspace, 'tools', file), join(root, 'tools', file))
  }
  for (const ref of ['vendor/plugin-core.lock.json', 'config/runtime-versions.json']) {
    await copyFile(join(workspace, ref), join(root, ref))
  }
  execFileSync(process.execPath, [join(root, 'tools/update-plugin-core.mjs'), '--tgz',
    join(workspace, 'vendor', archive), '--source', workspace])
  await verifyPluginCoreRelease(root)
  execFileSync('shasum', ['-a', '256', '-c', `${archive}.sha256`], { cwd: join(root, 'vendor') })
})
