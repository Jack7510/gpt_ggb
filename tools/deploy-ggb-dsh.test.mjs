import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertPortFree, releasePort, options, Processes } from './deploy-ggb-dsh.mjs'

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
