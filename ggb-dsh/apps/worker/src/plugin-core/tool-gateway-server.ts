import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { RunId } from '@ggb-copilot/application'
import { PluginCoreGateway, type PluginCoreToolName, type PluginCoreToolResult } from './gateway.js'
import { type PluginCoreEvidenceStore } from './evidence.js'
import { type HostToolProtocol, type HostToolRequest, type HostToolResponse } from './tool-protocol.js'

const MAX_CLOCK_SKEW_MS = 30_000

interface ToolGatewayOptions {
  readonly protocol: HostToolProtocol
  readonly evidence?: PluginCoreEvidenceStore
}

interface TurnBinding {
  readonly runId: RunId
  readonly epoch: number
  readonly token: Buffer
  readonly abort: AbortController
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

/** Authenticated Unix-socket transport for the independent plugin-core tools. */
export class PluginCoreToolGatewayServer {
  private server: Server | null = null
  private socketInode: number | null = null
  private readonly sockets = new Set<Socket>()
  private readonly nonces = new Map<string, number>()
  private readonly bindings = new Map<string, TurnBinding>()
  private readonly requestIds = new Set<string>()
  private readonly pending = new Map<string, Set<Promise<unknown>>>()
  private readonly protocol: HostToolProtocol

  constructor(private readonly path: string, private readonly gateway: PluginCoreGateway,
    private readonly requestTimeoutMs: number, private readonly options: ToolGatewayOptions) {
    this.protocol = options.protocol
  }

  /** The Harness receives this path through the tool environment. */
  get socketPath(): string {
    return this.path
  }

  /** Mint one turn capability. The Harness receives the token; it never reaches storage or logs. */
  openTurn(runId: RunId, turnId: string, epoch: number, signal?: AbortSignal): string {
    if (this.bindings.has(turnId)) throw new Error('plugin_core_tool_turn_already_open')
    const token = randomBytes(32).toString('hex')
    const abort = new AbortController()
    const onAbort = (): void => abort.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) abort.abort()
    this.bindings.set(turnId, { runId, epoch, token: Buffer.from(token, 'hex'), abort,
      ...(signal === undefined ? {} : { signal, onAbort }) })
    this.options.evidence?.begin(runId, turnId, epoch, [token])
    return token
  }

  closeTurn(turnId: string): void {
    const binding = this.bindings.get(turnId)
    if (binding === undefined) return
    binding.abort.abort()
    if (binding.signal !== undefined && binding.onAbort !== undefined) {
      binding.signal.removeEventListener('abort', binding.onAbort)
    }
    this.bindings.delete(turnId)
    for (const key of this.requestIds) if (key.startsWith(`${turnId}:`)) this.requestIds.delete(key)
  }

  async drainTurn(turnId: string, timeoutMs = 8000): Promise<void> {
    this.closeTurn(turnId)
    const pending = this.pending.get(turnId)
    if (!pending?.size) return
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([Promise.allSettled([...pending]), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('plugin_core_cleanup_failed')), timeoutMs)
      })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }

  async listen(): Promise<void> {
    if (this.server !== null) return
    if (existsSync(this.path)) await this.removeStaleSocket()
    const server = createServer(socket => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.path, () => { server.off('error', reject); resolve() })
    })
    chmodSync(this.path, 0o600)
    this.socketInode = statSync(this.path).ino
    this.server = server
  }

  async close(): Promise<void> {
    const cleanup = [...new Set([...this.bindings.keys(), ...this.pending.keys()])]
      .map(turnId => this.drainTurn(turnId))
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server !== null) await new Promise<void>(resolve => server.close(() => resolve()))
    if (this.socketInode !== null && existsSync(this.path)
      && statSync(this.path).ino === this.socketInode) unlinkSync(this.path)
    this.socketInode = null
    const outcomes = await Promise.allSettled(cleanup)
    if (outcomes.some(result => result.status === 'rejected')) throw new Error('plugin_core_cleanup_failed')
  }

  private async removeStaleSocket(): Promise<void> {
    const inode = statSync(this.path).ino
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(this.path)
      probe.once('connect', () => { probe.destroy(); reject(new Error('plugin_core_tool_socket_in_use')) })
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve()
        else reject(error)
      })
    })
    if (existsSync(this.path) && statSync(this.path).ino === inode) unlinkSync(this.path)
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    const requestAbort = new AbortController()
    socket.setTimeout(this.requestTimeoutMs, () => socket.destroy())
    const chunks: Buffer[] = []
    let bytes = 0
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > this.protocol.maxFrameBytes + 1) { socket.destroy(); return }
      chunks.push(chunk)
      const buffer = Buffer.concat(chunks, bytes)
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) return
      socket.removeAllListeners('data')
      if (newline !== buffer.length - 1) { socket.destroy(); return }
      void this.handle(socket, buffer.subarray(0, newline).toString('utf8'), requestAbort.signal)
        .catch(() => socket.destroy())
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => { requestAbort.abort(); this.sockets.delete(socket) })
  }

  private async handle(socket: Socket, frame: string, signal: AbortSignal): Promise<void> {
    let message: unknown
    try { message = JSON.parse(frame) } catch { socket.destroy(); return }
    let request: HostToolRequest
    try { request = this.protocol.parse(message) } catch (error) {
      await this.invalid(message, error)
      socket.destroy(); return
    }
    const now = Date.now()
    if (Math.abs(now - Date.parse(request.issuedAt)) > MAX_CLOCK_SKEW_MS) {
      await this.reject(socket, request, 'request_expired'); return
    }
    if (!this.authenticate(request)) {
      await this.reject(socket, request, 'unauthorized'); return
    }
    for (const [key, expiresAt] of this.nonces) if (expiresAt <= now) this.nonces.delete(key)
    const nonceKey = `${request.turnId}:${request.nonce}`
    const requestKey = `${request.turnId}:${request.requestId}`
    if (this.nonces.has(nonceKey) || this.requestIds.has(requestKey)
      || this.nonces.size >= 4096 || this.requestIds.size >= 4096) {
      await this.reject(socket, request, 'duplicate_request'); return
    }
    this.nonces.set(nonceKey, now + 60_000)
    this.requestIds.add(requestKey)
    try {
      const work = this.gateway.dispatch({
        toolName: request.toolName, runId: request.runId, turnId: request.turnId,
        epoch: request.epoch, arguments: this.protocol.arguments(request),
        wireArguments: request.arguments, argumentsDigest: request.argumentsDigest,
        requestId: request.requestId, toolCallId: request.toolCallId, protocolVersion: this.protocol.version,
      }, AbortSignal.any([signal, this.bindings.get(request.turnId)!.abort.signal]))
      const pending = this.pending.get(request.turnId) ?? new Set<Promise<unknown>>()
      this.pending.set(request.turnId, pending)
      pending.add(work)
      let result: PluginCoreToolResult
      try { result = await work } finally {
        pending.delete(work)
        if (!pending.size) this.pending.delete(request.turnId)
      }
      this.reply(socket, { protocolVersion: this.protocol.version, requestId: request.requestId,
        type: 'tool.result', result: result as unknown as HostToolResponse['result'], error: null })
    } catch (error) {
      try { await this.options.evidence?.get(request.turnId)?.rejected(
        { requestId: request.requestId, toolCallId: request.toolCallId }, error) } catch { /* storage failure is already observable */ }
      this.error(socket, request.requestId, 'internal_error')
    }
  }

  private authenticate(request: HostToolRequest): boolean {
    const binding = this.bindings.get(request.turnId)
    if (binding === undefined || binding.runId !== request.runId || binding.epoch !== request.epoch) return false
    return !binding.abort.signal.aborted && this.protocol.authenticate(binding.token.toString('hex'), request)
  }

  private async invalid(message: unknown, error: unknown): Promise<void> {
    if (message === null || typeof message !== 'object') return
    const value = message as Record<string, unknown>
    if (typeof value.turnId !== 'string') return
    const binding = this.bindings.get(value.turnId)
    if (binding?.runId !== value.runId) return
    try { await this.options.evidence?.get(value.turnId)?.rejected(
      { requestId: typeof value.requestId === 'string' ? value.requestId.slice(0, 128) : null,
        toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId.slice(0, 128) : null }, error) } catch { /* no execution on invalid frames */ }
  }

  private async reject(socket: Socket, request: HostToolRequest,
    code: NonNullable<HostToolResponse['error']>): Promise<void> {
    try {
      await this.options.evidence?.get(request.turnId)?.rejected(
        { requestId: request.requestId, toolCallId: request.toolCallId }, new Error(code))
      this.error(socket, request.requestId, code)
    } catch { this.error(socket, request.requestId, 'internal_error') }
  }

  private error(socket: Socket, requestId: string,
    error: NonNullable<HostToolResponse['error']>): void {
    this.reply(socket, { protocolVersion: this.protocol.version, requestId, type: 'tool.error', result: null, error })
  }

  private reply(socket: Socket, response: Omit<HostToolResponse, 'protocolVersion'> & { protocolVersion: 2 }): void {
    const line = `${JSON.stringify(response)}\n`
    if (Buffer.byteLength(line) > this.protocol.maxFrameBytes) throw new Error('plugin_core_tool_response_too_large')
    if (!socket.destroyed) socket.end(line)
  }
}

/** Keep the tool-name type visible to consumers that build signed requests. */
export type { PluginCoreToolName, PluginCoreToolResult }
