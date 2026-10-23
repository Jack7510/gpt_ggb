import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INTERNAL_CHANNEL_PROTOCOL_VERSION,
  formatRunId,
  signChannelMessage,
  type ChannelPluginCoreCancelRequest,
  type ChannelPluginCoreRequest,
} from '@ggb-copilot/application'
import { WorkerDispatchClient } from '../../api/src/worker-dispatch/dispatch-client.js'
import {
  InternalChannelServer,
  type InternalChannelHandler,
} from '../src/internal-channel/channel-server.js'

const SECRET = 'a'.repeat(64)
const WORKER_INSTANCE = 'worker-instance-1'
const MAX_MESSAGE_BYTES = 8_388_608

class RecordingHandler implements InternalChannelHandler {
  readonly runs: ChannelPluginCoreRequest[] = []
  readonly cancels: ChannelPluginCoreCancelRequest[] = []

  async pluginCore(request: ChannelPluginCoreRequest): Promise<{
    finalResponse: string
    delivery: null
    error: null
  }> {
    this.runs.push(request)
    return { finalResponse: 'done', delivery: null, error: null }
  }

  async cancelPluginCore(request: ChannelPluginCoreCancelRequest):
  Promise<'cancelled' | 'not_found' | 'already_terminal'> {
    this.cancels.push(request)
    return 'cancelled'
  }
}

let dir: string
let socketPath: string
let server: InternalChannelServer
let handler: RecordingHandler

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ggb-chan-'))
  socketPath = join(dir, 'channel.sock')
  handler = new RecordingHandler()
  server = new InternalChannelServer(
    { socketPath, secret: SECRET, workerInstanceId: WORKER_INSTANCE, maxMessageBytes: MAX_MESSAGE_BYTES },
    handler,
  )
  await server.listen()
})

afterEach(async () => {
  await server.close()
})

/** Sends one signed NDJSON message over a fresh socket and reads one reply. */
async function sendRaw(message: object): Promise<Record<string, unknown>> {
  const socket = connect(socketPath)
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('channel reply timeout'))
    }, 3000)
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`))
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      clearTimeout(timer)
      const line = buffer.slice(0, newline)
      socket.destroy()
      resolve(JSON.parse(line) as Record<string, unknown>)
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function runMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now()
  return signChannelMessage(SECRET, {
    type: 'plugin-core.run' as const,
    requestId: randomUUID(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    nonce: randomBytes(24).toString('hex'),
    runId: formatRunId(randomUUID()),
    credential: { providerKey: 'sk-test' },
    prompt: 'draw a circle',
    base: null,
    ...overrides,
  })
}

describe('internal channel server', () => {
  it('restricts the socket to the owner', async () => {
    const info = await stat(socketPath)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('accepts a signed handshake and reports the worker instance', async () => {
    const response = await sendRaw(
      signChannelMessage(SECRET, {
        protocolVersion: INTERNAL_CHANNEL_PROTOCOL_VERSION,
        type: 'handshake' as const,
        requestId: randomUUID(),
        issuedAt: new Date().toISOString(),
        nonce: randomBytes(24).toString('hex'),
      }),
    )

    expect(response.type).toBe('handshake.accepted')
    expect(response.workerInstanceId).toBe(WORKER_INSTANCE)
  })

  it('rejects v1 handshakes and legacy dispatch payloads before the handler', async () => {
    const oldHandshake = signChannelMessage(SECRET, {
      protocolVersion: 1, type: 'handshake', requestId: randomUUID(),
      issuedAt: new Date().toISOString(), nonce: randomBytes(24).toString('hex'),
    })
    expect(await sendRaw(oldHandshake)).toMatchObject({ type: 'channel.error', code: 'request_invalid' })
    const oldDispatch = signChannelMessage(SECRET, {
      type: 'run.dispatch' as const, requestId: randomUUID(),
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: randomBytes(24).toString('hex'), runId: formatRunId(randomUUID()),
      leaseEpoch: 1, credential: { providerKey: null },
    })
    expect(await sendRaw(oldDispatch)).toMatchObject({
      type: 'channel.error', code: 'protocol_unsupported',
    })
    expect(handler.runs).toEqual([])
  })

  it('rejects a message signed with the wrong secret', async () => {
    const now = Date.now()
    const forged = signChannelMessage('b'.repeat(64), {
      type: 'plugin-core.run' as const,
      requestId: randomUUID(),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      nonce: randomBytes(24).toString('hex'),
      runId: formatRunId(randomUUID()),
      credential: { providerKey: null },
      prompt: 'draw a circle',
      base: null,
    })

    const response = await sendRaw(forged)

    expect(response).toMatchObject({ type: 'channel.error', code: 'authentication_failed' })
    expect(handler.runs).toEqual([])
  })

  it('forwards a valid plugin-core run once and rejects a replayed nonce', async () => {
    const message = runMessage()

    const first = await sendRaw(message)
    expect(first).toMatchObject({
      type: 'plugin-core.result', finalResponse: 'done', delivery: null, error: null,
    })
    expect(handler.runs).toHaveLength(1)
    expect(handler.runs[0]!.prompt).toBe('draw a circle')

    const replay = await sendRaw(message)
    expect(replay).toMatchObject({ type: 'channel.error', code: 'duplicate_request' })
    expect(handler.runs).toHaveLength(1)
  })

  it('contains a plugin-core handler failure and keeps the channel available', async () => {
    vi.spyOn(handler, 'pluginCore').mockRejectedValueOnce(new Error('private worker failure'))
    expect(await sendRaw(runMessage())).toMatchObject({
      type: 'channel.error', code: 'handler_failed',
    })
    expect(await sendRaw(runMessage())).toMatchObject({
      type: 'plugin-core.result', finalResponse: 'done',
    })
    expect(handler.runs).toHaveLength(1)
  })

  it('rejects an expired run without invoking the handler', async () => {
    const past = Date.now() - 120_000
    const response = await sendRaw(
      runMessage({ issuedAt: new Date(past).toISOString(), expiresAt: new Date(past).toISOString() }),
    )

    expect(response).toMatchObject({ type: 'channel.error', code: 'request_expired' })
    expect(handler.runs).toEqual([])
  })

  it('rejects a signed but malformed plugin-core payload', async () => {
    const response = await sendRaw(runMessage({ prompt: '' }))

    expect(response).toMatchObject({ type: 'channel.error', code: 'request_invalid' })
    expect(handler.runs).toEqual([])
  })

  it('reports unsupported message types', async () => {
    const response = await sendRaw(
      signChannelMessage(SECRET, {
        type: 'run.unknown' as const,
        requestId: randomUUID(),
        issuedAt: new Date().toISOString(),
        nonce: randomBytes(24).toString('hex'),
      }),
    )

    expect(response).toMatchObject({ type: 'channel.error', code: 'protocol_unsupported' })
  })

  it('forwards a signed cancel and acknowledges it', async () => {
    const now = Date.now()
    const response = await sendRaw(
      signChannelMessage(SECRET, {
        type: 'plugin-core.cancel' as const,
        requestId: randomUUID(),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        nonce: randomBytes(24).toString('hex'),
        runId: formatRunId(randomUUID()),
      }),
    )

    expect(response.type).toBe('plugin-core.cancel.ack')
    expect(response.result).toBe('cancelled')
    expect(handler.cancels).toHaveLength(1)
  })
})

describe('api plugin-core dispatch client interop', () => {
  it('completes the handshake and one plugin-core run', async () => {
    const client = new WorkerDispatchClient(socketPath, SECRET, 3000)
    const runId = formatRunId(randomUUID())

    const result = await client.runPluginCore({
      runId,
      providerKey: 'sk-interop',
      prompt: 'draw a circle',
      base: { dataBase64: 'UEtiYXNl', sha256: 'b'.repeat(64), name: 'base.ggb' },
    })

    expect(result).toMatchObject({ type: 'plugin-core.result', finalResponse: 'done' })
    expect(handler.runs).toHaveLength(1)
    expect(handler.runs[0]!.runId).toBe(runId)
    expect(handler.runs[0]!.credential.providerKey).toBe('sk-interop')
    expect(handler.runs[0]!.base).toEqual({
      dataBase64: 'UEtiYXNl', sha256: 'b'.repeat(64), name: 'base.ggb',
    })

    client.close()
  })

  it('fails when the secret does not match', async () => {
    const client = new WorkerDispatchClient(socketPath, 'b'.repeat(64), 3000)

    await expect(client.runPluginCore({
      runId: formatRunId(randomUUID()),
      providerKey: 'sk-interop',
      prompt: 'draw a circle',
    })).rejects.toThrow('handshake')

    expect(handler.runs).toEqual([])
    client.close()
  })
})
