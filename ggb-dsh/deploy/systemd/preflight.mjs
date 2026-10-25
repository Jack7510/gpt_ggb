/** Offline installation admission. Never starts services, browsers or database connections. */
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Parse literal single-line EnvironmentFile values. @param {string} text @returns {Record<string, string>} */
export function parseEnvironment(text) {
  const env = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!match || Object.hasOwn(env, match[1])) throw new Error('environment_syntax_invalid')
    let value = match[2].trim()
    if (/^["']/.test(value)) {
      if (value.at(-1) !== value[0]) throw new Error('environment_syntax_invalid')
      value = value.slice(1, -1)
    } else if (/["']/.test(value)) throw new Error('environment_syntax_invalid')
    if (/[\\\n\r]/.test(value)) throw new Error('environment_syntax_invalid')
    if (/<[^>]*>|CHANGE_ME|example\.com/.test(value)) throw new Error(`environment_placeholder: ${match[1]}`)
    if (match[1] === 'NODE_OPTIONS' || /API_KEY$|^(?:GGB_V3_WORKER_SECRET|GGB_V3_SERVER_PEPPER)$/.test(match[1])) {
      throw new Error(`environment_forbidden: ${match[1]}`)
    }
    env[match[1]] = value
  }
  return env
}

/** @param {string} version @param {string} range @returns {boolean} */
export function supportsNode(version, range) {
  const current = version.replace(/^v/, '').split('.').map(Number)
  if (current.length !== 3 || current.some(n => !Number.isInteger(n) || n < 0)) return false
  return range.split('||').some(part => {
    const match = /^(\^|>=)(\d+)\.(\d+)\.(\d+)$/.exec(part.trim())
    if (!match) throw new Error('node_policy_unsupported')
    const minimum = match.slice(2).map(Number)
    const difference = current.findIndex((n, i) => n !== minimum[i])
    return (difference === -1 || current[difference] > minimum[difference])
      && (match[1] !== '^' || current[0] === minimum[0])
  })
}

/** Resolve production settings before importing installed code. @param {Record<string, string>} env @returns {void} */
export function validateProduction(env) {
  if (env.NODE_ENV !== 'production' || env.GGB_AGENT_ENGINE !== 'plugin_core'
    || env.GGB_V3_AUTO_MIGRATE !== '0' || env.GGB_V3_LISTEN_HOST !== '127.0.0.1') {
    throw new Error('production_settings_invalid')
  }
  if (!/^postgres(?:ql)?:/.test(env.GGB_V3_DATABASE_URL ?? '')) throw new Error('postgres_configuration_required')
  const origin = new URL(env.GGB_V3_ALLOWED_ORIGIN ?? '')
  if (origin.protocol !== 'https:' || origin.origin !== env.GGB_V3_ALLOWED_ORIGIN
    || !(env.GGB_V3_ALLOWED_HOSTS ?? '').split(',').map(host => host.trim()).includes(origin.hostname)) {
    throw new Error('public_origin_invalid')
  }
  for (const name of ['GGB_V3_SERVER_PEPPER_FILE', 'GGB_V3_WORKER_SECRET_FILE', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (!env[name]?.startsWith('/')) throw new Error(`absolute_path_required: ${name}`)
  }
  if (env.GGB_V3_WORKER_SOCKET_PATH !== '/run/ggb-dsh/worker.sock'
    || env.GGB_V3_DSH_HOME_ROOT !== '/run/ggb-dsh/dsh-home'
    || env.HOME !== '/run/ggb-dsh/home' || env.TMPDIR !== '/run/ggb-dsh/tmp'
    || env.XDG_CACHE_HOME !== '/run/ggb-dsh/cache'
    || env.GGB_PLUGIN_CORE_OUTPUT_ROOT !== '/var/lib/ggb-dsh/plugin-core-runs'
    || env.GGB_V3_DSH_TRACE_ROOT) throw new Error('managed_paths_invalid')
  if (!env.GGB_V3_CLIENT_DIST_DIR || !env.GGB_V3_GEOGEBRA_ROOT) throw new Error('client_assets_required')
}

/** Read secret files under the service identity. @param {Record<string, string>} env @returns {Promise<void>} */
export async function checkSecrets(env) {
  const secrets = []
  for (const name of ['GGB_V3_SERVER_PEPPER_FILE', 'GGB_V3_WORKER_SECRET_FILE']) {
    try {
      const path = env[name]
      const info = await stat(path)
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error()
      const value = (await readFile(path, 'utf8')).trim()
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error()
      secrets.push(value)
    } catch { throw new Error(`secret_invalid_or_unreadable: ${name}`) }
  }
  if (secrets[0] === secrets[1]) throw new Error('secrets_must_differ')
}

/** @template T @param {string} label @param {() => Promise<T>} check @returns {Promise<T>} */
async function stage(label, check) {
  try { return await check() }
  catch { throw new Error(label) }
}

/** Run existing validators offline. @param {string} workspace @param {Record<string, string>} env @returns {Promise<void>} */
export async function checkService(workspace, env) {
  validateProduction(env)
  const versions = JSON.parse(await readFile(join(workspace, 'config/runtime-versions.json'), 'utf8'))
  if (!supportsNode(process.versions.node, versions.node.supportedRange)) throw new Error('node_runtime_incompatible')
  await checkSecrets(env)
  // Match the environment the service will use for Playwright resource resolution.
  Object.assign(process.env, env)
  const load = path => import(pathToFileURL(join(workspace, path)).href)
  const { api, worker } = await stage('application_configuration_invalid', async () => {
    const { loadApiEnvConfig } = await load('apps/api/lib/config/env.js')
    const { loadWorkerEnvConfig } = await load('apps/worker/lib/config/env.js')
    return { api: loadApiEnvConfig(env), worker: loadWorkerEnvConfig(env) }
  })
  await stage('plugin_release_invalid', async () => (await load('tools/plugin-core-release.mjs')).verifyPluginCoreRelease(workspace))
  await stage('compiled_entry_unreadable', async () => {
    for (const role of ['api', 'worker']) await access(join(workspace, `apps/${role}/lib/main.js`), constants.R_OK)
  })
  await stage('client_assets_invalid', async () => (await load('apps/api/lib/http/static-assets.js')).createStaticAssets(api))
  const plugin = await stage('plugin_installation_invalid', async () =>
    (await load('apps/worker/lib/plugin-core/installation.js')).loadInstalledPlugin(worker.pluginCoreRoot, worker.pluginCoreLockPath))
  await stage('plugin_runtime_unavailable', () => plugin.assertRuntimeReady())
  // systemd creates absent StateDirectory/RuntimeDirectory roots with the service owner.
  for (const path of ['/var/lib/ggb-dsh', env.GGB_PLUGIN_CORE_OUTPUT_ROOT]) {
    try {
      if (await realpath(path) !== path) throw new Error('persistent_state_symlink_invalid')
      await access(path, constants.R_OK | constants.W_OK | constants.X_OK)
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('persistent_state_unwritable') }
  }
}

/** Drop privileges before loading installed code; configuration travels only through stdin.
 * @param {string} workspace @param {string} user @param {Record<string, string>} env
 * @param {typeof spawnSync} execute @returns {string}
 */
export function runServicePreflight(workspace, user, env, execute = spawnSync) {
  const result = execute('runuser', ['-u', user, '--', process.execPath,
    fileURLToPath(import.meta.url), '--service-check', workspace], {
    cwd: workspace, input: JSON.stringify(env), encoding: 'utf8',
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
    timeout: 30000, maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '')
    throw new Error('service_account_preflight_failed')
  }
  return result.stdout ?? ''
}

async function main() {
  const [mode, workspaceArg, arg, configPath = '/etc/ggb-dsh/server.env'] = process.argv.slice(2)
  const workspace = resolve(workspaceArg)
  if (mode === '--service-check') {
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    await checkService(workspace, JSON.parse(input))
    console.log('[preflight] service identity, configuration, plugin and static assets passed')
    return
  }
  if (mode !== '--user' || !arg || process.getuid?.() !== 0) throw new Error('preflight_arguments_invalid')
  const info = await stat(configPath)
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600) throw new Error('environment_permissions_invalid')
  const env = parseEnvironment(await readFile(configPath, 'utf8'))
  validateProduction(env)
  process.stdout.write(runServicePreflight(workspace, arg, env))
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Fixed diagnostics only; imported validators can include configuration values in errors.
    const message = /^(?:environment_|production_|postgres_|public_|absolute_|managed_|client_|node_|secret|persistent_|service_|preflight_|application_|compiled_|plugin_)[a-z_]+(?:: [A-Z0-9_]+)?$/.test(error.message)
      ? error.message : 'preflight_failed'
    console.error(`[preflight] ${message}`)
    process.exitCode = 1
  })
}
