/** @fileoverview Uses the real Client document, API assets and an active old Worker. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { chromium } from 'playwright'
import { startApiServer } from '../apps/api/lib/http/http-server.js'
import { createStaticAssets } from '../apps/api/lib/http/static-assets.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))
const apiRequire = createRequire(join(workspace, 'apps/api/package.json'))
const { RunError } = await import(pathToFileURL(apiRequire.resolve('@ggb-copilot/application')).href)
const config = JSON.parse(await readFile(join(workspace, 'config/runtime-versions.json'), 'utf8'))
const lock = JSON.parse(await readFile(join(workspace, 'vendor/plugin-core.lock.json'), 'utf8'))
const installed = join(workspace, '.plugin-core-runtime', lock.archiveSha256)
const require = createRequire(join(installed, 'package.json'))
const output = resolve(process.env.GGB_RUNTIME_EVIDENCE ?? '../output/runtime-release-20261024')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const root = join(workspace, 'apps/client/public/geogebra')
const identity = config.geogebra.compatibility
const fragmentUrl = `/geogebra/${identity.asset}`

async function command(page, source) {
  assert.ok(await page.evaluate(source => window.ggbApplet.asyncEvalCommandGetLabels(source), source))
}

async function construct(page) {
  for (const source of ['q=Slider(1,2,1)', 'p:y^2=4*q*x', 'F=Focus(p)',
    'd=Directrix(p)', 'A=Point(d)', 's=Segment(F,A)', 'M=Midpoint(F,A)',
    'b=PerpendicularBisector(F,A)']) await command(page, source)
  await page.evaluate(() => {
    const api = window.ggbApplet
    api.setCoords('A', -1, 2)
    api.setCoordSystem(-5, 5, -4, 5)
    api.setLabelVisible('p', true)
    api.setLabelVisible('d', true)
    api.setCaption('d', 'directrix')
    api.setLabelStyle('d', 3)
    api.setMode(0)
  })
}

async function state(page, label) {
  return page.evaluate(label => {
    const api = window.ggbApplet
    return { label, version: api.getVersion(), xml: api.getXML(),
      point: { defined: api.isDefined('A'), x: api.getXcoord('A'), y: api.getYcoord('A'),
        parameter: api.getValue('PathParameter(A)'), command: api.getCommandString('A', false),
        independent: api.isIndependent('A'), moveable: api.isMoveable('A') },
      objects: ['F', 'd', 's', 'M', 'b'].map(name => ({ name, defined: api.isDefined(name),
        command: api.getCommandString(name, false), labelVisible: api.getLabelVisible(name) })),
      labels: { p: api.getLabelVisible('p'), d: api.getLabelVisible('d') },
      distance: api.getValue('Distance(A,d)') }
  }, label)
}

function audit(observed) {
  assert.equal(observed.version, config.geogebra.version)
  assert.equal(observed.point.defined, true)
  assert.equal(observed.point.command, 'Point[d]')
  assert.equal(observed.point.independent, false)
  assert.equal(observed.point.moveable, true)
  assert.ok(Number.isFinite(observed.point.parameter))
  assert.ok(Math.abs(observed.distance) < 1e-8)
  assert.ok(observed.objects.every(object => object.defined))
  assert.equal(observed.objects.find(object => object.name === 'd').command, 'Directrix[p]')
}

function auditHidden(observed) {
  audit(observed)
  assert.deepEqual(observed.labels, { p: false, d: false })
}

async function roundtrip(page) {
  const data = await page.evaluate(() => new Promise(done => window.ggbApplet.getBase64(done)))
  await page.evaluate(data => new Promise(done => window.ggbApplet.setBase64(data, done)), data)
  return data
}

async function drag(page) {
  const position = await page.evaluate(() => {
    const api = window.ggbApplet
    const rect = document.querySelector('#applet canvas').getBoundingClientRect()
    const xml = new DOMParser().parseFromString(api.getXML(), 'text/xml')
    const view = xml.querySelector('euclidianView coordSystem')
    return { x: rect.x + Number(view.getAttribute('xZero')) + api.getXcoord('A') * Number(view.getAttribute('scale')),
      y: rect.y + Number(view.getAttribute('yZero')) - api.getYcoord('A') * Number(view.getAttribute('yscale')),
      before: api.getYcoord('A') }
  })
  await page.mouse.move(position.x, position.y)
  await page.mouse.down()
  try { await page.mouse.move(position.x, position.y + 40, { steps: 12 }) }
  finally { await page.mouse.up() }
  await page.waitForFunction(before => Math.abs(window.ggbApplet.getYcoord('A') - before) > 1e-8, position.before)
}

async function stableView(page) {
  await page.evaluate(() => new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('View did not settle')), 5000)
    let previous, stable = 0
    const frame = () => {
      const current = window.ggbApplet.getViewProperties(1)
      stable = current === previous ? stable + 1 : 0
      previous = current
      if (stable >= 5) { clearTimeout(timer); done() }
      else requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }))
}

async function fixedGeometry(page, evidence, generation) {
  await construct(page)
  evidence.push(await state(page, 'fixed-construction-and-style'))
  audit(evidence.at(-1))
  assert.deepEqual(evidence.at(-1).labels, { p: true, d: true })
  for (const object of ['p', 'd']) {
    await page.evaluate(object => window.ggbApplet.setLabelVisible(object, false), object)
    evidence.push(await state(page, `${object}.labelVisible=false`))
    audit(evidence.at(-1))
    assert.equal(evidence.at(-1).labels[object], false)
  }
  await roundtrip(page)
  evidence.push(await state(page, 'fixed-reload'))
  auditHidden(evidence.at(-1))
  await stableView(page)
  await drag(page)
  evidence.push(await state(page, 'fixed-real-mouse-drag'))
  auditHidden(evidence.at(-1))
  await page.evaluate(() => window.ggbApplet.setValue('q', 2))
  evidence.push(await state(page, 'fixed-parent-dependency-update'))
  auditHidden(evidence.at(-1))
  assert.equal(evidence.at(-1).point.x, -2)
  const before = await page.evaluate(() => window.ggbApplet.getViewProperties(1))
  await page.locator('#applet canvas').first().hover()
  await page.mouse.wheel(0, -240)
  await page.waitForFunction(before => window.ggbApplet.getViewProperties(1) !== before, before)
  await stableView(page)
  const data = await roundtrip(page)
  evidence.push(await state(page, 'fixed-zoom-and-second-reload'))
  auditHidden(evidence.at(-1))
  await writeFile(join(output, `client-${generation}-final.ggb`), Buffer.from(data, 'base64'))
}

async function upgradeWorker(page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    window.previousController = navigator.serviceWorker.controller
    let timer
    try {
      await Promise.race([
        new Promise((done, reject) => {
          registration.addEventListener('updatefound', () => {
            const next = registration.installing
            next.addEventListener('statechange', () => {
              if (next.state === 'activated') done()
              if (next.state === 'redundant') reject(new Error('Updated Worker became redundant'))
            })
          }, { once: true })
          registration.update().catch(reject)
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Worker activation timed out')), 15000) }),
      ])
    } finally { clearTimeout(timer) }
  })
  // This Playwright version treats Promise predicates as truthy; wait for the
  // lifecycle event above, then use a synchronous controller predicate.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== window.previousController)
}

for (const generation of ['v1', 'v2']) {
test(`actual Client ${config.geogebra.version} upgrades an active ${generation} Worker and retains geometry`, { timeout: 120000 }, async () => {
  await mkdir(output, { recursive: true })
  const patched = await readFile(join(root, identity.asset))
  assert.equal(hash(patched), identity.patchedSha256)
  // Authenticated negative fixture: inverse only the known single patch and
  // prove the result equals the pinned official original bytes.
  const raw = Buffer.from(patched.toString().replace(';jTh(a.g,d,f,1,true);dSh(a.o)', ';dSh(a.o)'))
  assert.equal(hash(raw), identity.originalSha256)
  const oldWorker = await readFile(join(workspace, `tools/fixtures/runtime-${generation}-service-worker.js`))
  const newWorker = await readFile(join(workspace, 'apps/client/dist/service-worker.js'))
  const requests = [], stages = []
  let legacy = true
  const server = await startApiServer({ port: 0, maxBodyBytes: 1024, allowedOrigin: null,
    staticAssets: createStaticAssets({ clientDistDir: join(workspace, 'apps/client/dist'), geogebraRoot: root,
      runtimeVersionsPath: join(workspace, 'config/runtime-versions.json') }),
    handler: async ({ url, res }) => {
      if (url.pathname === '/service-worker.js') {
        requests.push({ worker: true, legacy, sha256: hash(legacy ? oldWorker : newWorker) })
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }).end(legacy ? oldWorker : newWorker)
        return
      }
      if (url.pathname === fragmentUrl) {
        requests.push({ legacy, sha256: hash(legacy ? raw : patched) })
        if (legacy) {
          res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=86400' }).end(raw)
          return
        }
      }
      throw new RunError('not_found', 'static asset')
    } })
  const browser = await chromium.launch({ executablePath: require('playwright').chromium.executablePath(), headless: true })
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const base = `http://127.0.0.1:${server.port}`
    await page.goto(base)
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/service-worker.js', { type: 'module' })
      await navigator.serviceWorker.ready
    })
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
    await page.goto(`${base}/geogebra-host.html`)
    await page.waitForFunction(() => typeof window.ggbApplet?.evalCommand === 'function')
    await construct(page)
    stages.push(await state(page, 'original-worker-and-engine'))
    assert.equal(stages.at(-1).point.defined, false)
    const oldKeys = await page.evaluate(() => caches.keys())
    assert.ok(oldKeys.includes(`ggb-runtime-${generation}`))
    await page.evaluate(async other => {
      const cache = await caches.open(`ggb-runtime-${other}`)
      await cache.put('/geogebra/old-version', new Response('retired runtime'))
    }, generation === 'v1' ? 'v2' : 'v1')
    await page.screenshot({ path: join(output, `client-${generation}-before-upgrade.png`) })
    legacy = false
    await upgradeWorker(page)
    const upgradedKeys = await page.evaluate(() => caches.keys())
    stages.push({ label: 'activation', upgradedKeys, registration: await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      return { active: registration?.active?.state, waiting: registration?.waiting?.state,
        installing: registration?.installing?.state, controller: navigator.serviceWorker.controller?.scriptURL }
    }) })
    assert.equal(upgradedKeys.includes('ggb-runtime-v1'), false)
    assert.equal(upgradedKeys.includes('ggb-runtime-v2'), false)
    await page.reload()
    await page.waitForFunction(() => typeof window.ggbApplet?.evalCommand === 'function')
    await fixedGeometry(page, stages, generation)
    const cached = await page.evaluate(async url => {
      const response = await (await caches.open('ggb-runtime-v3')).match(url)
      if (!response) throw new Error('Patched engine missing from v3 cache')
      return Array.from(new Uint8Array(await response.arrayBuffer()))
    }, base + fragmentUrl)
    assert.equal(hash(Buffer.from(cached)), identity.patchedSha256)
    assert.ok(requests.some(request => request.legacy) && requests.some(request => !request.legacy))
    await page.screenshot({ path: join(output, `client-${generation}-after-upgrade.png`) })
    stages.push({ label: 'worker-upgrade', oldKeys, upgradedKeys, cachedSha256: hash(Buffer.from(cached)) })
  } finally {
    await context.close()
    await browser.close()
    await server.close()
    await writeFile(join(output, `client-${generation}-upgrade.json`), JSON.stringify({ identity, generation, requests, stages }, null, 2))
  }
})
}
