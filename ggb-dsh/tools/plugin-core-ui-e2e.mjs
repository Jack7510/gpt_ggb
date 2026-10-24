#!/usr/bin/env node
import { installedPluginRoot, installedPluginModule } from './local-runtime.mjs'
/**
 * Authorized PWA acceptance for the integrated plugin-core engine.
 *
 * Starts an isolated API/Worker pair, opens the real Client shell, saves the
 * BYOK key, then drives one or more prompts. Each round waits for the delivery
 * card, downloads the result GGB and reads the run id. The next prompt uses the
 * current canvas automatically.
 *
 * Requires --authorized and DEEPSEEK_API_KEY. The key is typed into the page and
 * is never logged or written to evidence.
 */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  freeLocalPort, startLocalProcesses, workspaceRoot,
} from './local-runtime.mjs'

const runtimeVersion = JSON.parse(await readFile(join(workspaceRoot, 'config/runtime-versions.json'), 'utf8')).geogebra.version

const { values } = parseArgs({ options: {
  authorized: { type: 'boolean' },
  prompt: { type: 'string', multiple: true },
  base: { type: 'string' },
  out: { type: 'string' },
  playwright: { type: 'string' },
  'plugin-root': { type: 'string' },
} })
if (values.authorized !== true) {
  process.stderr.write('Refusing paid Provider calls without --authorized.\n')
  process.exit(2)
}
const prompts = values.prompt ?? []
if (prompts.length === 0) {
  process.stderr.write('Usage: --authorized --prompt "<prompt>" [--prompt ...] [--base file.ggb]\n')
  process.exit(2)
}
const providerKey = process.env.DEEPSEEK_API_KEY
if (providerKey === undefined || providerKey.length === 0) {
  process.stderr.write('DEEPSEEK_API_KEY is required.\n')
  process.exit(2)
}
const outputRoot = resolve(values.out ?? join(workspaceRoot, '..', 'output', 'plugin-core-ui-e2e'))
await mkdir(outputRoot, { recursive: true })
const pluginRoot = installedPluginRoot(values['plugin-root'])
const playwrightPath = resolve(values.playwright
  ?? process.env.GGB_E2E_PLAYWRIGHT
  ?? installedPluginModule(pluginRoot, 'playwright'))
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const directory = await mkdtempSafe()
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
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(30_000)
const step = message => process.stderr.write(`[ui-e2e] ${message}\n`)
page.on('console', message => step(`console ${message.type()}: ${message.text()}`))
page.on('pageerror', error => step(`pageerror: ${error.message}`))
page.on('requestfailed', request =>
  step(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`))
const evidence = []
const completed = new Map()
page.on('response', async response => {
  if (!/\/api\/v3\/plugin-core\/runs\/run_[^/]+$/.test(new URL(response.url()).pathname)) return
  try {
    const view = await response.json()
    if (view.phase === 'completed') completed.set(view.runId, {
      view, authorization: response.request().headers().authorization,
    })
  } catch { /* navigation can abort response reads */ }
})
try {
  step(`open http://127.0.0.1:${String(port)}/ (logs: ${directory})`)
  await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1_500)
  await page.screenshot({ path: join(outputRoot, 'startup.png') })
  step(`startup html bytes: ${String((await page.content()).length)}`)
  await page.waitForSelector('[data-test="new-session"]', { timeout: 60_000 })
  step('save provider key')
  await page.click('[data-test="settings"]')
  await page.fill('.credential-settings input[type="password"]', providerKey)
  await page.locator('.settings-actions button').first().click()
  step('create session')
  await page.click('[data-test="new-session"]')
  await page.waitForSelector('[data-test="prompt-input"]:not([disabled])', { timeout: 30_000 })
  await page.waitForSelector('iframe', { timeout: 30_000 })
  await page.waitForTimeout(1_000)

  if (values.base !== undefined) {
    await page.setInputFiles('[data-test="ggb-file"]', resolve(values.base))
    await page.waitForTimeout(1_000)
  }

  for (const [index, prompt] of prompts.entries()) {
    const previousRun = await lastRunId(page)
    step(`round ${String(index + 1)}: ${prompt}`)
    await page.fill('[data-test="prompt-input"]', prompt)
    await page.click('[data-test="send"]')
    step(`round ${String(index + 1)}: sent, waiting for run id`)
    await page.waitForFunction(previous => {
      const nodes = [...document.querySelectorAll('[data-test="run-id"]')]
      return nodes.length > 0 && nodes.at(-1)?.textContent !== previous
    }, previousRun, { timeout: 14 * 60_000 })
    const runId = await lastRunId(page)
    const selector = `[data-test="plugin-delivery"][data-run-id="${runId ?? ''}"]`
    await Promise.race([
      page.waitForSelector(selector, { timeout: 14 * 60_000 }),
      page.waitForSelector('[data-test="notice"].error', { timeout: 14 * 60_000 }).then(async node => {
        throw new Error(await node.innerText())
      }),
    ])
    step(`round ${String(index + 1)}: delivered ${String(runId)}`)
    const card = page.locator(selector)
    const cardText = await card.innerText()
    const cardSha256Prefix = (await card.locator('.message-run').innerText()).trim()
    const cardBytes = Number((/^([\d,]+) bytes/m.exec(cardText)?.[1] ?? '').replaceAll(',', ''))
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await card.locator('[data-test="download-ggb"]').click()
    const download = await downloadPromise
    const file = join(outputRoot, `round-${String(index + 1)}.ggb`)
    await download.saveAs(file)
    const bytes = await readFile(file)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    assert.equal(cardBytes, bytes.length)
    assert(sha256.startsWith(cardSha256Prefix))
    const loaded = await verifyLoadedDelivery(page, runId, completed, sha256)
    const screenshot = join(outputRoot, `round-${String(index + 1)}.png`)
    await page.screenshot({ path: screenshot })
    evidence.push({
      round: index + 1,
      loaded,
      prompt,
      runId,
      cardText,
      cardBytes,
      cardSha256Prefix,
      ggbBytes: bytes.length,
      ggbSha256: sha256,
      cardMatchesDownload: Number.isFinite(cardBytes) && cardBytes === bytes.length
        && sha256.startsWith(cardSha256Prefix),
      ggbFile: file,
      screenshot,
    })
  }
  await writeFile(join(outputRoot, 'evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
} catch (error) {
  const message = String(error?.message ?? error).replaceAll(providerKey, '[redacted]')
  await page.screenshot({ path: join(outputRoot, 'failure.png') }).catch(() => undefined)
  await writeFile(join(outputRoot, 'failure.json'), JSON.stringify({ passed: false,
    runId: await lastRunId(page).catch(() => null), error: message, evidence }, null, 2), { mode: 0o600 })
  throw error
} finally {
  await page.close()
  await browser.close()
  await runtime.stop()
}

async function lastRunId(page) {
  const nodes = page.locator('[data-test="run-id"]')
  const count = await nodes.count()
  return count === 0 ? null : await nodes.nth(count - 1).textContent()
}

async function mkdtempSafe() {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  return await mkdtemp(join(tmpdir(), 'ggb-plugin-core-ui-'))
}

/** Verify receipt identity, original bytes and the actual live Client applet. */
async function verifyLoadedDelivery(current, runId, completed, sha256) {
  const entry = completed.get(runId)
  assert(entry, 'Completed authenticated run view was not observed')
  const { view, authorization } = entry
  assert.equal(view.delivery.trustedBuild.binding.runId, runId)
  assert.equal(view.delivery.cleanup.confirmed, true)
  const result = view.delivery.artifacts.find(item => item.kind === 'result_ggb')
  assert.equal(result.sha256, sha256)
  const meta = view.delivery.artifacts.find(item => item.kind === 'manifest')
  const response = await current.request.get(
    new URL(`/api/v3/plugin-core/runs/${runId}/artifacts/${meta.artifactId}`, current.url()).href,
    { headers: { authorization } })
  assert(response.ok())
  const manifest = await response.json()
  const names = manifest.objects.map(item => item.name).sort()
  const frame = current.frames().find(item => item.url().includes('geogebra-host.html'))
  assert(frame)
  await frame.waitForFunction(expected => {
    const api = window.ggbApplet
    return JSON.stringify(api.getAllObjectNames().sort()) === JSON.stringify(expected)
      && expected.every(name => api.isDefined(name))
  }, names)
  const facts = await frame.evaluate(() => {
    const api = window.ggbApplet
    return { version: api.getVersion(), objects: api.getAllObjectNames().map(name => ({
      name, defined: api.isDefined(name), type: api.getObjectType(name),
    })) }
  })
  assert.equal(facts.version, runtimeVersion)
  return { ...facts, manifestObjects: manifest.objects, trustedReceipt: true }
}
