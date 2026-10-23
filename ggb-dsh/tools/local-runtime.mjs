import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { openSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Shared owner for one isolated plugin-core API/Worker pair (plugin-core tools, authorized
 * browser verification). Process supervision differs per tool — the drill restarts and
 * kills a Worker mid-run — so this module owns the parts that must never drift between
 * tools: the environment allowlist, the socket/secret set and local readiness probes.
 */
export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Resolve the pinned installation, never a sibling source checkout. */
export function installedPluginRoot(explicit) {
  const lock = JSON.parse(readFileSync(join(workspaceRoot, 'vendor/plugin-core.lock.json'), 'utf8'))
  return resolve(explicit ?? process.env.GGB_PLUGIN_ROOT ?? join(workspaceRoot, '.plugin-core-runtime', lock.archiveSha256))
}
export function installedPluginModule(root, name) {
  return createRequire(join(root, 'package.json')).resolve(name)
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Reserve and release one loopback port, so both processes receive a real free port. */
export async function freeLocalPort() {
  const server = createServer()
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

/**
 * Complete environment for an isolated local run. Built from an explicit allowlist instead
 * of `process.env`: provider credentials must not leak into a process under test, and a
 * caller's `GGB_*` leftovers must not silently change the run.
 *
 * `providerBaseUrl` is omitted unless a caller names one, so a real run keeps the
 * server-owned provider origin instead of a tool's placeholder.
 *
 * @param {object} input Isolation directory, port, optional provider URL and caller overrides.
 * @returns {Record<string, string>} Environment for both processes.
 */
export function localEnvironment({ directory, port, providerBaseUrl = null, overrides = {} }) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? directory,
    TMPDIR: process.env.TMPDIR ?? directory,
    LANG: process.env.LANG ?? 'C.UTF-8',
    PORT: String(port),
    GGB_AGENT_ENGINE: 'plugin_core',
    GGB_V3_SERVER_PEPPER: randomBytes(32).toString('hex'),
    GGB_V3_WORKER_SECRET: randomBytes(32).toString('hex'),
    GGB_V3_SQLITE_PATH: join(directory, 'runs.sqlite'),
    GGB_V3_WORKER_SOCKET_PATH: join(directory, 'worker.sock'),
    GGB_PLUGIN_CORE_TOOL_SOCKET: join(directory, 'plugin-core-tool.sock'),
    GGB_V3_DSH_HOME_ROOT: join(directory, 'dsh-home'),
    GGB_V3_DSH_WORKSPACE_ROOT: workspaceRoot,
    ...(providerBaseUrl === null ? {} : { GGB_V3_PROVIDER_BASE_URL: providerBaseUrl }),
    GGB_V3_DRAIN_GRACE_MS: '0',
    ...overrides,
  }
  return env
}

/** @returns {boolean} True while the child has neither exited nor been signalled. */
export function childAlive(child) {
  return child.exitCode === null && child.signalCode === null
}

/**
 * Spawn one workspace process with its output captured in `<directory>/<name>.log`.
 *
 * @param {object} input Name, entry path, environment, log directory and optional spawn extras.
 * @returns {import('node:child_process').ChildProcess} Running child.
 */
export function spawnWorkspaceProcess({ name, entry, env, directory, cwd = workspaceRoot, spawnOptions = {} }) {
  const log = openSync(join(directory, `${name}.log`), 'a')
  return spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', log, log], ...spawnOptions })
}

/** Stop one child gracefully, escalating to SIGKILL after `graceMs`. */
export async function stopProcess(child, graceMs = 10_000) {
  if (child === undefined || child === null || !childAlive(child)) return
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}

/** Wait until one loopback TCP socket accepts a connection. */
export async function waitForSocket(path, { timeoutMs = 30_000, isAlive = () => true } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error('process_exited_before_socket_ready')
    const connected = await new Promise((resolveConnect) => {
      const socket = createConnection(path)
      socket.setTimeout(1_000, () => socket.destroy())
      socket.once('connect', () => { socket.end(); resolveConnect(true) })
      socket.once('error', () => resolveConnect(false))
      socket.once('close', () => resolveConnect(false))
    })
    if (connected) return
    await sleep(200)
  }
  throw new Error('socket_ready_timeout')
}

/** Wait until an HTTP endpoint answers successfully. */
export async function waitForHttpOk(url, { timeoutMs = 30_000, isAlive = () => true } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error('process_exited_before_http_ready')
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await sleep(200)
  }
  throw new Error('http_ready_timeout')
}

/**
 * Start one isolated API/Worker pair and wait until both are usable.
 *
 * @param {object} input Isolation directory, port, provider URL and environment overrides.
 * @returns {Promise<{env: Record<string,string>, worker: any, api: any, directory: string, stop: () => Promise<void>}>}
 */
export async function startLocalProcesses({ directory, port, providerBaseUrl, overrides = {} }) {
  const env = localEnvironment({ directory, port, providerBaseUrl, overrides })
  const worker = spawnWorkspaceProcess({ name: 'worker', entry: 'apps/worker/lib/main.js', env, directory })
  await waitForSocket(env.GGB_V3_WORKER_SOCKET_PATH, { isAlive: () => childAlive(worker) })
  const api = spawnWorkspaceProcess({ name: 'api', entry: 'apps/api/lib/main.js', env, directory })
  await waitForHttpOk(`http://127.0.0.1:${String(port)}/api/v3/health/ready`, { isAlive: () => childAlive(api) })
  return {
    env, worker, api, directory,
    stop: async () => {
      await stopProcess(api)
      await stopProcess(worker)
    },
  }
}
