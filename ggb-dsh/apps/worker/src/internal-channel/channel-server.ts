import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import {
  INTERNAL_CHANNEL_PROTOCOL_VERSION, PLUGIN_CORE_LIMITS, PLUGIN_CORE_PROGRESS_LIMIT, pluginCoreProgressSchema,
  type PluginCoreProgressObserver,
  channelHandshakeRequestSchema,
  channelPluginCoreCancelRequestSchema,
  channelPluginCoreRequestSchema,
  isChannelRequestExpired,
  verifyChannelAuthentication,
  type ChannelErrorCode,
  type ChannelPluginCoreCancelRequest,
  type ChannelPluginCoreRequest,
  type ChannelPluginCoreResult,
} from '@ggb-copilot/application'

export interface InternalChannelServerConfig {
  socketPath: string
  secret: string
  workerInstanceId: string
  maxMessageBytes: number
}

/** What the channel server forwards into the worker; auth is already verified. */
export interface InternalChannelHandler {
  /** One independent plugin-core run. */
  pluginCore?(request: ChannelPluginCoreRequest, onProgress: PluginCoreProgressObserver): Promise<Omit<ChannelPluginCoreResult, 'type' | 'requestId'>>
  /** Cancel one in-flight plugin-core run. */
  cancelPluginCore?(request: ChannelPluginCoreCancelRequest):
  Promise<'cancelled' | 'not_found' | 'already_terminal'>
}

/**
 * Worker side of the §7.5 internal channel: NDJSON over a 0600 Unix socket with
 * per-message HMAC authentication, requestId correlation and nonce replay
 * protection. The secret is shared with the API process via a file, never env.
 */
export class InternalChannelServer {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly seenNonces = new Map<string, number>()

  constructor(
    private readonly config: InternalChannelServerConfig,
    private readonly handler: InternalChannelHandler,
  ) {}

  async listen(): Promise<void> {
    if (this.server !== null) return
    if (existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath)
    const server = createServer((socket) => this.onConnection(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(this.config.socketPath, 0o600)
    this.server = server
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath)
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > this.config.maxMessageBytes) {
        socket.destroy()
        return
      }
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line.length > 0) void this.onLine(socket, line)
        newlineIndex = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.sockets.delete(socket))
  }

  private async onLine(socket: Socket, line: string): Promise<void> {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      message = parsed as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message.requestId !== 'string') return
    const requestId = message.requestId
    if (!verifyChannelAuthentication(this.config.secret, message)) {
      this.respondError(socket, requestId, 'authentication_failed')
      return
    }
    const now = Date.now()
    const nonce = message.nonce
    if (typeof nonce === 'string' && !this.claimNonce(nonce, now)) {
      this.respondError(socket, requestId, 'duplicate_request')
      return
    }

    if (message.type === 'handshake') {
      const parsed = channelHandshakeRequestSchema.safeParse(message)
      if (!parsed.success) {
        this.respondError(socket, requestId, 'request_invalid')
        return
      }
      this.write(socket, {
        type: 'handshake.accepted',
        protocolVersion: INTERNAL_CHANNEL_PROTOCOL_VERSION,
        requestId,
        workerInstanceId: this.config.workerInstanceId,
      })
      return
    }

    if (message.type === 'plugin-core.run') {
      const parsed = channelPluginCoreRequestSchema.safeParse(message)
      if (!parsed.success) {
        this.respondError(socket, requestId, 'request_invalid')
        return
      }
      if (isChannelRequestExpired(parsed.data.expiresAt, now)) {
        this.respondError(socket, requestId, 'request_expired')
        return
      }
      if (this.handler.pluginCore === undefined) {
        this.respondError(socket, requestId, 'handler_failed')
        return
      }
      try {
        let accepting = true
        let sequence = 0
        const result = await this.handler.pluginCore(parsed.data, progress => {
          const valid = pluginCoreProgressSchema.safeParse(progress)
          if (!accepting || !valid.success || progress.sequence <= sequence
            || sequence >= PLUGIN_CORE_PROGRESS_LIMIT || socket.writableLength > 64 * 1024) return
          sequence = progress.sequence
          this.write(socket, { type: 'plugin-core.progress', requestId, runId: parsed.data.runId, progress: valid.data })
        }).finally(() => { accepting = false })
        const response = { type: 'plugin-core.result', requestId, ...result }
        if (Buffer.byteLength(JSON.stringify(response)) > PLUGIN_CORE_LIMITS.responseBytes) {
          this.write(socket, { ...response, delivery: null, finalResponse: '', diagnostics: null, modelCalls: [],
            error: { code: 'plugin_core_delivery_invalid', message: 'Worker response exceeds its byte budget.' } })
        } else this.write(socket, response)
      } catch {
        this.respondError(socket, requestId, 'handler_failed')
      }
      return
    }

    if (message.type === 'plugin-core.cancel') {
      const parsed = channelPluginCoreCancelRequestSchema.safeParse(message)
      if (!parsed.success) {
        this.respondError(socket, requestId, 'request_invalid')
        return
      }
      if (this.handler.cancelPluginCore === undefined) {
        this.respondError(socket, requestId, 'handler_failed')
        return
      }
      try {
        const result = await this.handler.cancelPluginCore(parsed.data)
        this.write(socket, { type: 'plugin-core.cancel.ack', requestId, result })
      } catch {
        this.respondError(socket, requestId, 'handler_failed')
      }
      return
    }

    this.respondError(socket, requestId, 'protocol_unsupported')
  }

  private respondError(socket: Socket, requestId: string, code: ChannelErrorCode): void {
    this.write(socket, { type: 'channel.error', requestId, code })
  }

  private write(socket: Socket, message: object): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
  }

  /** Bounded nonce window so a replayed signed message cannot run twice. */
  private claimNonce(nonce: string, nowMs: number): boolean {
    for (const [key, expiresAt] of this.seenNonces) {
      if (expiresAt <= nowMs) this.seenNonces.delete(key)
    }
    if (this.seenNonces.has(nonce)) return false
    this.seenNonces.set(nonce, nowMs + 120_000)
    return true
  }
}
