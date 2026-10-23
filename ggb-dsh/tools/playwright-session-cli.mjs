/**
 * Local Playwright session CLI: the contract `tools/q3-browser-fixture.mjs` expects from
 * `playwright_cli.sh`. It keeps one Chromium session per name so a drill can evaluate several
 * `async (page) => …` snippets against the same page, and prints results in the CLI's format:
 *
 *   ### Result
 *   <json>
 *   ### Ran Playwright code
 *
 * Usage (through the `bash` shim, as the fixture calls it):
 *   bash tools/playwright-session-cli.sh --session <name> run-code --filename <path>
 *
 * A session starts on first use at `GGB_PW_URL` (default `http://localhost:5199/`) and stays alive
 * until `--close` or its state file is removed. The page is the Client Vite dev server, because the
 * drills import `/src/...` modules in the browser.
 *
 * No workspace dependency is added: Playwright is resolved from `GGB_E2E_PLAYWRIGHT`, and the browser
 * profile lives under the gitignored `.tmp/pw-sessions/<name>/`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sessionRoot = join(root, '.tmp', 'pw-sessions')

/** @param {string[]} argv @returns {Record<string, string|boolean>} `--flag value` pairs. */
function parseArguments(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) parsed[token.slice(2)] = true
    else { parsed[token.slice(2)] = next; index += 1 }
  }
  return parsed
}

function statePath(session) {
  if (!/^[a-z0-9_]+$/u.test(session)) throw new Error('playwright_session_name_invalid')
  return join(sessionRoot, `${session}.json`)
}

function readState(session) {
  const path = statePath(session)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

async function loadPlaywright() {
  const explicit = process.env.GGB_E2E_PLAYWRIGHT ?? process.env.GGB_PW_PLAYWRIGHT
  const candidates = explicit === undefined ? [] : [resolve(explicit)]
  for (const candidate of candidates) return import(pathToFileURL(candidate).href)
  return import('playwright')
}

/** @returns {Promise<number>} One free loopback port. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

/** The daemon answers `POST /run-code` with the evaluated JSON result. */
async function waitForDaemon(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return true
    } catch { /* not ready yet */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  return false
}

/** Keep one Chromium alive for a session and expose its CDP endpoint. */
async function runDaemon(options) {
  const session = String(options.session)
  const port = Number(options.port)
  const url = String(options.url ?? 'http://localhost:5199/')
  const headed = options.headed === true
  const profile = join(sessionRoot, session, 'profile')
  mkdirSync(profile, { recursive: true })
  const { chromium } = await loadPlaywright()
  const context = await chromium.launchPersistentContext(profile, {
    headless: !headed, viewport: { width: 1280, height: 900 } })
  const page = context.pages()[0] ?? await context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const server = createServer((request, response) => {
    if (request.url === '/health') { response.writeHead(200).end('ok'); return }
    if (request.method !== 'POST' || request.url !== '/run-code') {
      response.writeHead(404).end('not found')
      return
    }
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      void (async () => {
        try {
          const code = Buffer.concat(chunks).toString('utf8')
          const evaluate = /** @type {(page: unknown) => Promise<unknown>} */ (eval(`(${code})`))
          const result = await evaluate(page)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ result: result ?? null }))
        } catch (error) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      })()
    })
  })
  await new Promise(resolveListen => server.listen(port, '127.0.0.1', resolveListen))
  writeFileSync(statePath(session), JSON.stringify({ port, pid: process.pid, url }))
  process.stdout.write(`session ${session} ready on ${url} (control ${port})\n`)
  const stop = async () => {
    try { server.close() } catch { /* closing */ }
    try { await context.close() } catch { /* closing */ }
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  await new Promise(() => {})
}

/** Evaluate one `async (page) => …` snippet against the session page. */
async function runCode(options) {
  const session = String(options.session)
  let state = readState(session)
  if (state === null) {
    const port = await freePort()
    const url = String(process.env.GGB_PW_URL ?? 'http://localhost:5199/')
    const args = ['--daemon', '--session', session, '--port', String(port), '--url', url]
    if (process.env.GGB_PW_HEADED === '1') args.push('--headed')
    spawn(process.execPath, [fileURLToPath(import.meta.url), ...args],
      { detached: true, stdio: 'ignore', cwd: root }).unref()
    const ready = await waitForDaemon(port)
    state = readState(session)
    if (!ready || state === null) throw new Error('playwright_session_start_failed')
  }
  const code = readFileSync(resolve(String(options.filename)), 'utf8')
  const response = await fetch(`http://127.0.0.1:${state.port}/run-code`, { method: 'POST', body: code })
  const payload = await response.json()
  if (payload.error !== undefined) throw new Error(`playwright_run_code_failed: ${payload.error}`)
  process.stdout.write(`### Result\n${JSON.stringify(payload.result ?? null)}\n### Ran Playwright code\n`)
}

function closeSession(options) {
  const session = String(options.session)
  const state = readState(session)
  if (state !== null && typeof state.pid === 'number') {
    try { process.kill(state.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  rmSync(join(sessionRoot, session), { recursive: true, force: true })
  rmSync(statePath(session), { force: true })
  process.stdout.write(`### Result\n${JSON.stringify({ closed: session })}\n### Ran Playwright code\n`)
}

const options = parseArguments(process.argv.slice(2))
if (options.close === true) closeSession(options)
else if (options.daemon === true) await runDaemon(options)
else await runCode(options)
