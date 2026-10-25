import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSecrets, parseEnvironment, runServicePreflight, supportsNode, validateProduction } from '../deploy/systemd/preflight.mjs'

const execute = promisify(execFile)
const workspace = fileURLToPath(new URL('../', import.meta.url))
const read = path => readFile(join(workspace, path), 'utf8')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ggb-deploy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'repository/ggb-dsh')
  await mkdir(join(checkout, 'deploy'), { recursive: true })
  await cp(join(workspace, 'deploy/systemd'), join(checkout, 'deploy/systemd'), { recursive: true })
  const { stdout } = await execute('id', ['-un'])
  const user = stdout.trim() === 'root' ? 'nobody' : stdout.trim()
  return { root, checkout, user, script: join(checkout, 'deploy/systemd/install.sh') }
}

test('systemd preview derives the workspace from the checkout without installing services', async t => {
  const f = await fixture(t)
  const output = join(f.root, 'preview')
  const { stdout: group } = await execute('id', ['-g', f.user])
  await execute('sh', [f.script, f.user, '--render', output], {
    cwd: tmpdir(), env: { ...process.env, NODE_BINARY: process.execPath },
  })
  for (const role of ['api', 'worker']) {
    const unit = await readFile(join(output, `ggb-dsh-${role}.service`), 'utf8')
    assert.ok(unit.includes(`WorkingDirectory=${f.checkout}\n`))
    assert.ok(unit.includes(`User=${f.user}\nGroup=${group.trim()}\n`))
    assert.ok(unit.includes(`ExecStart=${process.execPath} apps/${role}/lib/main.js`))
    assert.doesNotMatch(unit, /@[A-Z]+@|\/opt\/ggb|\/home\/admin/)
    assert.match(unit, /KillMode=control-group/)
    assert.match(unit, /ProtectSystem=strict/)
    assert.match(unit, /Restart=on-failure/)
    assert.doesNotMatch(unit, /deploy-ggb-dsh\.sh/)
  }
  if (process.platform === 'linux') {
    await execute('systemd-analyze', ['verify', '--man=no',
      join(output, 'ggb-dsh-api.service'), join(output, 'ggb-dsh-worker.service')])
  }
})

test('unit renderer refuses root, unknown options and unsafe replacement values', async t => {
  const f = await fixture(t)
  const output = join(f.root, 'preview')
  for (const args of [['root', '--render', output], [f.user, '--unknown', output]]) {
    await assert.rejects(execute('sh', [f.script, ...args]), { code: 64 })
  }
  await assert.rejects(execute('sh', [f.script, f.user, '--render', output], {
    env: { ...process.env, NODE_BINARY: '/tmp/node%binary' },
  }), { code: 64 })
})

test('systemd config uses workspace-relative assets and the locked installed DSH plugin', async () => {
  const env = await read('deploy/systemd/server.env.example')
  const values = Object.fromEntries(env.split('\n').filter(line => line && !line.startsWith('#'))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  assert.equal(values.GGB_V3_LISTEN_HOST, '127.0.0.1')
  assert.equal(values.GGB_AGENT_ENGINE, 'plugin_core')
  assert.equal(values.GGB_V3_AUTO_MIGRATE, '0')
  assert.equal(values.GGB_PLUGIN_CORE_OUTPUT_ROOT, '/var/lib/ggb-dsh/plugin-core-runs')
  const worker = await read('deploy/systemd/ggb-dsh-worker.service')
  assert.match(worker, /StateDirectory=ggb-dsh\nStateDirectoryMode=0700/)
  assert.doesNotMatch(worker, /\/run\/ggb-dsh\/plugin-core-runs/)
  assert.equal(values.GGB_V3_CLIENT_DIST_DIR, 'apps/client/dist')
  assert.equal(values.GGB_V3_GEOGEBRA_ROOT, 'apps/client/dist/geogebra')
  assert.equal(values.GGB_PLUGIN_ROOT, undefined, 'default installation is resolved from the release lock')
  assert.equal(values.GGB_V3_DSH_WORKSPACE_ROOT, undefined)
  assert.match(values.PLAYWRIGHT_BROWSERS_PATH, /\.plugin-core-runtime\/<archive-sha256>\/ms-playwright$/)
  for (const path of ['deploy/edge/nginx.conf', 'deploy/systemd/nginx-ggb-app.conf']) {
    const nginx = await read(path)
    assert.equal(Number(nginx.match(/client_max_body_size (\d+)m/)[1]) * 1024 * 1024,
      Number(values.GGB_V3_MAX_BODY_BYTES))
    assert.match(nginx, /proxy_next_upstream off;/)
    assert.match(nginx, /proxy_buffering off;/)
    assert.match(nginx, /gzip on;/)
    assert.match(nginx, /gzip_proxied any;/)
    assert.match(nginx, /gzip_types [^;]*text\/javascript/)
    assert.doesNotMatch(nginx, /gzip_types[^;]*text\/event-stream/)
  }
})

function production() {
  return { NODE_ENV: 'production', GGB_AGENT_ENGINE: 'plugin_core', GGB_V3_AUTO_MIGRATE: '0',
    GGB_V3_LISTEN_HOST: '127.0.0.1', GGB_V3_DATABASE_URL: 'postgresql:///ggb_dsh',
    GGB_V3_ALLOWED_ORIGIN: 'https://math.test', GGB_V3_ALLOWED_HOSTS: 'math.test',
    GGB_V3_SERVER_PEPPER_FILE: '/etc/ggb-dsh/secrets/server-pepper',
    GGB_V3_WORKER_SECRET_FILE: '/etc/ggb-dsh/secrets/worker-secret',
    PLAYWRIGHT_BROWSERS_PATH: '/workspace/.plugin-core-runtime/hash/ms-playwright',
    GGB_V3_WORKER_SOCKET_PATH: '/run/ggb-dsh/worker.sock', GGB_V3_DSH_HOME_ROOT: '/run/ggb-dsh/dsh-home',
    HOME: '/run/ggb-dsh/home', TMPDIR: '/run/ggb-dsh/tmp', XDG_CACHE_HOME: '/run/ggb-dsh/cache',
    GGB_PLUGIN_CORE_OUTPUT_ROOT: '/var/lib/ggb-dsh/plugin-core-runs',
    GGB_V3_CLIENT_DIST_DIR: 'apps/client/dist', GGB_V3_GEOGEBRA_ROOT: 'apps/client/dist/geogebra' }
}

test('preflight parses literal configuration without evaluating shell expressions or exposing values', () => {
  assert.deepEqual(parseEnvironment('# comment\nPORT=8080\nHOME="/run/ggb-dsh/home"\nVALUE=$(never-execute)'),
    { PORT: '8080', HOME: '/run/ggb-dsh/home', VALUE: '$(never-execute)' })
  for (const value of ['PLAYWRIGHT_BROWSERS_PATH=<workspace>/browser', 'GGB_V3_ALLOWED_HOSTS=ggb.example.com',
    'PORT=1\nPORT=2', 'export PORT=2', 'VALUE="unterminated', 'NODE_OPTIONS=--import=malicious',
    'DEEPSEEK_API_KEY=sensitive-test-value']) {
    assert.throws(() => parseEnvironment(value), error => !error.message.includes('sensitive-test-value'))
  }
})

test('preflight enforces Node compatibility from the runtime policy', async () => {
  const config = JSON.parse(await read('config/runtime-versions.json'))
  for (const version of ['22.19.0', '22.20.1', '24.0.0', '26.5.1']) assert.ok(supportsNode(version, config.node.supportedRange))
  for (const version of ['20.19.0', '22.18.0', '23.0.0']) assert.equal(supportsNode(version, config.node.supportedRange), false)
})

test('preflight rejects unsafe production modes, volatile state and mismatched public domains', () => {
  assert.doesNotThrow(() => validateProduction(production()))
  for (const change of [{ GGB_V3_AUTO_MIGRATE: '1' }, { GGB_V3_DATABASE_URL: '' },
    { GGB_V3_ALLOWED_HOSTS: 'wrong.test' }, { GGB_V3_ALLOWED_ORIGIN: 'http://math.test' },
    { GGB_V3_LISTEN_HOST: '0.0.0.0' }, { GGB_PLUGIN_CORE_OUTPUT_ROOT: '/run/ggb-dsh/runs' },
    { PLAYWRIGHT_BROWSERS_PATH: 'relative/browser' }, { GGB_V3_DSH_HOME_ROOT: '/tmp/home' }]) {
    assert.throws(() => validateProduction({ ...production(), ...change }))
  }
})

test('preflight validates real secret files, file modes, format and independence', async t => {
  const f = await fixture(t)
  const pepper = join(f.root, 'pepper')
  const worker = join(f.root, 'worker')
  const env = { GGB_V3_SERVER_PEPPER_FILE: pepper, GGB_V3_WORKER_SECRET_FILE: worker }
  await writeFile(pepper, 'a'.repeat(64), { mode: 0o600 })
  await writeFile(worker, 'b'.repeat(64), { mode: 0o600 })
  await checkSecrets(env)
  await chmod(worker, 0o644)
  await assert.rejects(checkSecrets(env), /secret_invalid_or_unreadable/)
  await chmod(worker, 0o600)
  await writeFile(worker, 'invalid-secret')
  await assert.rejects(checkSecrets(env), error => !error.message.includes('invalid-secret'))
  await writeFile(worker, 'a'.repeat(64))
  await assert.rejects(checkSecrets(env), /secrets_must_differ/)
  await rm(worker)
  await assert.rejects(checkSecrets(env), /secret_invalid_or_unreadable/)
})

test('preflight drops to the service account, passes configuration only on stdin and fails closed', () => {
  const env = { ...production(), GGB_V3_DATABASE_URL: 'postgresql://user:private-test-password@db/ggb' }
  const execute = (command, args, options) => {
    assert.equal(command, 'runuser')
    assert.deepEqual(args.slice(0, 3), ['-u', 'service-user', '--'])
    assert.equal(args.at(-2), '--service-check')
    assert.equal(args.at(-1), '/workspace')
    assert.ok(!JSON.stringify(args).includes('private-test-password'))
    assert.ok(!JSON.stringify(options.env).includes('private-test-password'))
    assert.deepEqual(JSON.parse(options.input), env)
    return { status: 0, stdout: 'passed' }
  }
  assert.equal(runServicePreflight('/workspace', 'service-user', env, execute), 'passed')
  assert.throws(() => runServicePreflight('/workspace', 'service-user', env,
    () => ({ status: 1, stderr: '' })), /service_account_preflight_failed/)
  assert.throws(() => runServicePreflight('/workspace', 'service-user', env,
    () => ({ status: null, stderr: '', error: new Error('runuser unavailable') })), /service_account_preflight_failed/)
})

test('service preflight command requires every installed validator to pass and redacts imported errors', async t => {
  const f = await fixture(t)
  const scripts = {
    'apps/api/lib/main.js': '', 'apps/worker/lib/main.js': '',
    'apps/api/lib/config/env.js': 'export const loadApiEnvConfig = env => env',
    'apps/worker/lib/config/env.js': 'export const loadWorkerEnvConfig = env => env',
    'tools/plugin-core-release.mjs': `import {access} from 'node:fs/promises';
      export const verifyPluginCoreRelease = () => access('release-ready')`,
    'apps/api/lib/http/static-assets.js': `import {accessSync} from 'node:fs';
      export const createStaticAssets = () => accessSync('client-ready')`,
    'apps/worker/lib/plugin-core/installation.js': `import {access} from 'node:fs/promises';
      export async function loadInstalledPlugin() {
        await access('plugin-ready'); return {assertRuntimeReady:()=>access('runtime-ready')};
      }`,
    'config/runtime-versions.json': await read('config/runtime-versions.json'),
    'package.json': '{"type":"module"}',
  }
  for (const [path, source] of Object.entries(scripts)) {
    await mkdir(join(f.checkout, path, '..'), { recursive: true })
    await writeFile(join(f.checkout, path), source)
  }
  const env = production()
  for (const [name, value] of [['GGB_V3_SERVER_PEPPER_FILE', 'a'], ['GGB_V3_WORKER_SECRET_FILE', 'b']]) {
    env[name] = join(f.root, name)
    await writeFile(env[name], value.repeat(64), { mode: 0o600 })
  }
  const markers = ['release-ready', 'client-ready', 'plugin-ready', 'runtime-ready']
  for (const marker of markers) await writeFile(join(f.checkout, marker), '')
  const probe = () => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [join(f.checkout, 'deploy/systemd/preflight.mjs'),
      '--service-check', f.checkout], { cwd: f.checkout }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr })); else resolve(stdout)
    })
    child.stdin.end(JSON.stringify(env))
  })
  assert.match(await probe(), /service identity, configuration, plugin and static assets passed/)
  const errors = ['plugin_release_invalid', 'client_assets_invalid', 'plugin_installation_invalid', 'plugin_runtime_unavailable']
  for (const [index, marker] of markers.entries()) {
    await rm(join(f.checkout, marker))
    await assert.rejects(probe(), error => error.code === 1 && error.stderr.includes(errors[index]))
    await writeFile(join(f.checkout, marker), '')
  }
  await writeFile(join(f.checkout, 'apps/worker/lib/plugin-core/installation.js'),
    'throw new Error("private-test-password"); export const loadInstalledPlugin = () => {}')
  await assert.rejects(probe(), error => error.code === 1 && !error.stderr.includes('private-test-password'))
})
