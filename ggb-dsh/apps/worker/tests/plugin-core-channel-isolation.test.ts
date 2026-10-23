import { expect, it } from 'vitest'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLUGIN_CORE_LIMITS, channelPluginCoreDeliverySchema, runIdSchema } from '@ggb-copilot/application'
import { WorkerDispatchClient } from '../../api/src/worker-dispatch/dispatch-client.js'

it.each([false, true])('isolates an oversized response from another in-flight run (newline=%s)', async newline => {
  const root = await mkdtemp(join(tmpdir(), 'channel-isolation-'))
  const path = join(root, 'channel.sock')
  let release!: () => void
  const oversized = new Promise<void>(resolve => { release = resolve })
  const server = createServer(socket => {
    let buffer = ''
    socket.on('error', () => {})
    socket.on('data', chunk => {
      buffer += chunk.toString()
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
        if (request.type === 'handshake') socket.write(JSON.stringify({ type: 'handshake.accepted', requestId: request.requestId }) + '\n')
        else if (request.prompt === 'oversized') {
          socket.write('x'.repeat(PLUGIN_CORE_LIMITS.responseBytes + 1) + (newline ? '\n' : ''), release)
        } else void oversized.then(() => socket.write(JSON.stringify({ type: 'plugin-core.result', requestId: request.requestId,
          finalResponse: '正常中文', delivery: null, error: null }) + '\n'))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  const client = new WorkerDispatchClient(path, 'a'.repeat(64), 5000)
  const request = { runId: runIdSchema.parse(`run_${randomUUID()}`), providerKey: 'fake' }
  try {
    const bad = expect(client.runPluginCore({ ...request, prompt: 'oversized' })).rejects.toThrow('channel closed')
    const good = client.runPluginCore({ ...request, runId: runIdSchema.parse(`run_${randomUUID()}`), prompt: 'normal' })
    await bad
    expect((await good).finalResponse).toBe('正常中文')
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
}, 15000)

it('fits every maximum legal artifact combination inside the response frame and rejects one extra byte', () => {
  const b64 = (bytes: number) => Buffer.alloc(bytes).toString('base64')
  const delivery = { id: 'a'.repeat(64), ggbBase64: b64(PLUGIN_CORE_LIMITS.ggbBytes), ggbBytes: PLUGIN_CORE_LIMITS.ggbBytes,
    screenshotBase64: b64(PLUGIN_CORE_LIMITS.previewBytes), reportBase64: b64(PLUGIN_CORE_LIMITS.reportBytes),
    manifestBase64: b64(PLUGIN_CORE_LIMITS.manifestBytes), verification: {} }
  expect(channelPluginCoreDeliverySchema.safeParse(delivery).success).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(delivery)) + 800_000).toBeLessThan(PLUGIN_CORE_LIMITS.responseBytes)
  expect(channelPluginCoreDeliverySchema.safeParse({ ...delivery, reportBase64: b64(PLUGIN_CORE_LIMITS.reportBytes + 3) }).success).toBe(false)
})
