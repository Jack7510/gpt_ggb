/** Local source launcher; release files are never rewritten. */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { closeSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const save = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })

export function options(args, env = process.env) {
  const result = { repo: resolve(env.REPO ?? repository), bundle: false,
    install: false, doctor: false, buildOnly: false, help: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--bundle') result.bundle = true
    else if (arg === '--install') result.install = true
    else if (arg === '--doctor') result.doctor = true
    else if (arg === '--build-only') result.buildOnly = true
    else if (['--plugin', '--pinned-root'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value: ${arg}`)
      result[arg === '--plugin' ? 'plugin' : 'pinnedRoot'] = resolve(args[++i])
    } else throw new Error(`Unknown option: ${arg}`)
  }
  return result
}

/** Derive a private development lock and verify it using the real host loader. */
export async function prepareOverlay(workspace, source, pinnedRoot, output) {
  const lockPath = join(workspace, 'vendor/plugin-core.lock.json')
  const original = await readFile(lockPath)
  const lock = JSON.parse(original)
  const { loadInstalledPlugin } = await import(pathToFileURL(
    join(workspace, 'apps/worker/lib/plugin-core/installation.js')).href)
  await loadInstalledPlugin(pinnedRoot, lockPath)
  const pinnedPackage = await json(join(pinnedRoot, 'package.json'))
  // DSH manifest is an overlay; runtime dependencies come from the root manifest.
  const sourcePackage = await json(join(source, 'package.json'))
  const pkg = { ...sourcePackage, ...await json(join(source, 'dsh/package.json')),
    scripts: pinnedPackage.scripts }
  // Reusing node_modules/runtime is safe only for the identical dependency set.
  if (sourcePackage.version !== pkg.version || pkg.version !== pinnedPackage.version
    || JSON.stringify(pkg.dependencies) !== JSON.stringify(pinnedPackage.dependencies)
    || JSON.stringify(await json(join(source, 'runtime.lock.json')))
      !== JSON.stringify(await json(join(pinnedRoot, 'runtime.lock.json')))) {
    throw new Error('Plugin dependencies/version/runtime changed; supply a new pinned release first.')
  }
  const root = join(output, 'plugin')
  await cp(pinnedRoot, root, { recursive: true })
  for (const ref of ['dist', 'dsh', 'skills/ggb-construction']) {
    await rm(join(root, ref), { recursive: true, force: true })
    await cp(join(source, ref), join(root, ref), { recursive: true })
  }
  for (const ref of ['index.js', 'cordis.patch.yml', 'locale']) {
    await rm(join(root, ref), { recursive: true, force: true })
    await cp(join(source, 'dsh', ref), join(root, ref), { recursive: true })
  }
  for (const ref of ['viewer', 'scripts/setup-plugin.mjs', 'scripts/setup-runtime.mjs', 'capabilities.json']) {
    await cp(join(source, ref), join(root, ref), { recursive: true })
  }
  await save(join(root, 'package.json'), pkg)
  // An old source snapshot must not masquerade as the current source build.
  await rm(join(root, 'source'), { recursive: true, force: true })
  for (const ref of Object.keys(lock.files)) {
    if (ref.startsWith('source/')) delete lock.files[ref]
    else lock.files[ref] = sha(await readFile(join(root, ref)))
  }
  async function fingerprint(dir) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const ref = `${dir}/${entry.name}`
      if (entry.isDirectory()) await fingerprint(ref)
      else if (entry.isFile()) lock.files[ref] = sha(await readFile(join(root, ref)))
      else throw new Error(`Unexpected plugin link: ${ref}`)
    }
  }
  for (const dir of ['dist', 'dsh', 'locale', 'viewer', 'skills/ggb-construction']) await fingerprint(dir)
  lock.workerSkillSha256 = lock.files['skills/ggb-construction/worker.md']
  lock.distribution = 'local-source-overlay'
  lock.sourceDirty = true
  delete lock.sourceCommit
  delete lock.sourceSnapshotSha256
  // Development payload identity, not the digest of the unchanged vendor TGZ.
  lock.archiveSha256 = sha(JSON.stringify(Object.fromEntries(Object.entries(lock.files).sort())))
  const privateWorkspace = join(output, 'workspace')
  await mkdir(join(privateWorkspace, 'vendor'), { recursive: true })
  const privateLock = join(privateWorkspace, 'vendor/plugin-core.lock.json')
  await save(privateLock, lock)
  const installed = await loadInstalledPlugin(root, privateLock)
  await installed.assertRuntimeReady() // File/dependency checks only; no browser/Provider.
  if (!(await readFile(lockPath)).equals(original)) throw new Error('Release lock changed concurrently.')
  await save(join(output, 'installation.json'), { distribution: lock.distribution,
    source: await realpath(source), pinnedRoot, pluginRoot: root,
    releaseArchiveSha256: JSON.parse(original).archiveSha256,
    developmentPayloadSha256: lock.archiveSha256,
    workerSkillSha256: lock.workerSkillSha256, privateLock })
  return { root, privateWorkspace }
}

/** Own process groups for builds and servers after the explicit port cleanup. */
export class Processes {
  children = new Set()
  stopping = false
  start(command, args, cwd, env, logPath) {
    if (this.stopping) throw new Error('Launcher stopped.')
    const fd = openSync(logPath, 'a', 0o600)
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] })
    closeSync(fd)
    const item = { child, command, logPath, status: null }
    item.done = new Promise(resolveDone => {
      child.once('error', () => { item.status = 1; resolveDone(1) })
      child.once('exit', (code, signal) => {
        item.status = code ?? (signal ? 1 : 0)
        resolveDone(item.status)
      })
    })
    this.children.add(item)
    return item
  }
  async stop() {
    this.stopping = true
    const items = [...this.children]
    const signal = name => {
      for (const item of items) if (item.child.pid) {
        try { process.kill(-item.child.pid, name) } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    }
    signal('SIGTERM')
    // Worker normally aborts and drains its own detached browser/SDK trees.
    await Promise.race([Promise.all(items.map(item => item.done)), delay(20_000, undefined, { ref: false })])
    signal('SIGKILL')
    await Promise.all(items.map(item => item.done))
  }
}

/** Inspect listening TCP sockets only; lsof exit 1 with no diagnostics means no match. */
async function listeningPids(port) {
  try {
    const { stdout } = await promisify(execFile)('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'],
      { encoding: 'utf8', timeout: 5000 })
    const pids = stdout.trim().split(/\s+/u).filter(Boolean).map(Number)
    if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid lsof PID output.')
    return [...new Set(pids)]
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return []
    throw new Error(`Cannot inspect port ${port}: ${error.message}`)
  }
}

/** Release only the selected listeners; never signal their entire process groups. */
export async function releasePort(port, log = console.log, graceMs = 5000) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TCP port.')
  const owners = await listeningPids(port)
  if (owners.includes(process.pid)) throw new Error(`Refusing to terminate this launcher on port ${port}.`)
  const signal = (pids, name) => {
    for (const pid of pids) {
      log(`[deploy] port ${port}: ${name} PID ${pid}`)
      try { process.kill(pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  const remaining = async () => {
    const current = await listeningPids(port)
    if (current.some(pid => !owners.includes(pid))) throw new Error(`Port ${port} acquired a new listener during cleanup.`)
    return current
  }
  signal(owners, 'SIGTERM')
  let current = owners
  const deadline = Date.now() + graceMs
  while (current.length && Date.now() < deadline) {
    await delay(100)
    current = await remaining()
  }
  if (current.length) {
    signal(await remaining(), 'SIGKILL')
    const forcedDeadline = Date.now() + 2000
    do {
      await delay(100)
      current = await remaining()
    } while (current.length && Date.now() < forcedDeadline)
  }
  await assertPortFree(port)
  log(`[deploy] port ${port}: available`)
}

export async function assertPortFree(port) {
  await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error(`Port ${port} is occupied; release it before starting.`)))
    // Probe the same loopback interface the API and Vite bind.
    server.listen(port, '127.0.0.1', () => server.close(resolvePort))
  })
}

async function ready(url, items, processes) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (processes.stopping || items.some(item => item.status !== null)) {
      throw new Error('Server exited before readiness; inspect phase logs.')
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch { /* bounded startup polling */ }
    await delay(250)
  }
  throw new Error(`Readiness timeout: ${url}`)
}

async function persistentPepper(path) {
  try { await writeFile(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  return (await readFile(path, 'utf8')).trim()
}

export async function main(args = process.argv.slice(2)) {
  const config = options(args)
  if (config.help) {
    console.log(`Usage: sh tools/deploy-ggb-dsh.sh [options]
Local development only. No release publishing, production deployment or model task.
  --install        Install both workspaces with frozen lockfiles, ignoring scripts
  --bundle         Build the client bundle and serve it on 127.0.0.1:8081 (no Vite)
  --build-only     Build and prepare the source installation; do not start servers
  --doctor         Also run plugin doctor (launches real local GeoGebra/browser)
  --plugin PATH    Plugin source (default: $REPO/ggb-plugins)
  --pinned-root PATH  Complete installation matching the current vendor lock
  --help           Show this help
REPO defaults to the script's repository. Default UI: http://localhost:5173
Requires Node/pnpm/lsof, installed dependencies and a fully provisioned pinned runtime.
Before building, stops TCP listeners on 8081 and 5173 (bundle: only 8081).
Sends SIGTERM, waits up to 5s, then SIGKILL if needed. --build-only skips cleanup.
Logs: $REPO/output/deploy-ggb-dsh/<unique-run>/. Ctrl-C stops all owned processes.
Enter Provider Key only in page Settings. This script never reads .env or starts a model task.`)
    return
  }
  if (process.platform === 'win32') throw new Error('This launcher requires POSIX process groups.')
  if (process.env.NODE_ENV === 'production' || process.env.GGB_V3_DATABASE_URL) {
    throw new Error('Local launcher refuses production NODE_ENV and PostgreSQL targets.')
  }
  if (process.env.PORT && process.env.PORT !== '8081') throw new Error('PORT must be 8081 (Vite proxy).')
  const workspace = join(config.repo, 'ggb-dsh')
  const source = config.plugin ?? join(config.repo, 'ggb-plugins')
  const lock = await json(join(workspace, 'vendor/plugin-core.lock.json'))
  await readFile(join(workspace, 'apps/client/public/geogebra/deployggb.js')).catch(() => {
    throw new Error('Missing Client GeoGebra runtime; run pnpm run provision:geogebra in ggb-dsh first.')
  })
  const pinned = config.pinnedRoot ?? join(workspace, '.plugin-core-runtime', lock.archiveSha256)
  await readFile(join(pinned, 'provisioned.json')).catch(() => {
    throw new Error('Missing pinned installation; run pnpm run provision:plugin-core in ggb-dsh first.')
  })
  const parent = join(config.repo, 'output/deploy-ggb-dsh')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const output = await mkdtemp(join(parent, 'run-'))
  const sockets = await mkdtemp(join(tmpdir(), 'ggb-local-'))
  const processes = new Processes()
  const stages = []
  let signalCode = 0
  let shutdown
  const stop = () => shutdown ??= processes.stop()
  const onSignal = signal => { signalCode = signal === 'SIGINT' ? 130 : 143; void stop() }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  // No credentials, tracing hooks or production database reach build subprocesses.
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/API_KEY$|SECRET(?:_FILE)?$|PEPPER(?:_FILE)?$|DSH_TRACE|^NODE_OPTIONS$/u.test(key)) delete env[key]
  }
  console.log(`Stage logs: ${output}`)
  async function stage(name, cwd, command, args) {
    console.log(`[deploy] ${name}`)
    const item = processes.start(command, args, cwd, env, join(output, `${name}.log`))
    const startedAt = new Date().toISOString()
    const exitCode = await item.done
    processes.children.delete(item)
    stages.push({ name, startedAt, finishedAt: new Date().toISOString(), exitCode })
    await save(join(output, 'stages.json'), stages)
    if (exitCode !== 0 || processes.stopping) throw new Error(`${name} failed; inspect ${item.logPath}`)
  }
  try {
    if (!config.buildOnly) {
      const startedAt = new Date().toISOString()
      const messages = []
      let exitCode = 1
      try {
        for (const port of config.bundle ? [8081] : [8081, 5173]) {
          await releasePort(port, message => { console.log(message); messages.push(message) })
        }
        exitCode = 0
      } finally {
        await writeFile(join(output, '00-release-ports.log'), messages.join('\n') + '\n', { mode: 0o600 })
        stages.push({ name: '00-release-ports', startedAt, finishedAt: new Date().toISOString(), exitCode })
        await save(join(output, 'stages.json'), stages)
      }
    }
    if (config.install) {
      await stage('01-install-plugin', source, 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'])
      await stage('02-install-host', workspace, 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'])
    }
    await stage('03-build-plugin', source, 'pnpm', ['build'])
    await stage('04-build-backend', workspace, 'pnpm', ['exec', 'tsc', '-b', 'apps/api', 'apps/worker'])
    await stage('05-build-client', workspace, 'pnpm', ['exec', 'tsc', '-b', 'apps/client'])
    if (config.bundle) await stage('06-bundle', workspace, 'pnpm', ['--filter', '@ggb-copilot/client', 'run', 'bundle'])
    const overlay = await prepareOverlay(workspace, source, pinned, output)
    if (config.doctor) await stage('07-doctor', overlay.root, process.execPath, ['dist/src/cli.js', 'doctor'])
    console.log(`plugin test root: ${overlay.root}; vendor release lock unchanged`)
    if (config.buildOnly) return
    // A new listener may have appeared while building; do not start a partial server set.
    await assertPortFree(8081)
    if (!config.bundle) await assertPortFree(5173)
    const state = join(workspace, '.local/deploy')
    await mkdir(state, { recursive: true, mode: 0o700 })
    Object.assign(env, { PORT: '8081', GGB_V3_LISTEN_HOST: '127.0.0.1',
      GGB_V3_AUTO_MIGRATE: '0', GGB_V3_SQLITE_PATH: join(state, 'runs.sqlite'),
      GGB_V3_SERVER_PEPPER: await persistentPepper(join(state, 'server-pepper')),
      GGB_V3_WORKER_SECRET: randomBytes(32).toString('hex'),
      GGB_V3_WORKER_SOCKET_PATH: join(sockets, 'worker.sock'),
      GGB_PLUGIN_CORE_TOOL_SOCKET: join(sockets, 'tool.sock'),
      GGB_V3_DSH_HOME_ROOT: join(state, 'dsh-home'),
      GGB_PLUGIN_CORE_OUTPUT_ROOT: join(state, 'runs'),
      GGB_V3_DSH_WORKSPACE_ROOT: overlay.privateWorkspace, GGB_PLUGIN_ROOT: overlay.root,
      GGB_V3_ALLOWED_ORIGIN: config.bundle ? 'http://127.0.0.1:8081' : 'http://localhost:5173',
      GGB_V3_CLIENT_DIST_DIR: config.bundle ? join(workspace, 'apps/client/dist') : '',
      GGB_V3_GEOGEBRA_ROOT: join(workspace, `apps/client/${config.bundle ? 'dist' : 'public'}/geogebra`),
      GGB_V3_DRAIN_GRACE_MS: '0' })
    const servers = [processes.start(process.execPath, ['apps/worker/lib/main.js'], workspace, env, join(output, 'worker.log')),
      processes.start(process.execPath, ['apps/api/lib/main.js'], workspace, env, join(output, 'api.log'))]
    await ready('http://127.0.0.1:8081/api/v3/health/ready', servers, processes)
    if (!config.bundle) {
      servers.push(processes.start('pnpm', ['--filter', '@ggb-copilot/client', 'run', 'dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
        workspace, env, join(output, 'vite.log')))
      await ready('http://127.0.0.1:5173', servers, processes)
    }
    console.log(`backend ready on http://127.0.0.1:8081; vendor release lock unchanged\nOpen ${config.bundle ? 'http://127.0.0.1:8081' : 'http://localhost:5173'}; Ctrl-C to stop.`)
    await save(join(output, 'ready.json'), { api: 'http://127.0.0.1:8081', mode: config.bundle ? 'bundle' : 'vite',
      processes: servers.map(item => ({ pid: item.child.pid, log: item.logPath })) })
    await Promise.race(servers.map(item => item.done))
    if (!processes.stopping) throw new Error('A server exited; inspect phase logs.')
  } finally {
    await stop()
    await rm(sockets, { recursive: true, force: true })
    await save(join(output, 'stopped.json'), { finishedAt: new Date().toISOString(), signalCode })
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (signalCode) process.exitCode = signalCode
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[deploy] ${error.message}`); process.exitCode ||= 1 })
}
