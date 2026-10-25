import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertPortFree, releasePort, options, Processes, prepareSource } from './deploy-ggb-dsh.mjs'

async function sourceFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ggb-source-launch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'source'), workspace = join(dir, 'host')
  const write = async (ref, data) => {
    const path = join(source, ref)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data))
  }
  await write('package.json', { name: 'source', type: 'module', version: '0.8.5', dependencies: { playwright: 'test' } })
  await write('dsh/package.json', { name: 'ggb-plugins-dsh', type: 'module', version: '0.8.5' })
  for (const ref of ['dist/program.js', 'dsh/server.js', 'dsh/executor.js', 'dsh/index.js',
    'dsh/cordis.patch.yml', 'dsh/locale/zh.json', 'skills/ggb-construction/worker.md',
    'viewer/index.html', 'capabilities.json', 'scripts/setup-plugin.mjs', 'scripts/setup-runtime.mjs']) {
    await write(ref, 'source-owned')
  }
  await write('dist/src/runtime-compatibility.js', 'export const runtimeCompatibility = v => ({ sourceVersion: v });')
  await write('dsh/installation.js', `
    import {readFileSync} from 'node:fs';
    export function loadInstallation() {
      const p=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
      return {pluginVersion:p.version,workerSkillSha256:'skill',executorProtocolVersion:3,
        hostProtocolVersion:3,receiptSchemaVersion:2,runtimeIdentity:{playwrightVersion:'test'}};
    }
    export function assertDshCompatibility(v) {if(v!=='sdk-test')throw new Error('incompatible SDK');}
  `)
  const runtime = { version: 'source-runtime', sha256: 'a'.repeat(64) }
  await write('runtime.lock.json', runtime)
  await write('.runtime/runtime.json', runtime)
  await mkdir(join(source, 'node_modules'))
  await mkdir(join(workspace, 'vendor'), { recursive: true })
  const release = join(workspace, 'vendor/plugin-core.lock.json')
  await writeFile(release, 'unrelated or invalid vendor release must not be read')
  const validations = []
  const loadHost = async () => ({ sdkVersion: 'sdk-test', cordisVersion: 'cordis-test', channelProtocolVersion: 8,
    loadInstalledPlugin: async (root, lockPath) => {
      const lock = JSON.parse(await readFile(lockPath, 'utf8'))
      for (const [ref, digest] of Object.entries(lock.files)) {
        assert.equal(createHash('sha256').update(await readFile(join(root, ref))).digest('hex'), digest)
      }
      validations.push(lock)
      return { assertRuntimeReady: async () => {
        const supplied = JSON.parse(await readFile(join(root, '.runtime/runtime.json'), 'utf8'))
        assert.equal(supplied.version, lock.geogebra.version)
        assert.equal(supplied.sha256, lock.geogebra.sha256)
      } }
    } })
  const output = async () => mkdtemp(join(dir, 'run-'))
  const noStage = () => assert.fail('prepared source must not install or run doctor')
  return { source, workspace, release, runtime, write, output, loadHost, validations, noStage }
}

test('uses source code, dependencies and runtime without reading or modifying vendor installations', async t => {
  const f = await sourceFixture(t)
  const out = await f.output()
  const result = await prepareSource(f.workspace, f.source, out, f.noStage, { loadHost: f.loadHost })
  assert.equal(await readFile(join(result.root, 'dist/program.js'), 'utf8'), 'source-owned')
  assert.equal(await realpath(join(result.root, 'node_modules')), await realpath(join(f.source, 'node_modules')))
  assert.equal(await realpath(join(result.root, '.runtime')), await realpath(join(f.source, '.runtime')))
  assert.equal(f.validations[0].pluginVersion, '0.8.5')
  assert.equal(f.validations[0].distribution, 'local-source-build')
  assert.equal(await readFile(f.release, 'utf8'), 'unrelated or invalid vendor release must not be read')
})

test('new source edits and version changes are adopted in isolated snapshots', async t => {
  const f = await sourceFixture(t)
  const first = await prepareSource(f.workspace, f.source, await f.output(), f.noStage, { loadHost: f.loadHost })
  await f.write('dist/program.js', 'new-source')
  await f.write('package.json', { name: 'source', type: 'module', version: '0.8.6', dependencies: { playwright: 'test' } })
  await f.write('dsh/package.json', { name: 'ggb-plugins-dsh', type: 'module', version: '0.8.6' })
  const second = await prepareSource(f.workspace, f.source, await f.output(), f.noStage, { loadHost: f.loadHost })
  assert.equal(await readFile(join(first.root, 'dist/program.js'), 'utf8'), 'source-owned')
  assert.equal(await readFile(join(second.root, 'dist/program.js'), 'utf8'), 'new-source')
  assert.equal(f.validations[1].pluginVersion, '0.8.6')
  assert.notEqual(f.validations[0].archiveSha256, f.validations[1].archiveSha256)
})

for (const state of ['missing', 'outdated']) {
  test(`prepares the ${state} source runtime through the source setup script`, async t => {
    const f = await sourceFixture(t)
    if (state === 'missing') await rm(join(f.source, '.runtime/runtime.json'))
    else await f.write('.runtime/runtime.json', { version: 'old', sha256: 'old' })
    const calls = []
    await prepareSource(f.workspace, f.source, await f.output(), async (...args) => {
      calls.push(args); await f.write('.runtime/runtime.json', f.runtime)
    }, { runtimeArchive: '/tmp/source-runtime.zip', loadHost: f.loadHost })
    assert.deepEqual(calls, [['04a-prepare-source-runtime', f.source, process.execPath,
      ['scripts/setup-runtime.mjs', '/tmp/source-runtime.zip']]])
  })
}

test('retains source version, SDK and runtime admission failures', async t => {
  const f = await sourceFixture(t)
  await f.write('dsh/package.json', { name: 'ggb-plugins-dsh', type: 'module', version: '0.8.4' })
  await assert.rejects(prepareSource(f.workspace, f.source, await f.output(), f.noStage,
    { loadHost: f.loadHost }), /manifest versions differ/)
  await f.write('dsh/package.json', { name: 'ggb-plugins-dsh', type: 'module', version: '0.8.5' })
  await assert.rejects(prepareSource(f.workspace, f.source, await f.output(), f.noStage,
    { loadHost: async () => ({ ...await f.loadHost(), sdkVersion: 'unsupported' }) }), /incompatible SDK/)
  await assert.rejects(prepareSource(f.workspace, f.source, await f.output(), f.noStage,
    { loadHost: async () => ({ ...await f.loadHost(), loadInstalledPlugin: async () => ({
      assertRuntimeReady: async () => { throw new Error('runtime rejected') } }) }) }), /runtime rejected/)
})

test('accepts explicit local build modes and rejects unknown/missing arguments', () => {
  assert.deepEqual(options(['--install', '--bundle', '--build-only', '--doctor'], { REPO: '/tmp/repo' }),
    { repo: '/tmp/repo', bundle: true, install: true, buildOnly: true, doctor: true, help: false })
  assert.equal(options(['--plugin', '/tmp/plugin'], {}).plugin, '/tmp/plugin')
  assert.equal(options(['--runtime-archive', '/tmp/runtime.zip'], {}).runtimeArchive, '/tmp/runtime.zip')
  assert.throws(() => options(['--pinned-root', '/tmp/pinned'], {}), /Unknown option/)
  assert.throws(() => options(['--production'], {}), /Unknown option/)
  assert.throws(() => options(['--plugin'], {}), /Missing value/)
  assert.throws(() => options(['--runtime-archive', '--bundle'], {}), /Missing value/)
})

test('detects an occupied loopback port before starting services', async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await assert.rejects(assertPortFree(address.port), /Port .* occupied/)
    await assert.rejects(releasePort(address.port), /Refusing to terminate this launcher/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('reports command failure without executing through a shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ggb-deploy-test-'))
  const processes = new Processes()
  try {
    const item = processes.start(process.execPath, ['-e', 'console.log(process.argv[1]);process.exit(7)', '$(should-not-run)'],
      dir, process.env, join(dir, 'failure.log'))
    assert.equal(await item.done, 7)
    assert.equal((await readFile(item.logPath, 'utf8')).trim(), '$(should-not-run)')
  } finally { await processes.stop(); await rm(dir, { recursive: true, force: true }) }
})

test('stop terminates its server process group including a grandchild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ggb-deploy-test-'))
  const processes = new Processes()
  let grandchild
  try {
    const code = `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      console.log(child.pid);setInterval(()=>{},1000)`
    const item = processes.start(process.execPath, ['-e', code], dir, process.env, join(dir, 'server.log'))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const text = await readFile(item.logPath, 'utf8')
      if (/^\d+\s*$/u.test(text)) { grandchild = Number(text); break }
      await delay(20)
    }
    assert.ok(grandchild, 'grandchild started')
    await processes.stop()
    await item.done
    let alive = true
    for (let i = 0; i < 100; i++) {
      try { process.kill(grandchild, 0) } catch (error) { if (error.code === 'ESRCH') { alive = false; break } }
      await delay(20)
    }
    assert.equal(alive, false, 'grandchild exited')
    assert.throws(() => processes.start(process.execPath, [], dir, process.env, item.logPath), /stopped/)
  } finally { await processes.stop(); await rm(dir, { recursive: true, force: true }) }
})

for (const ignoreTerm of [false, true]) {
  test(`releases a real listener with ${ignoreTerm ? 'SIGKILL after timeout' : 'SIGTERM only'}`, async () => {
    const code = `const {createServer}=require('node:net');
      ${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}
      createServer().listen(0,'127.0.0.1',function(){process.send({port:this.address().port})});`
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const exited = once(child, 'exit')
    try {
      const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) })
      const logs = []
      await releasePort(message.port, line => logs.push(line), ignoreTerm ? 50 : 2000)
      const [, signal] = await exited
      assert.equal(signal, ignoreTerm ? 'SIGKILL' : 'SIGTERM')
      assert.ok(logs.some(line => line.includes(`SIGTERM PID ${child.pid}`)))
      assert.equal(logs.some(line => line.includes('SIGKILL')), ignoreTerm)
      await assertPortFree(message.port)
      // Repeating cleanup on a free port must not signal any process.
      const repeated = []
      await releasePort(message.port, line => repeated.push(line))
      assert.deepEqual(repeated, [`[deploy] port ${message.port}: available`])
    } finally { child.kill('SIGKILL'); await exited }
  })
}

test('rejects invalid cleanup ports before invoking process discovery', async () => {
  for (const port of [0, -1, 65536, 8081.5, '8081']) {
    await assert.rejects(releasePort(port), /Invalid TCP port/)
  }
})
