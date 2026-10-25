import type { PluginCoreImage } from '@ggb-copilot/application'
import { randomBytes, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { connect, type Socket } from 'node:net'
import {
  INTERNAL_CHANNEL_PROTOCOL_VERSION, PLUGIN_CORE_LIMITS,
  channelPluginCoreResultSchema, channelPluginCoreProgressSchema, channelHandshakeResponseSchema,
  type PluginCoreProgressObserver,
  signChannelMessage,
  type ChannelPluginCoreResult,
  type ChannelResponse,
  type RunId,
} from '@ggb-copilot/application'

/** Lifetime of an internal-channel request; must exceed the ack timeout. */
const CHANNEL_REQUEST_TTL_MS = 60_000
/** A plugin-core turn includes model, browser and verification work. */
const PLUGIN_CORE_REQUEST_TTL_MS = 15 * 60_000
const PLUGIN_CORE_RESPONSE_TIMEOUT_MS = 14 * 60_000
/** The response can carry a bounded GGB and screenshot as base64. */
const MAX_CHANNEL_RESPONSE_BYTES = PLUGIN_CORE_LIMITS.responseBytes

/** API-side surface for the independent plugin-core path. */
export interface PluginCoreWorkerChannel {
  runPluginCore(request: { deliveryContract?: 'legacy' | 'receipt-v1'; runId: RunId; providerKey: string; prompt: string;
    image?: PluginCoreImage; base?: { dataBase64: string; sha256: string; name: string | null } | null },
  signal?: AbortSignal, onProgress?: PluginCoreProgressObserver): Promise<ChannelPluginCoreResult>
}

interface Waiter {
  requestId: string
  onProgress?: ((message: Record<string, unknown>) => void) | undefined
  timer: NodeJS.Timeout
  resolve: (message: Record<string, unknown>) => void
  reject: (error: Error) => void
}

/**
 * API-side §7.5 channel client: NDJSON over a loopback Unix socket with
 * per-message HMAC authentication and requestId correlation. Each run owns its
 * connection and bounded decoder. Protocol failure affects only that run.
 */
export class WorkerDispatchClient implements PluginCoreWorkerChannel {
  private socket: Socket | null = null
  private connectingSocket: Socket | null = null
  private connecting: Promise<Socket> | null = null
  private buffer = ''
  private bufferedBytes = 0
  private decoder = new StringDecoder('utf8')
  private readonly runs = new Set<WorkerDispatchClient>()
  private readonly waiters = new Map<string, Waiter>()

  constructor(
    private readonly socketPath: string,
    private readonly secret: string,
    private readonly ackTimeoutMs: number,
  ) {}

  /** Fresh authenticated connection; no run, Provider request or browser launch. */
  async probe(): Promise<void> {
    const timeoutMs = Math.min(this.ackTimeoutMs, 3000)
    const isolated = new WorkerDispatchClient(this.socketPath, this.secret, timeoutMs)
    this.runs.add(isolated)
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([isolated.ensureHandshake(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('worker readiness timed out')), timeoutMs)
      })])
    } finally {
      clearTimeout(timer)
      this.runs.delete(isolated)
      isolated.close()
    }
  }

  /** One independent plugin-core run; the Worker returns the bounded delivery facts. */
  async runPluginCore(request: { deliveryContract?: 'legacy' | 'receipt-v1'; runId: RunId; providerKey: string; prompt: string;
    image?: PluginCoreImage; base?: { dataBase64: string; sha256: string; name: string | null } | null },
  signal?: AbortSignal, onProgress?: PluginCoreProgressObserver): Promise<ChannelPluginCoreResult> {
    const isolated = new WorkerDispatchClient(this.socketPath, this.secret, this.ackTimeoutMs)
    this.runs.add(isolated)
    try { return await isolated.runIsolated(request, signal, onProgress) }
    finally { this.runs.delete(isolated); isolated.close() }
  }

  private async runIsolated(request: Parameters<PluginCoreWorkerChannel['runPluginCore']>[0],
    signal?: AbortSignal, onProgress?: PluginCoreProgressObserver): Promise<ChannelPluginCoreResult> {
    const socket = await this.ensureHandshake()
    const now = Date.now()
    const requestId = randomUUID()
    let progressTail = Promise.resolve()
    let sequence = 0
    const response = this.request(socket, signChannelMessage(this.secret, {
      type: 'plugin-core.run' as const,
      deliveryContract: request.deliveryContract ?? 'receipt-v1',
      requestId,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PLUGIN_CORE_REQUEST_TTL_MS).toISOString(),
      nonce: randomBytes(24).toString('hex'),
      runId: request.runId,
      credential: { providerKey: request.providerKey },
      prompt: request.prompt,
      ...(request.image === undefined ? {} : { image: request.image }),
      base: request.base ?? null,
    }), PLUGIN_CORE_RESPONSE_TIMEOUT_MS, message => {
      const parsed = channelPluginCoreProgressSchema.safeParse(message)
      if (!parsed.success || parsed.data.runId !== request.runId || parsed.data.progress.sequence <= sequence) return
      sequence = parsed.data.progress.sequence
      progressTail = progressTail.then(async () => { await onProgress?.(parsed.data.progress) }).catch(() => {})
    })
    const cancel = (): void => {
      // Keep awaiting the final result: cancel ack proves receipt, not cleanup.
      void this.sendCancel(socket, request.runId)
    }
    if (signal?.aborted === true) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    try {
      const result = channelPluginCoreResultSchema.parse(await response)
      await progressTail
      return result
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  /** Best-effort cancel; a dead socket must not fail the aborting request. */
  private async sendCancel(socket: Socket, runId: RunId): Promise<void> {
    try {
      const now = Date.now()
      await this.request(socket, signChannelMessage(this.secret, {
        type: 'plugin-core.cancel' as const,
        requestId: randomUUID(),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + CHANNEL_REQUEST_TTL_MS).toISOString(),
        nonce: randomBytes(24).toString('hex'),
        runId,
      }), 5_000)
    } catch {
      // The Worker will also clean up through its execution deadline.
    }
  }

  /** Stops the process: closes the socket and fails pending waiters. */
  close(): void {
    for (const run of this.runs) run.close()
    this.runs.clear()
    this.closeSocket()
  }

  private closeSocket(): void {
    const socket = this.socket
    const connectingSocket = this.connectingSocket
    this.socket = null
    this.connectingSocket = null
    this.connecting = null
    this.buffer = ''
    this.bufferedBytes = 0
    this.decoder = new StringDecoder('utf8')
    if (socket !== null) socket.destroy()
    if (connectingSocket !== null) connectingSocket.destroy()
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('worker channel closed'))
    }
    this.waiters.clear()
  }

  private ensureHandshake(): Promise<Socket> {
    if (this.socket !== null) return Promise.resolve(this.socket)
    if (this.connecting !== null) return this.connecting
    this.connecting = (async () => {
      const socket = await this.connectSocket()
      try {
        const response = await this.request(
          socket,
          signChannelMessage(this.secret, {
            protocolVersion: INTERNAL_CHANNEL_PROTOCOL_VERSION,
            type: 'handshake' as const,
            requestId: randomUUID(),
            issuedAt: new Date().toISOString(),
            nonce: randomBytes(24).toString('hex'),
          }),
        )
        if (!channelHandshakeResponseSchema.safeParse(response).success) {
          socket.destroy()
          throw new Error(`worker handshake rejected: ${JSON.stringify(response)}`)
        }
        this.socket = socket
        this.connectingSocket = null
        this.connecting = null
        return socket
      } catch (error) {
        socket.destroy()
        throw error
      }
    })()
    this.connecting.catch(() => {
      if (this.connecting !== null) this.connecting = null
    })
    return this.connecting
  }

  private connectSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath)
      this.connectingSocket = socket
      const onEarlyError = (error: Error): void => {
        socket.destroy()
        reject(error)
      }
      socket.once('error', onEarlyError)
      socket.once('connect', () => {
        socket.off('error', onEarlyError)
        socket.on('error', () => this.closeSocket())
        socket.on('close', () => {
          if (this.socket === socket || this.connectingSocket === socket) this.closeSocket()
        })
        socket.on('data', (chunk: Buffer) => this.onData(chunk))
        resolve(socket)
      })
    })
  }

  private onData(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      this.bufferedBytes += part.length
      if (this.bufferedBytes > MAX_CHANNEL_RESPONSE_BYTES) { this.closeSocket(); return }
      this.buffer += this.decoder.write(part)
      if (newline === -1) return
      const line = (this.buffer + this.decoder.end()).trim()
      this.buffer = ''
      this.bufferedBytes = 0
      this.decoder = new StringDecoder('utf8')
      if (line) this.onLine(line)
      offset = end + 1
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object') return
      message = parsed as Record<string, unknown>
    } catch {
      return
    }
    const requestId = typeof message.requestId === 'string' ? message.requestId : null
    if (requestId === null) return
    const waiter = this.waiters.get(requestId)
    if (waiter === undefined) return
    if (message.type === 'plugin-core.progress') { waiter.onProgress?.(message); return }
    this.waiters.delete(requestId)
    clearTimeout(waiter.timer)
    waiter.resolve(message)
  }

  private async request(socket: Socket, message: object,
    timeoutMs = this.ackTimeoutMs, onProgress?: (message: Record<string, unknown>) => void): Promise<ChannelResponse> {
    const requestId = (message as { requestId: string }).requestId
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId)
        reject(new Error('worker ack timeout'))
      }, timeoutMs)
      this.waiters.set(requestId, { requestId, timer, resolve, reject, onProgress })
      socket.write(`${JSON.stringify(message)}\n`)
    })
    return response as ChannelResponse
  }
}
