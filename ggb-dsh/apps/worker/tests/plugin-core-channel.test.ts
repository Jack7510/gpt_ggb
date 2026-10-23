import { WorkerDispatchClient } from '../../api/src/worker-dispatch/dispatch-client.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnection } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  channelPluginCoreCancelAckSchema, channelPluginCoreResultSchema,
  runIdSchema, signChannelMessage,
} from '@ggb-copilot/application'
import { InternalChannelServer } from '../src/internal-channel/channel-server.js'

const secret = 'a'.repeat(64)
const runId = runIdSchema.parse('run_00000000-0000-4000-8000-000000000005')
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

function send(socketPath: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    socket.setTimeout(5_000, () => socket.destroy(new Error('timeout')))
    socket.once('connect', () => socket.write(`${JSON.stringify(body)}\n`))
    const finish = (): void => {
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.destroy()
      resolve(buffer.slice(0, newline))
    }
    socket.on('data', chunk => { buffer += chunk.toString('utf8'); finish() })
    socket.once('end', finish)
    socket.once('error', reject)
  })
}

describe('plugin-core internal channel', () => {
  it('dispatches one authenticated plugin-core run and returns the bounded result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-core-channel-'))
    dirs.push(dir)
    const socketPath = join(dir, 'channel.sock')
    const pluginCore = vi.fn(async () => ({ finalResponse: 'done', delivery: null, error: null }))
    const server = new InternalChannelServer({
      socketPath, secret, workerInstanceId: 'worker-1', maxMessageBytes: 1024 * 1024,
    }, {
      pluginCore,
    })
    await server.listen()
    const client = new WorkerDispatchClient(socketPath, secret, 2000)
    try {
      const image = { mediaType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' }
      const base = { dataBase64: Buffer.from('PKbase').toString('base64'),
        sha256: 'b'.repeat(64), name: 'base.ggb' }
      const request = signChannelMessage(secret, {
        type: 'plugin-core.run', requestId: randomUUID(), issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        nonce: randomBytes(24).toString('hex'), runId,
        credential: { providerKey: 'provider-key' }, prompt: 'draw a circle', base, image,
      })
      const response = channelPluginCoreResultSchema.parse(await client.runPluginCore({ runId, providerKey: 'provider-key',
        prompt: 'draw a circle', base, image: { ...image, mediaType: 'image/png' } }))
      expect(response).toMatchObject({ type: 'plugin-core.result', finalResponse: 'done',
        delivery: null, error: null })
      const changed = Buffer.from(image.dataBase64, 'base64')
      changed[20] = changed[20]! ^ 1
      const forged = { ...request, image: { ...image, dataBase64: changed.toString('base64') } }
      expect(JSON.parse(await send(socketPath, forged))).toMatchObject({ type: 'channel.error', code: 'authentication_failed' })
      expect(pluginCore).toHaveBeenCalledTimes(1)
      expect(pluginCore).toHaveBeenCalledWith(expect.objectContaining({
        runId, prompt: 'draw a circle', credential: { providerKey: 'provider-key' }, base, image,
      }), expect.any(Function))
    } finally {
      client.close()
      await server.close()
    }
  })

  it('cancels one authenticated in-flight plugin-core run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-core-channel-'))
    dirs.push(dir)
    const socketPath = join(dir, 'channel.sock')
    const cancelPluginCore = vi.fn(async () => 'cancelled' as const)
    const server = new InternalChannelServer({
      socketPath, secret, workerInstanceId: 'worker-1', maxMessageBytes: 1024 * 1024,
    }, {
      pluginCore: async () => ({ finalResponse: '', delivery: null, error: null }),
      cancelPluginCore,
    })
    await server.listen()
    try {
      const request = signChannelMessage(secret, {
        type: 'plugin-core.cancel', requestId: randomUUID(),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        nonce: randomBytes(24).toString('hex'), runId,
      })
      const response = channelPluginCoreCancelAckSchema.parse(
        JSON.parse((await send(socketPath, request)).trim()))
      expect(response).toMatchObject({ type: 'plugin-core.cancel.ack', result: 'cancelled' })
      expect(cancelPluginCore).toHaveBeenCalledWith(expect.objectContaining({ runId }))
    } finally {
      await server.close()
    }
  })
})
