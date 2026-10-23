#!/usr/bin/env node
import { installedPluginRoot, installedPluginModule } from './local-runtime.mjs'
/**
 * Client-runtime load review for plugin-core deliveries.
 *
 * Starts an isolated API/Worker pair, opens the real Client shell, imports each
 * delivered `.ggb` through the Client's own file control, then reads the live
 * applet facts and writes a screenshot. No Provider call is made.
 *
 * The applet version is pinned by `config/runtime-versions.json`; a delivery
 * that loads in the plugin runtime must also load in the Client applet.
 *
 * Usage:
 *   node tools/plugin-core-client-loading.mjs --dir ../output/plugin-core-integrated-batch
 *   node tools/plugin-core-client-loading.mjs --file a.ggb --file b.ggb --out ../output/review
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { freeLocalPort, startLocalProcesses, workspaceRoot } from './local-runtime.mjs'

const { values } = parseArgs({ options: {
  dir: { type: 'string', multiple: true },
  file: { type: 'string', multiple: true },
  out: { type: 'string' },
  playwright: { type: 'string' },
  'plugin-root': { type: 'string' },
  'expect-version': { type: 'string' },
} })

const inputDirs = (values.dir ?? []).map(dir => resolve(dir))
let files = (values.file ?? []).map(file => resolve(file))
for (const inputDir of inputDirs) {
  const names = (await readdir(inputDir)).filter(name => name.endsWith('.ggb')).sort()
  files.push(...names.map(name => join(inputDir, name)))
}
if (files.length === 0) {
  process.stderr.write('No .ggb files: pass --dir <batch output> or --file <path>.\n')
  process.exit(2)
}

const outputRoot = resolve(values.out
  ?? join(workspaceRoot, '..', 'output', 'plugin-core-client-loading'))
const runtimeVersions = JSON.parse(
  await readFile(join(workspaceRoot, 'config/runtime-versions.json'), 'utf8'))
const expectVersion = values['expect-version'] ?? runtimeVersions.geogebra.version
const pluginRoot = installedPluginRoot(values['plugin-root'])
const playwrightPath = resolve(values.playwright
  ?? process.env.GGB_E2E_PLAYWRIGHT
  ?? installedPluginModule(pluginRoot, 'playwright'))
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const execFileAsync = promisify(execFile)

await mkdir(outputRoot, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'ggb-client-loading-'))
const port = await freeLocalPort()
const runtime = await startLocalProcesses({
  directory,
  port,
  overrides: {
    GGB_AGENT_ENGINE: 'plugin_core',
    GGB_PLUGIN_ROOT: pluginRoot,
    GGB_PLUGIN_CORE_OUTPUT_ROOT: join(outputRoot, 'runs'),
    GGB_PLUGIN_CORE_MAX_CONCURRENT_RUNS: '1',
    GGB_V3_CLIENT_DIST_DIR: join(workspaceRoot, 'apps/client/dist'),
    GGB_V3_GEOGEBRA_ROOT: join(workspaceRoot, 'apps/client/dist/geogebra'),
    GGB_V3_RUNTIME_VERSIONS_PATH: join(workspaceRoot, 'config/runtime-versions.json'),
  },
})

const step = message => process.stderr.write(`[client-loading] ${message}\n`)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(30_000)
page.on('pageerror', error => step(`pageerror: ${error.message}`))
const entries = []
try {
  step(`open http://127.0.0.1:${String(port)}/ (logs: ${directory})`)
  await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-test="new-session"]', { timeout: 60_000 })
  await page.click('[data-test="new-session"]')
  await page.waitForSelector('[data-test="prompt-input"]:not([disabled])', { timeout: 30_000 })
  await page.waitForSelector('iframe', { timeout: 30_000 })
  const frame = await appletFrame(page)
  await waitForApplet(frame)
  step(`applet version ${String(await appletVersion(frame))}`)

  for (const file of files) {
    const name = basename(file, '.ggb')
    step(`import ${name}`)
    const bytes = await readFile(file)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    let expected
    let facts
    let error
    try {
      expected = await inspectFile(file)
      await page.setInputFiles('[data-test="ggb-file"]', file)
      facts = await waitForConstruction(frame)
      if (await importFailed(page)) error = 'client_import_failed'
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const screenshot = join(outputRoot, `${name}.png`)
    await page.screenshot({ path: screenshot })
    const objects = facts?.objects ?? []
    const undefinedObjects = objects.filter(item => item.defined === false).map(item => item.label)
    const expectedNames = (expected?.objects ?? []).map(item => item.name).sort()
    const loadedNames = objects.map(item => item.label).sort()
    const expectedMatches = expected !== undefined
      && expectedNames.join('|') === loadedNames.join('|')
    if (error === undefined && !expectedMatches) error = 'client_object_set_mismatch'
    const passed = error === undefined
      && facts !== undefined
      && facts.version === expectVersion
      && objects.length > 0
      && undefinedObjects.length === 0
    entries.push({
      name,
      file,
      ggbBytes: bytes.length,
      ggbSha256: sha256,
      appletVersion: facts?.version ?? null,
      expectedAppletVersion: expectVersion,
      objectCount: objects.length,
      expectedObjectCount: expectedNames.length,
      expectedMatches,
      objects,
      undefinedObjects,
      error: error ?? null,
      screenshot,
      passed,
    })
    step(`${name}: ${passed ? 'passed' : 'FAILED'} ${String(objects.length)} objects`
      + (facts?.version === expectVersion ? '' : ` version=${String(facts?.version)}`))
  }

  const report = { expectVersion, generatedAt: new Date().toISOString(), entries }
  await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(outputRoot, 'report.md'), reportMarkdown(report))
  process.stdout.write(`${JSON.stringify({
    expectVersion, out: outputRoot,
    passed: entries.filter(item => item.passed).length,
    failed: entries.filter(item => !item.passed).map(item => item.name),
  }, null, 2)}\n`)
  process.exitCode = entries.every(item => item.passed) ? 0 : 1
} finally {
  await page.close()
  await browser.close()
  await runtime.stop()
}

/** The Client mounts the dedicated applet document in a same-origin iframe. */
async function appletFrame(page) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const frame = page.frames().find(item => item.url().includes('geogebra-host.html'))
    if (frame !== undefined) return frame
    await page.waitForTimeout(200)
  }
  throw new Error('applet_frame_missing')
}

async function appletVersion(frame) {
  return await frame.evaluate(() => {
    try { return window.ggbApplet?.getVersion?.() ?? null } catch { return null }
  })
}

/** Wait until GeoGebra reports a loaded applet with its pinned runtime version. */
async function waitForApplet(frame) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const version = await appletVersion(frame)
    if (typeof version === 'string' && version.length > 0) return version
    await frame.page().waitForTimeout(250)
  }
  throw new Error('applet_not_ready')
}

/** Wait for the imported construction to appear and stop changing. */
async function waitForConstruction(frame) {
  const deadline = Date.now() + 120_000
  let previous
  let stableSince = 0
  while (Date.now() < deadline) {
    const facts = await readFacts(frame)
    if (facts !== null && facts.names.length > 0) {
      const signature = facts.names.join('|')
      if (signature === previous) {
        if (stableSince === 0) stableSince = Date.now()
        if (Date.now() - stableSince >= 750) return facts
      } else {
        previous = signature
        stableSince = 0
      }
    }
    await frame.page().waitForTimeout(250)
  }
  throw new Error('construction_load_timeout')
}

/** Recompute the construction, then read each object's public facts. */
async function readFacts(frame) {
  return await frame.evaluate(() => {
    const api = window.ggbApplet
    if (api === undefined || typeof api.getAllObjectNames !== 'function') return null
    try { api.updateConstruction() } catch { /* the applet may still be loading */ }
    const names = api.getAllObjectNames()
    const read = (method, label) => {
      try { return typeof api[method] === 'function' ? api[method](label) : null } catch { return null }
    }
    return {
      version: api.getVersion(),
      names,
      objects: names.map(label => ({
        label,
        type: read('getObjectType', label),
        defined: read('isDefined', label),
        visible: read('getVisible', label),
        color: read('getColor', label),
        filling: read('getFilling', label),
        lineStyle: read('getLineStyle', label),
        lineThickness: read('getLineThickness', label),
        value: read('getValueString', label),
        definition: read('getCommandString', label),
      })),
    }
  })
}

/** The Client reports a rejected import with a fixed notice. */
async function importFailed(page) {
  return await page.getByText('无法导入该 GGB 文件。').count() > 0
}

/** Read the plugin's object set for the same file; the Client must load the same names. */
async function inspectFile(file) {
  const { stdout } = await execFileAsync(process.execPath,
    [installedPluginModule(pluginRoot, 'ggb-plugins-dsh/cli'), 'inspect', '--ggb', file],
    { maxBuffer: 4 * 1024 * 1024 })
  const line = stdout.trim().split('\n').filter(Boolean).at(-1)
  const parsed = line === undefined ? undefined : JSON.parse(line)
  if (parsed?.ok !== true || !Array.isArray(parsed.data?.objects)) {
    throw new Error('plugin_inspect_failed')
  }
  return parsed.data
}

function reportMarkdown(report) {
  const lines = [
    '# Plugin-core Client applet load review',
    '',
    `- Expected applet version: \`${report.expectVersion}\``,
    `- Generated: ${report.generatedAt}`,
    '',
    '| File | Bytes | SHA-256 | Applet | Objects | Expected | Match | Undefined | Result |',
    '| --- | ---: | --- | --- | ---: | ---: | --- | ---: | --- |',
  ]
  for (const item of report.entries) {
    lines.push(`| ${item.name} | ${String(item.ggbBytes)} | \`${item.ggbSha256}\` | `
      + `${String(item.appletVersion)} | ${String(item.objectCount)} | `
      + `${String(item.expectedObjectCount)} | ${item.expectedMatches ? 'yes' : 'no'} | `
      + `${String(item.undefinedObjects.length)} | ${item.passed ? 'passed' : 'FAILED'} |`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
