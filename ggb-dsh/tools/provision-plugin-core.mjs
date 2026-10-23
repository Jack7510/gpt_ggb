#!/usr/bin/env node
/** Install one immutable, hash-verified plugin release outside SDK task homes. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const workspace = fileURLToPath(new URL('../', import.meta.url))
const lock = JSON.parse(await readFile(join(workspace, 'vendor/plugin-core.lock.json'), 'utf8'))
const { values } = parseArgs({ options: { tgz: { type: 'string' }, target: { type: 'string' },
  'verify-only': { type: 'boolean' }, 'dependencies-only': { type: 'boolean' },
  offline: { type: 'boolean' }, browsers: { type: 'string' }, 'runtime-archive': { type: 'string' } } })
const tgz = resolve(values.tgz ?? join(workspace, 'vendor', lock.archive))
const target = resolve(values.target ?? join(workspace, '.plugin-core-runtime', lock.archiveSha256))
if (values.browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(values.browsers)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
if (hash(await readFile(tgz)) !== lock.archiveSha256) throw new Error('plugin_core_archive_digest_mismatch')
if (values['verify-only']) { console.log(JSON.stringify({ ok: true, sha256: lock.archiveSha256 })); process.exit(0) }
try { await access(target); throw new Error('plugin_core_target_exists_choose_new_installation_root') }
catch (error) { if (error.code !== 'ENOENT') throw error }
const parent = resolve(target, '..')
await mkdir(parent, { recursive: true, mode: 0o700 })
const staging = await mkdtemp(join(parent, '.install-'))
try {
  // Only this pinned payload is extracted; no request-supplied archive is trusted.
  execFileSync('tar', ['-xzf', tgz, '-C', staging])
  const packageDir = join(staging, 'package')
  for (const [ref, sha256] of Object.entries(lock.files)) {
    if (hash(await readFile(join(packageDir, ref))) !== sha256) throw new Error('plugin_core_package_integrity_mismatch')
  }
  await copyFile(join(packageDir, 'dependencies.lock'), join(packageDir, 'pnpm-lock.yaml'))
  execFileSync('pnpm', ['--ignore-workspace', 'install', '--prod', '--frozen-lockfile', '--ignore-scripts',
    ...(values.offline ? ['--offline'] : [])], { cwd: packageDir, stdio: 'inherit' })
  // Move before preparing resources: dependency links and browser paths never refer to staging.
  await rename(packageDir, target)
  const req = createRequire(join(target, 'package.json'))
  const installed = await import(pathToFileURL(req.resolve('ggb-plugins-dsh/installation')).href)
  installed.assertDshCompatibility(lock.sdkVersion)
  if (!values['dependencies-only']) {
    if (values.offline && !values['runtime-archive']) throw new Error('plugin_core_offline_runtime_archive_required')
    const playwright = await import(pathToFileURL(req.resolve('playwright')).href)
    const { chromium } = playwright.default ?? playwright
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
      DSH_GGB_BROWSER: chromium.executablePath() }
    if (!values.offline) execFileSync('pnpm', ['exec', 'playwright', 'install', 'chromium'], { cwd: target, env, stdio: 'inherit' })
    execFileSync(process.execPath, [join(target, 'scripts/setup-runtime.mjs'),
      ...(values['runtime-archive'] ? [resolve(values['runtime-archive'])] : [])], { cwd: target, env, stdio: 'inherit' })
    await installed.assertRuntimeReady()
    execFileSync(process.execPath, [installed.loadInstallation().cli, 'doctor'], { cwd: target, env, stdio: 'inherit' })
  }
  const marker = { archiveSha256: lock.archiveSha256, pluginVersion: lock.pluginVersion,
    sdkVersion: lock.sdkVersion, doctor: values['dependencies-only'] ? 'not_run' : 'passed' }
  await writeFile(join(target, 'provisioned.json'), JSON.stringify(marker, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ok: true, target, ...marker }))
} finally { await rm(staging, { recursive: true, force: true }) }
