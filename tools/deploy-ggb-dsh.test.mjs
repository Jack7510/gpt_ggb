import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertPortFree, releasePort, options, Processes, ensurePinnedInstallation } from './deploy-ggb-dsh.mjs'

async function installationFixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'ggb-provision-test-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const lock = { archiveSha256: 'a'.repeat(64), pluginVersion: '0.8.3', sdkVersion: '0.2.1-rc.2' }
  await mkdir(join(workspace, 'vendor'))
  await writeFile(join(workspace, 'vendor/plugin-core.lock.json'), JSON.stringify(lock))
  const root = join(workspace, '.plugin-core-runtime', lock.archiveSha256)
  const marker = { ...lock, doctor: 'passed' }
  const supply = async (value = marker) => {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'provisioned.json'), JSON.stringify(value))
    await writeFile(join(root, 'runtime-ready'), 'ready')
  }
  const load = async () => ({ assertRuntimeReady: () => access(join(root, 'runtime-ready')) })
  return { workspace, root, marker, supply, load }
}

test('missing runtime runs the existing supplier with doctor, then reuses the complete installation', async t => {
  const f = await installationFixture(t)
  const calls = []
  const stage = async (...args) => { calls.push(args); await f.supply() }
  assert.equal(await ensurePinnedInstallation(f.workspace, f.root, stage, f.load), 'provisioned')
  assert.deepEqual(calls, [['04a-provision-plugin-core', f.workspace, process.execPath,
    ['tools/provision-plugin-core.mjs', '--target', f.root]]])
  assert.equal(await ensurePinnedInstallation(f.workspace, f.root, stage, f.load), 'reused')
  assert.equal(calls.length, 1, 'reuse never reruns supply or doctor')
  assert.deepEqual(await readdir(join(f.workspace, '.plugin-core-runtime')), [f.marker.archiveSha256])
})

for (const incomplete of ['missing-marker', 'missing-runtime', 'doctor-not-run']) {
  test(`preserves and resupplies an installation with ${incomplete}`, async t => {
    const f = await installationFixture(t)
    await f.supply(incomplete === 'doctor-not-run' ? { ...f.marker, doctor: 'not_run' } : f.marker)
    if (incomplete === 'missing-marker') await rm(join(f.root, 'provisioned.json'))
    if (incomplete === 'missing-runtime') await rm(join(f.root, 'runtime-ready'))
    await writeFile(join(f.root, 'original'), 'preserve me')
    assert.equal(await ensurePinnedInstallation(f.workspace, f.root, () => f.supply(), f.load), 'provisioned')
    const backup = (await readdir(join(f.workspace, '.plugin-core-runtime'))).find(name => name.includes('.incomplete-'))
    assert.ok(backup)
    assert.equal(await readFile(join(f.root, '..', backup, 'original'), 'utf8'), 'preserve me')
    await assert.rejects(access(join(f.root, 'original')), { code: 'ENOENT' })
  })
}

test('rejects wrong marker identity and package integrity failures without replacing the installation', async t => {
  const f = await installationFixture(t)
  const never = () => assert.fail('must not provision')
  await f.supply({ ...f.marker, archiveSha256: 'b'.repeat(64) })
  await assert.rejects(ensurePinnedInstallation(f.workspace, f.root, never, f.load), /marker does not match/)
  await f.supply()
  await assert.rejects(ensurePinnedInstallation(f.workspace, f.root, never, async () => {
    throw new Error('plugin_core_package_integrity_mismatch')
  }), /integrity_mismatch/)
  assert.deepEqual(await readdir(join(f.workspace, '.plugin-core-runtime')), [f.marker.archiveSha256])
})

test('supply failure stops launch, releases its guard and allows a subsequent retry', async t => {
  const f = await installationFixture(t)
  await assert.rejects(ensurePinnedInstallation(f.workspace, f.root, async () => {
    await mkdir(f.root)
    throw new Error('doctor failed; inspect stage log')
  }, f.load), /doctor failed/)
  await assert.rejects(access(`${f.root}.provisioning`), { code: 'ENOENT' })
  assert.equal(await ensurePinnedInstallation(f.workspace, f.root, () => f.supply(), f.load), 'provisioned')
})

test('a successful command without doctor evidence or runtime readiness cannot proceed', async t => {
  const f = await installationFixture(t)
  await assert.rejects(ensurePinnedInstallation(f.workspace, f.root,
    () => f.supply({ ...f.marker, doctor: 'not_run' }), f.load), /did not produce a complete/)
  await assert.rejects(ensurePinnedInstallation(f.workspace, f.root, async () => {
    await f.supply()
    await rm(join(f.root, 'runtime-ready'))
  }, f.load), /did not produce a complete/)
})

test('concurrent launchers cannot replace a runtime while supply is in progress', async t => {
  const f = await installationFixture(t)
  let started
  let finish
  const entered = new Promise(resolve => { started = resolve })
  const waiting = new Promise(resolve => { finish = resolve })
  const first = ensurePinnedInstallation(f.workspace, f.root, async () => {
    started()
    await waiting
    await f.supply()
  }, f.load)
  try {
    await entered
    await assert.rejects(ensurePinnedInstallation(f.workspace, f.root, () => assert.fail(), f.load), /provisioning already active/)
  } finally { finish(); await first }
})

test('a concurrent release lock change during supply stops launch', async t => {
  const f = await installationFixture(t)
  await assert.rejects(ensurePinnedInstallation(f.workspace, f.root, async () => {
    await f.supply()
    await writeFile(join(f.workspace, 'vendor/plugin-core.lock.json'), '{}')
  }, f.load), /Release lock changed concurrently/)
})

test('accepts explicit local build modes and rejects unknown/missing arguments', () => {
  assert.deepEqual(options(['--install', '--bundle', '--build-only', '--doctor'], { REPO: '/tmp/repo' }),
    { repo: '/tmp/repo', bundle: true, install: true, buildOnly: true, doctor: true, help: false })
  assert.equal(options(['--plugin', '/tmp/plugin', '--pinned-root', '/tmp/pinned'], {}).pinnedRoot, '/tmp/pinned')
  assert.throws(() => options(['--production'], {}), /Unknown option/)
  assert.throws(() => options(['--plugin'], {}), /Missing value/)
  assert.throws(() => options(['--pinned-root', '--bundle'], {}), /Missing value/)
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
