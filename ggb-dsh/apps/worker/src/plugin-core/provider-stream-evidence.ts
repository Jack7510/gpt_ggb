import { providerRequestFacts } from './provider-request-evidence.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EVIDENCE_LIMITS, redactEvidence } from './evidence.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const LIMIT = 32 * 1024
interface ToolWire {
  index: number; id: string; name: string; initial: string; deltas: string[]
  bytes: number; truncated: boolean; closed: boolean
  sdk?: string; fragments: { bytes: number; sha256: string }[]
}
interface RecordValue { [key: string]: unknown }

/** Retain timing, numeric usage, context sizes and tool input; omit headers, reasoning and text output. */
export class ProviderToolStream {
  private readonly startedAt = Date.now()
  private finishedAt: number | null = null
  private readonly usage: Record<string, number> = {}
  private sdkContract: RecordValue | null = null
  private wireContract: RecordValue | null = null
  private responseStatus: number | null = null
  sdkRequest(input: unknown): void { this.sdkContract = providerRequestFacts(input, 'sdk') }
  providerRequest(input: unknown): void { this.wireContract = providerRequestFacts(input, 'messages') }
  httpStatus(status: number): void { this.responseStatus = status }
  finish(): void { this.finishedAt ??= Date.now() }
  private buffer = ''
  private decoder = new TextDecoder()
  private tools = new Map<number, ToolWire>()
  private frameBytes = 0
  private invalidFrames = 0
  private ended = false
  private stopReason: unknown
  private failure: string | null = null
  private dropped = 0
  constructor(readonly request: number, private readonly secrets: string[]) {}

  bytes(chunk: Uint8Array): void {
    this.buffer = (this.buffer + this.decoder.decode(chunk, { stream: true })).replace(/\r\n/gu, '\n')
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) { this.buffer = ''; this.dropped++; return }
    let boundary: number
    while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const data = frame.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      this.frameBytes += Buffer.byteLength(data)
      try { this.wire(JSON.parse(data)) } catch { this.invalidFrames++ }
    }
  }

  wire(event: RecordValue): void {
    const block = event.content_block as RecordValue | undefined
    const delta = event.delta as RecordValue | undefined
    const usage = (event.type === 'message_start' ? (event.message as RecordValue | undefined)?.usage
      : event.type === 'message_delta' ? event.usage : undefined) as RecordValue | undefined
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      if (Number.isSafeInteger(usage?.[key]) && Number(usage?.[key]) >= 0) this.usage[key] = Number(usage![key])
    }
    if (event.type === 'message_stop') this.ended = true
    if (event.type === 'message_delta') this.stopReason = delta?.stop_reason
    const index = Number(event.index)
    if (event.type === 'content_block_start' && block?.type === 'tool_use') {
      if (this.tools.size >= 8) { this.dropped++; return }
      const initial = JSON.stringify(block.input) ?? ''
      this.tools.set(index, { index, id: String(block.id).slice(0, 256), name: String(block.name).slice(0, 128),
        initial: Buffer.from(initial).subarray(0, LIMIT).toString('utf8'), deltas: [], bytes: 0, truncated: Buffer.byteLength(initial) > LIMIT, closed: false, fragments: [] })
    }
    const tool = this.tools.get(index)
    if (!tool) return
    if (event.type === 'content_block_stop') tool.closed = true
    if (event.type !== 'content_block_delta' || delta?.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') return
    const text = delta.partial_json
    if (!text) return
    tool.bytes += Buffer.byteLength(text)
    if (tool.bytes > LIMIT) { tool.truncated = true; return }
    if (tool.fragments.length < 256) tool.fragments.push({ bytes: Buffer.byteLength(text), sha256: hash(text) })
    tool.deltas.push(text)
  }

  sdk(chunk: RecordValue): void {
    const block = chunk.block as RecordValue | undefined
    if (chunk.type !== 'block-end' || block?.type !== 'tool-call') return
    const tool = [...this.tools.values()].find(item => item.id === block.id)
    if (tool && typeof block.arguments === 'string' && Buffer.byteLength(block.arguments) <= LIMIT) tool.sdk = block.arguments
  }
  failed(error: unknown): void {
    const value = error as { code?: string; message?: string }
    this.failure = String(redactEvidence(String(value.code ?? value.message ?? 'stream_failed'), this.secrets)).slice(0, 256)
  }
  snapshot(): RecordValue {
    const valid = (text: string): boolean => { try { JSON.parse(text); return true } catch { return false } }
    const safe = (text: string): string => {
      let value: unknown = text
      try { value = JSON.parse(text) } catch { /* retain syntax of malformed input */ }
      const result = redactEvidence(value, this.secrets)
      const serialized = typeof result === 'string' ? result : JSON.stringify(result)
      return serialized.replace(/("[^"\n]*(?:api.?key|provider.?key|token|password|secret|credential|authorization|authentication)[^"\n]*"\s*:\s*)"(?:\\.|[^"\\])*(?:"|$)/giu, '$1"[redacted]"').slice(0, 8192)
    }
    return { request: this.request, sdkRequest: this.sdkContract, providerRequest: this.wireContract,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: this.finishedAt === null ? null : new Date(this.finishedAt).toISOString(),
      durationMs: this.finishedAt === null ? null : this.finishedAt - this.startedAt,
      usage: this.usage, stopReason: this.stopReason ?? null,
      responseStatus: this.responseStatus, wireMessageStop: this.ended, invalidFrames: this.invalidFrames,
      frameBytes: this.frameBytes, dropped: this.dropped, sdkFailure: this.failure,
      tools: [...this.tools.values()].map(tool => {
        const wire = tool.deltas.length ? tool.deltas.join('') : tool.initial
        const complete = this.stopReason !== 'max_tokens' && !tool.truncated && tool.closed && this.ended && this.dropped === 0 && this.invalidFrames === 0
        return { index: tool.index, id: tool.id, name: tool.name, initialInput: safe(tool.initial),
          deltaBytes: tool.bytes, fragments: tool.fragments, truncated: tool.truncated, complete,
          fragmentMetadataLimited: tool.fragments.length === 256,
          wireArgumentsSha256: hash(wire), wireJsonValid: valid(wire), wirePreview: safe(wire),
          sdkArgumentsSha256: tool.sdk === undefined ? null : hash(tool.sdk),
          sdkJsonValid: tool.sdk === undefined ? null : valid(tool.sdk),
          classification: !complete || tool.sdk === undefined ? 'unavailable'
            : wire !== tool.sdk ? 'sdk_assembly_mismatch'
              : valid(wire) ? 'valid' : 'provider_tool_json_invalid',
          assembly: !complete || tool.sdk === undefined ? 'unavailable'
            : wire === tool.sdk ? 'identical' : 'different' }
      }) }
  }
}

/** Shared by the public llm/stream hook and a byte-preserving fetch observer. */
export class ProviderStreamEvidence {
  readonly scope = new AsyncLocalStorage<ProviderToolStream>()
  private requests: ProviderToolStream[] = []
  private pending = Promise.resolve()
  private droppedRequests = 0
  constructor(private readonly path: string, private readonly secrets: string[]) {}
  begin(): ProviderToolStream | undefined {
    if (this.requests.length >= EVIDENCE_LIMITS.calls) { this.droppedRequests++; return undefined }
    const stream = new ProviderToolStream(this.requests.length + 1, this.secrets)
    this.requests.push(stream)
    return stream
  }
  flush(): Promise<void> {
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temp = this.path + '.tmp'
      const requests = this.requests.map(item => item.snapshot())
      let text = JSON.stringify(redactEvidence({ schemaVersion: 1, droppedRequests: this.droppedRequests, requests }, this.secrets))
      if (Buffer.byteLength(text) > 512 * 1024) {
        for (const request of requests) for (const tool of request.tools as RecordValue[]) {
          delete tool.wirePreview; delete tool.initialInput; delete tool.fragments
        }
        text = JSON.stringify(redactEvidence({ schemaVersion: 1, truncated: true, droppedRequests: this.droppedRequests, requests }, this.secrets))
      }
      await writeFile(temp, text, { mode: 0o600 })
      await rename(temp, this.path)
    }).catch(() => { /* Diagnostic storage cannot fail a model turn. */ })
    return this.pending
  }
}
