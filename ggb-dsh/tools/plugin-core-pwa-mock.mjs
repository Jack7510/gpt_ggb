#!/usr/bin/env node
/** Real PWA/HTTP/SSE/GeoGebra acceptance; only the model Harness is substituted. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { composeWorker } from '../apps/worker/lib/composition.js'
import { composeApi } from '../apps/api/lib/composition.js'
import { freeLocalPort, installedPluginRoot, installedPluginModule, workspaceRoot } from './local-runtime.mjs'

const runtimeVersion = JSON.parse(await readFile(join(workspaceRoot, 'config/runtime-versions.json'), 'utf8')).geogebra.version

const { values } = parseArgs({ options: { authorized: { type: 'boolean' }, out: { type: 'string' },
  'plugin-root': { type: 'string' } } })
assert(values.authorized, 'Pass --authorized to run real local GeoGebra and Chromium (no Provider).')
const parent = resolve(values.out ?? join(workspaceRoot, '..', 'output/playwright/installed-plugin-e-pwa'))
await mkdir(parent, { recursive: true })
const output = await mkdtemp(join(parent, 'run-'))
const scratch = await mkdtemp(join(tmpdir(), 'ggb-pwa-'))
const pluginRoot = installedPluginRoot(values['plugin-root'])
const load = name => import(pathToFileURL(installedPluginModule(pluginRoot, name)).href)
const playwright = await load('playwright')
const { chromium } = playwright.default ?? playwright
const { createTool } = await load('ggb-plugins-dsh/server')
const digest = value => createHash('sha256').update(value).digest('hex')
const port = await freeLocalPort()
const origin = `http://127.0.0.1:${port}`
const secret = randomBytes(32).toString('hex')
let releaseFirst
const firstGate = new Promise(resolveGate => { releaseFirst = resolveGate })
let harnessCalls = 0
const toolResults = []
const requests = []
const streams = []
const views = new Map()
const externalRequests = []
const pageErrors = []
const directrixStages = []
const plans = [
  { protocolVersion: 2, prompt: 'Create point P, parabola p:y^2=4x, directrix d and point A on d', locale: 'en', plan: {
    program: [
      { op: 'native', id: 'P', source: 'P=(0,0)', mode: 'algebra' },
      { op: 'native', id: 'p', source: 'p:y^2=4x', mode: 'algebra' },
      { op: 'native', id: 'd', source: 'd=Directrix(p)', mode: 'algebra' },
      { op: 'native', id: 'A', source: 'A=Point(d)', mode: 'algebra', initial: [-1, 2] },
    ],
    requirements: [
      { id: 'p', source: 'point P', checks: [{ kind: 'exists', subjects: ['P'], scope: 'initial' }] },
      { id: 'path', source: 'point A on d', checks: [
        { kind: 'pointOn', subjects: ['A', 'd'], scope: 'sampled' },
        { kind: 'dependsOn', subjects: ['A', 'd', 'p'], scope: 'sampled' },
      ] },
    ], interactions: [{ point: 'A', dx: 0, dy: 30 }],
    styles: ['p', 'd'].map(object => ({ object, properties: { labelVisible: false } })),
    view: { xMin: -5, xMax: 5, yMin: -4, yMax: 5 },
  } },
  { protocolVersion: 2, prompt: 'Create Q=(1,1), keep P', locale: 'en', plan: {
    program: [{ op: 'native', id: 'Q', source: 'Q=(1,1)', mode: 'algebra', outputs: ['Q'] }],
    requirements: [{ id: 'q', source: 'Q=(1,1)', checks: [{ kind: 'exists', subjects: ['Q'], scope: 'initial' }] }], interactions: [] } },
]
const env = { PORT: String(port), GGB_V3_LISTEN_HOST: '127.0.0.1', GGB_V3_SERVER_PEPPER: secret,
  GGB_V3_WORKER_SECRET: secret, GGB_V3_WORKER_SOCKET_PATH: join(scratch, 'worker.sock'),
  GGB_PLUGIN_CORE_TOOL_SOCKET: join(scratch, 'tool.sock'), GGB_PLUGIN_ROOT: pluginRoot,
  GGB_V3_DSH_WORKSPACE_ROOT: workspaceRoot, GGB_V3_DSH_HOME_ROOT: join(scratch, 'homes'),
  GGB_PLUGIN_CORE_OUTPUT_ROOT: join(output, 'runs'), GGB_V3_SQLITE_PATH: join(output, 'runs.sqlite'),
  GGB_V3_PROVIDER_BASE_URL: 'http://127.0.0.1:1', GGB_V3_SSE_POLL_MS: '50',
  GGB_V3_CLIENT_DIST_DIR: join(workspaceRoot, 'apps/client/dist'),
  GGB_V3_GEOGEBRA_ROOT: join(workspaceRoot, 'apps/client/dist/geogebra'),
  GGB_V3_RUNTIME_VERSIONS_PATH: join(workspaceRoot, 'config/runtime-versions.json') }
let worker
let api
let http
let browser
let page
let report
const step = message => process.stderr.write(`[pwa-mock] ${message}\n`)
try {
  worker = await composeWorker(env, { createHarness: options => {
    const abort = new AbortController()
    return { close: async () => { abort.abort(); releaseFirst() }, run: async () => {
      const index = harnessCalls++
      assert(index < plans.length, 'Unexpected additional model execution')
      if (index === 0) await firstGate
      const previous = new Map()
      for (const [key, value] of Object.entries(options.env)) {
        if (!key.startsWith('GGB_PLUGIN_CORE_TOOL_')) continue
        previous.set(key, process.env[key]); process.env[key] = value
      }
      try {
        const call = (name, args) => createTool(name).execute(args, { signal: abort.signal })
        const plan = plans[index]
        const references = await call('ggb_inspect', { references: ['request', 'program', 'verification'] })
        assert.equal(references.status, 'accepted', JSON.stringify(references))
        const saved = await call('ggb_request', { requestText: JSON.stringify({ plan: plan.plan }), locale: plan.locale })
        assert.equal(saved.status, 'accepted', JSON.stringify(saved))
        const revision = saved.result.revision
        const checked = await call('ggb_check', { revision })
        assert.equal(checked.status, 'accepted', JSON.stringify(checked))
        const result = await call('ggb_build', { checkedRequestId: checked.result.checkedRequestId })
        toolResults.push(result)
        assert.equal(result.status, 'accepted', JSON.stringify(result))
        return { finalResponse: 'Mock Harness; real GeoGebra build completed.',
          events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] }
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value
        }
      }
    } }
  } })
  await worker.start()
  api = composeApi(env)
  http = await api.start()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(origin + '/')) return route.continue()
    externalRequests.push(new URL(url).origin)
    return route.abort()
  })
  page = await context.newPage()
  page.setDefaultTimeout(60_000)
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/events')) streams.push({ runId: url.pathname.split('/').at(-2), after: Number(url.searchParams.get('after')) })
    if (request.method() === 'POST' && url.pathname === '/api/v3/plugin-core/runs') {
      const body = request.postDataJSON()
      requests.push({ runId: body.runId, hasBase: body.base !== null,
        baseBytes: body.base ? Buffer.from(body.base.dataBase64, 'base64').length : 0,
        baseSha256: body.base ? digest(Buffer.from(body.base.dataBase64, 'base64')) : null })
    }
  })
  page.on('response', async response => {
    if (!/\/api\/v3\/plugin-core\/runs\/run_[^/]+$/.test(new URL(response.url()).pathname)) return
    try { const view = await response.json(); if (view.runId) views.set(view.runId, view) } catch { /* page reload aborts in-flight reads */ }
  })
  step(`open ${origin}; evidence ${output}`)
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-test="settings"]').click()
  await page.locator('.credential-settings input[type="password"]').fill('mock-key-never-sent-to-provider')
  await page.locator('.settings-actions button').first().click()
  await page.locator('[data-test="new-session"]').click()
  await applet(page)
  await send(plans[0].prompt)
  await until(async () => requests.length === 1 && harnessCalls === 1)
  const firstRun = requests[0].runId
  assert.equal(requests[0].hasBase, false)
  const cursor = await persistedCursor(page, firstRun)
  assert(cursor > 0)
  const beforeReconnect = streams.length
  step(`reload active run at persisted SSE cursor ${cursor}`)
  await page.reload({ waitUntil: 'domcontentloaded' }) // real stream disconnect and PWA recovery
  await until(async () => streams.length > beforeReconnect)
  const reconnected = streams.slice(beforeReconnect).find(stream => stream.runId === firstRun)
  assert(reconnected && reconnected.after >= cursor)
  assert.equal(harnessCalls, 1)
  assert.equal(requests.length, 1)
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  releaseFirst()
  const first = await delivery(firstRun, 1, ['A', 'P', 'd', 'p'])
  const frame = await applet(page)
  await exerciseDirectrix(frame)
  await frame.evaluate(() => window.ggbApplet.setCoords('P', 2, 3))
  await frame.waitForFunction(() => window.ggbApplet.getXcoord('P') === 2 && window.ggbApplet.getYcoord('P') === 3)
  await send('Create Q=(1,1), keep P')
  await until(async () => requests.length === 2)
  const secondRun = requests[1].runId
  assert(requests[1].hasBase)
  assert.notEqual(requests[1].baseSha256, first.sha256)
  const second = await delivery(secondRun, 2, ['A', 'P', 'Q', 'd', 'p'])
  const finalFrame = await applet(page)
  await pathState(finalFrame, 'continued-delivery')
  const coordinates = await finalFrame.evaluate(() => ({ x: window.ggbApplet.getXcoord('P'), y: window.ggbApplet.getYcoord('P') }))
  assert.deepEqual(coordinates, { x: 2, y: 3 })
  assert.equal(views.get(secondRun).delivery.trustedBuild.binding.baseSha256, requests[1].baseSha256)
  assert.equal(harnessCalls, 2)
  assert.equal(requests.length, 2)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  report = { passed: true, modelDriver: 'mock Harness only', providerRequests: 0, harnessCalls,
    requests, streams, reconnect: { cursor, reconnected }, deliveries: [first, second],
    baselineCoordinates: coordinates, directrixStages, serviceWorkerControlled: true, externalRequests, pageErrors }
  step('all PWA acceptance assertions passed')
} catch (error) {
  report = { passed: false, error: String(error?.stack ?? error), harnessCalls, requests, streams, toolResults, directrixStages, pageErrors, externalRequests }
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined)
  process.exitCode = 1
} finally {
  releaseFirst()
  await browser?.close()
  api?.beginDrain()
  await api?.dispose()
  await http?.close()
  await worker?.dispose()
  await rm(scratch, { recursive: true, force: true })
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ passed: report?.passed, output }))
}

async function until(check, timeout = 120_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await new Promise(resolveWait => setTimeout(resolveWait, 50)) }
  throw new Error('acceptance_condition_timeout')
}
async function applet(current) {
  await until(async () => current.frames().some(frame => frame.url().includes('geogebra-host.html')))
  const frame = current.frames().find(item => item.url().includes('geogebra-host.html'))
  await frame.waitForFunction(() => typeof window.ggbApplet?.getAllObjectNames === 'function')
  return frame
}
async function persistedCursor(current, runId) {
  let cursor = 0
  await until(async () => {
    cursor = await current.evaluate(id => new Promise((resolveRead, reject) => {
      const opening = indexedDB.open('ggb-copilot-client')
      opening.onerror = () => reject(opening.error)
      opening.onsuccess = () => {
        const db = opening.result
        const request = db.transaction('run_bindings').objectStore('run_bindings').get(id)
        request.onsuccess = () => { db.close(); resolveRead(request.result?.eventCursor ?? 0) }
        request.onerror = () => { db.close(); reject(request.error) }
      }
    }), runId)
    return cursor > 0
  })
  return cursor
}
async function send(prompt) {
  await page.locator('[data-test="prompt-input"]:not([disabled])').fill(prompt)
  await page.locator('[data-test="send"]').click()
}
async function delivery(runId, round, names) {
  step(`waiting for real delivery ${round}`)
  const card = page.locator(`[data-test="plugin-delivery"][data-run-id="${runId}"]`)
  await card.waitFor({ timeout: 180_000 })
  const frame = await applet(page)
  await frame.waitForFunction(expected => {
    const api = window.ggbApplet
    return JSON.stringify(api.getAllObjectNames().sort()) === JSON.stringify(expected)
      && expected.every(name => api.isDefined(name))
  }, names)
  const version = await frame.evaluate(() => window.ggbApplet.getVersion())
  assert.equal(version, runtimeVersion)
  const downloadEvent = page.waitForEvent('download')
  await card.locator('[data-test="download-ggb"]').click()
  const download = await downloadEvent
  const file = join(output, `round-${round}.ggb`)
  await download.saveAs(file)
  const bytes = await readFile(file)
  const sha256 = digest(bytes)
  const text = await card.innerText()
  const prefix = (await card.locator('.message-run').innerText()).trim()
  assert(sha256.startsWith(prefix))
  assert(text.includes(`${bytes.length} bytes`))
  await until(async () => views.get(runId)?.phase === 'completed')
  const view = views.get(runId)
  const metadata = view.delivery.artifacts.find(item => item.kind === 'result_ggb')
  assert.equal(metadata.sha256, sha256)
  assert.equal(metadata.sizeBytes, bytes.length)
  assert.equal(view.delivery.trustedBuild.binding.runId, runId)
  assert.equal(view.delivery.cleanup.confirmed, true)
  await page.screenshot({ path: join(output, `round-${round}.png`) })
  return { runId, file, bytes: bytes.length, sha256, appletVersion: version, names }
}

async function pathState(frame, stage) {
  const value = await frame.evaluate(stage => {
    const api = window.ggbApplet
    return { stage, version: api.getVersion(), defined: api.isDefined('A'),
      parameter: api.getValue('PathParameter(A)'), x: api.getXcoord('A'),
      command: api.getCommandString('A', false), independent: api.isIndependent('A'),
      distance: api.getValue('Distance(A,d)'),
      labels: { p: api.getLabelVisible('p'), d: api.getLabelVisible('d') },
      xml: api.getXML() }
  }, stage)
  directrixStages.push(value)
  assert.equal(value.version, runtimeVersion)
  assert.equal(value.defined, true)
  assert(Number.isFinite(value.parameter))
  assert.equal(value.command, 'Point[d]')
  assert.equal(value.independent, false)
  assert(Math.abs(value.distance) < 1e-8)
  assert.deepEqual(value.labels, { p: false, d: false })
}

async function reloadPath(frame) {
  await frame.evaluate(async () => {
    const api = window.ggbApplet
    const data = await new Promise(done => api.getBase64(done))
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Path reload timed out')), 15000)
      api.setBase64(data, () => { clearTimeout(timer); done() })
    })
  })
}

async function exerciseDirectrix(frame) {
  await pathState(frame, 'delivered')
  await frame.evaluate(() => {
    const api = window.ggbApplet
    for (const name of ['p', 'd']) {
      api.setLabelVisible(name, true)
      api.setLabelVisible(name, false)
    }
    api.setMode(0)
  })
  await pathState(frame, 'labels-hidden')
  await reloadPath(frame)
  await pathState(frame, 'reloaded')
  const canvas = await frame.locator('#applet canvas').first().boundingBox()
  assert(canvas)
  const position = await frame.evaluate(() => {
    const api = window.ggbApplet
    const xml = new DOMParser().parseFromString(api.getXML(), 'text/xml')
    const view = xml.querySelector('euclidianView coordSystem')
    return { x: Number(view.getAttribute('xZero')) + api.getXcoord('A') * Number(view.getAttribute('scale')),
      y: Number(view.getAttribute('yZero')) - api.getYcoord('A') * Number(view.getAttribute('yscale')), before: api.getYcoord('A') }
  })
  await page.mouse.move(canvas.x + position.x, canvas.y + position.y)
  await page.mouse.down()
  try { await page.mouse.move(canvas.x + position.x, canvas.y + position.y + 40, { steps: 12 }) }
  finally { await page.mouse.up() }
  await frame.waitForFunction(before => Math.abs(window.ggbApplet.getYcoord('A') - before) > 1e-8, position.before)
  await pathState(frame, 'mouse-dragged')
  const before = await frame.evaluate(() => window.ggbApplet.getViewProperties(1))
  await frame.locator('#applet canvas').first().hover()
  await page.mouse.wheel(0, -240)
  await frame.waitForFunction(before => window.ggbApplet.getViewProperties(1) !== before, before)
  await pathState(frame, 'zoomed')
  await reloadPath(frame)
  await pathState(frame, 'zoom-reloaded')
  await page.screenshot({ path: join(output, 'directrix-client.png') })
}
