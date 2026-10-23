import { expect, it } from 'vitest'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { INTERNAL_CHANNEL_PROTOCOL_VERSION, PLUGIN_CORE_LIMITS, channelPluginCoreDeliverySchema, runIdSchema } from '@ggb-copilot/application'
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
        if (request.type === 'handshake') socket.write(JSON.stringify({ type: 'handshake.accepted', protocolVersion: INTERNAL_CHANNEL_PROTOCOL_VERSION, workerInstanceId: 'fake', requestId: request.requestId }) + '\n')
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

it('ignores foreign run/request, malformed and stale progress frames without consuming the result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'progress-correlation-'))
  const path = join(root, 'channel.sock')
  const runId = runIdSchema.parse(`run_${randomUUID()}`)
  const progress = { tool: 'ggb_check', status: 'started', callId: randomUUID(),
    sequence: 1, occurredAt: new Date().toISOString() }
  const server = createServer(socket => {
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString()
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
        const send = (message: object): void => { socket.write(JSON.stringify(message) + '\n') }
        if (request.type === 'handshake') send({ type: 'handshake.accepted', protocolVersion: INTERNAL_CHANNEL_PROTOCOL_VERSION,
          workerInstanceId: 'fake', requestId: request.requestId })
        else {
          const frame = { type: 'plugin-core.progress', requestId: request.requestId, runId, progress }
          send({ ...frame, requestId: randomUUID() })
          send({ ...frame, runId: `run_${randomUUID()}` })
          send({ ...frame, progress: { ...progress, status: 'invented-planning' } })
          send(frame)
          send(frame)
          send({ ...frame, progress: { ...progress, sequence: 0 } })
          send({ type: 'plugin-core.result', requestId: request.requestId, finalResponse: 'final', delivery: null, error: null })
          send({ ...frame, progress: { ...progress, sequence: 2 } })
        }
      }
    })
  })
  const client = new WorkerDispatchClient(path, 'a'.repeat(64), 1000)
  const seen: unknown[] = []
  try {
    await new Promise<void>(resolve => server.listen(path, resolve))
    const result = await client.runPluginCore({ runId, providerKey: 'fake', prompt: 'fixture' }, undefined,
      p => { seen.push(p) })
    expect(result.finalResponse).toBe('final')
    expect(seen).toEqual([progress])
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

it('rejects an old Worker acknowledgement before sending any run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'old-worker-ack-'))
  const path = join(root, 'channel.sock')
  const messages: string[] = []
  const server = createServer(socket => {
    socket.on('data', chunk => {
      const request = JSON.parse(chunk.toString())
      messages.push(request.type)
      socket.write(JSON.stringify({ type: 'handshake.accepted', protocolVersion: 5,
        workerInstanceId: 'old', requestId: request.requestId }) + '\n')
    })
  })
  const client = new WorkerDispatchClient(path, 'a'.repeat(64), 1000)
  try {
    await new Promise<void>(resolve => server.listen(path, resolve))
    await expect(client.runPluginCore({ runId: runIdSchema.parse(`run_${randomUUID()}`), providerKey: 'fake',
      prompt: 'must not execute' })).rejects.toThrow('handshake rejected')
    expect(messages).toEqual(['handshake'])
  } finally { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})
