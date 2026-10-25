/** Bounded, private SDK and tool evidence; never a raw provider transcript. */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessNotification, RunResult } from '@deepseek-ai/dsh-sdk-client'
import { runIdSchema, toolArgumentsDigest, type RunId } from '@ggb-copilot/application'

export const EVIDENCE_LIMITS = Object.freeze({
  events: 256, eventBytes: 256 * 1024, calls: 64,
  payloadBytes: 32 * 1024, stringChars: 64 * 1024,
})
type RecordValue = Record<string, unknown>

export function evidenceRecord(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : {}
}

/** Keep only numeric JSON coordinates from the plugin's recoverable draft error. */
export function draftErrorLocation(error: unknown): { offset: number; line: number; column: number } | undefined {
  const value = evidenceRecord(error)
  if (value.name !== 'DraftError' || value.code !== 'draft_request_json') return undefined
  const { offset, line, column } = evidenceRecord(value.details)
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
    || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1 || line > offset + 1
    || typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1 || column > offset + 1) return undefined
  return { offset, line, column }
}

/** One redaction owner for diagnostics and the smaller model projection. */
export function redactEvidence(value: unknown, secrets: readonly string[] = [],
  model = false, depth = 0): unknown {
  if (depth > 12) return '[depth_limit]'
  if (typeof value === 'string') {
    let text = value.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/giu, '[image omitted]')
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]')
    text = text.replace(/Bearer\s+[^\s"']+|sk-[\w-]+/giu, '[redacted]')
    if (model) text = text.replace(/\/(?:Users|private|tmp|var|opt|home|app|server|etc|run)\/[^\s"'<>]+|[A-Z]:\\[^\s"']+/gu, '[server_path]')
    return text.length <= EVIDENCE_LIMITS.stringChars ? text : text.slice(-EVIDENCE_LIMITS.stringChars)
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) {
    const items = value.slice(0, 256).map(item => redactEvidence(item, secrets, model, depth + 1))
    return value.length > 256 ? { truncated: true, originalItems: value.length, items } : items
  }
  if (typeof value !== 'object') return null
  const result: RecordValue = {}
  const image = value as RecordValue
  const isImage = image.type === 'image' || [image.mediaType, image.mimeType, image.media_type]
    .some(type => typeof type === 'string' && type.startsWith('image/'))
  for (const [key, item] of Object.entries(value).slice(0, 256)) {
    if (isImage && /^(data|dataBase64|source|url)$/u.test(key)) continue
    if (/authorization|authentication|api.?key|provider.?key|password|secret|credential|^(?:(?:access|refresh|auth|tool)[_-]?)?token$|_TOKEN$/iu.test(key)) continue
    if (model && /^(stderr|stderrTail|stdoutTail|stack|outputDir|baseRef|socket|home)$/iu.test(key)) continue
    Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
      value: redactEvidence(item, secrets, model, depth + 1) })
  }
  return result
}

/** Explicit exception whitelist, including causes without provider envelopes. */
export function evidenceError(error: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  const value = evidenceRecord(error)
  const result: RecordValue = { name: typeof value.name === 'string' ? value.name : 'UnknownError',
    message: typeof value.message === 'string' ? value.message : 'Non-Error failure' }
  if (value.name === 'SdkProtocolError' && typeof value.message === 'string') {
    result.message = value.message.replace(/(:\s*)(?:\{|\[)[\s\S]*$/u, '$1[payload omitted]')
  }
  for (const key of ['code', 'exitCode', 'signal', 'stderr', 'stderrTail']) {
    if (['string', 'number'].includes(typeof value[key]) || value[key] === null) result[key] = value[key]
  }
  const location = draftErrorLocation(error)
  if (location !== undefined) result.details = location
  if (error instanceof Error) result.stack = error.stack?.split('\n')
    .filter(line => /^\s*at /u.test(line)).slice(0, 8).join('\n') ?? null
  // The pinned SDK exposes these facts in TransportClosedError's public message.
  if (error instanceof Error && error.name === 'TransportClosedError') {
    const [header = '', ...tail] = error.message.split('\nstderr tail:\n')
    const exit = /(?:^|\n)exit code: (-?\d+|null)(?:\n|$)/u.exec(header)
    if (exit !== null) result.exitCode = exit[1] === 'null' ? null : Number(exit[1])
    if (tail.length > 0) result.stderrTail = tail.join('\nstderr tail:\n')
  }
  if (depth < 2 && value.cause !== undefined) result.cause = evidenceError(value.cause, secrets, depth + 1)
  if (depth < 2 && error instanceof AggregateError) result.errors = error.errors.slice(0, 3).map(item => evidenceError(item, secrets, depth + 1))
  return redactEvidence(result, secrets)
}

function bounded(value: unknown, secrets: readonly string[], limit: number): unknown {
  const safe = redactEvidence(value, secrets)
  const serialized = JSON.stringify(safe)
  return Buffer.byteLength(serialized) <= limit ? safe
    : { truncated: true, originalBytes: Buffer.byteLength(serialized), preview: serialized.slice(0, Math.floor(limit / 4)) }
}

function jsonBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : Buffer.byteLength(text)
  } catch { return null }
}

export class EvidenceWriteError extends Error {
  constructor() { super('plugin_core_evidence_write_failed'); this.name = 'EvidenceWriteError' }
}

/** A call retains exact identity even when its large payload is truncated. */
export class ToolCallEvidence {
  constructor(private readonly turn: TurnEvidence, private readonly entry: RecordValue) {}

  async update(stage: string, fields: RecordValue = {}): Promise<void> {
    Object.assign(this.entry, fields, { stage, updatedAt: new Date().toISOString() })
    await this.turn.flush()
  }

  async result(result: unknown): Promise<void> {
    this.entry.pluginResult = this.turn.payload(result)
    this.entry.pluginResultBytes = jsonBytes(result)
    const process = evidenceRecord(evidenceRecord(result).execution)
    if (process.kind !== undefined) this.entry.process = this.turn.process(process)
    await this.turn.flush()
  }

  async failed(error: unknown): Promise<void> {
    this.entry.error = this.turn.error(error)
    await this.update('failed')
  }
}

/** One turn owns the queue, secrets, SDK accounting subset and tool ledger. */
export class TurnEvidence {
  private readonly secrets = new Set<string>()
  private readonly events: RecordValue[] = []
  private readonly calls: RecordValue[] = []
  private readonly rejections: RecordValue[] = []
  private bytes = 0
  private dropped = 0
  private payloadsTruncated = 0
  private pending = Promise.resolve()
  private writeFailed = false
  private readonly facts: RecordValue = { schemaVersion: 1, phase: 'running' }

  constructor(private readonly root: string, readonly runId: RunId,
    readonly turnId: string, readonly epoch: number) {}

  get providerStreamPath(): string { return join(this.root, this.runId, 'diagnostics', this.turnId + '.stream.json') }

  addSecrets(secrets: readonly string[]): void {
    for (const secret of secrets) if (secret) this.secrets.add(secret)
  }

  payload(value: unknown): unknown { return bounded(value, [...this.secrets], EVIDENCE_LIMITS.payloadBytes) }
  error(value: unknown): unknown {
    const error = evidenceRecord(evidenceError(value, [...this.secrets]))
    const text = (key: string, limit: number): string | null => typeof error[key] === 'string'
      ? error[key].slice(-limit) : null
    return { name: text('name', 128), code: typeof error.code === 'number' ? error.code : text('code', 128),
      message: text('message', 2048), stack: text('stack', 4096),
      exitCode: error.exitCode ?? null, signal: text('signal', 32),
      stderrTail: text('stderrTail', 8192) ?? text('stderr', 8192),
      cause: bounded(error.cause, [], 8192), errors: bounded(error.errors, [], 8192) }
  }
  process(value: RecordValue): unknown {
    const result: RecordValue = {}
    for (const key of ['kind', 'cleanupConfirmed', 'exitCode', 'signal', 'stdoutBytes', 'stderrBytes']) result[key] = value[key]
    result.stderrTail = String(redactEvidence(value.stderrTail, [...this.secrets])).slice(-8192)
    result.stdoutTail = String(redactEvidence(value.stdoutTail, [...this.secrets])).slice(-4096)
    return result
  }
  model(value: unknown): unknown { return redactEvidence(value, [...this.secrets], true) }
  get truncated(): boolean { return this.dropped > 0 || this.payloadsTruncated > 0 || Number(this.facts.callsDropped ?? 0) > 0 }

  /** SDK mocks/implementations without callbacks still use the same projection. */
  returned(result: RunResult): void {
    if (this.events.some(event => event.method === 'session.event' && event.sessionId === this.turnId)) return
    for (const event of result.events ?? []) this.notification({ method: 'session.event',
      params: { sessionId: this.turnId, event } })
  }

  /** Capture only lifecycle, usage and tool identity; omit assistant content. */
  notification(notification: HarnessNotification): void {
    const event = evidenceRecord(notification.params.event)
    const data = evidenceRecord(event.data)
    const selected: RecordValue = {}
    for (const key of ['turn', 'step', 'interrupted', 'callId', 'toolCallId', 'name', 'toolName', 'status']) {
      if (['string', 'number', 'boolean'].includes(typeof data[key])) selected[key] = data[key]
    }
    const usage = evidenceRecord(data.usage)
    if (data.usage !== undefined) selected.usage = Object.fromEntries(
      ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']
        .filter(key => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0)
        .map(key => [key, usage[key]]))
    const reason = evidenceRecord(data.reason)
    if (reason.kind !== undefined) selected.reason = { kind: reason.kind,
      ...(reason.error === undefined ? {} : { error: this.error(reason.error) }) }
    if (event.type === 'tool/call' && typeof data.arguments === 'string'
      && data.arguments.length <= 128 * 1024) {
      try {
        const args: unknown = JSON.parse(data.arguments)
        selected.domainRequestDigest = toolArgumentsDigest(data.name === 'ggb_inspect' ? args
          : evidenceRecord(args).request ?? args)
      } catch { selected.argumentsInvalid = true }
    }
    const dataValue = bounded(selected, [...this.secrets], 8 * 1024)
    if (evidenceRecord(dataValue).truncated === true) this.payloadsTruncated += 1
    const value = { observedAt: new Date().toISOString(), method: notification.method.slice(0, 128),
      sessionId: typeof notification.params.sessionId === 'string' ? notification.params.sessionId.slice(0, 128) : null,
      type: typeof event.type === 'string' ? event.type.slice(0, 128) : notification.method.slice(0, 128),
      data: dataValue }
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (this.events.length >= EVIDENCE_LIMITS.events || this.bytes + bytes > EVIDENCE_LIMITS.eventBytes) {
      this.dropped += 1; return
    }
    this.bytes += bytes
    this.events.push(evidenceRecord(value))
    this.correlate()
  }

  /** This subset is consumed only by the existing SDK accounting adapter. */
  partial(): RunResult {
    return { sessionId: this.turnId, finalResponse: '', notifications: [],
      events: this.events.filter(event => event.method === 'session.event' && event.sessionId === this.turnId)
        .map(event => ({ type: event.type, data: event.data })) as unknown as RunResult['events'] }
  }

  async beginCall(identity: RecordValue): Promise<ToolCallEvidence> {
    const correlationLimited = this.calls.length >= EVIDENCE_LIMITS.calls
    if (this.calls.length >= EVIDENCE_LIMITS.calls) {
      this.facts.callLimitReached = true
      this.facts.callsDropped = Number(this.facts.callsDropped ?? 0) + 1
      this.calls.shift()
    }
    const entry = { ...identity, arguments: this.payload(identity.arguments), argumentsBytes: jsonBytes(identity.arguments),
      stage: 'admitted', admittedAt: new Date().toISOString(),
      ...(correlationLimited ? { correlationLimited: true, sdkCorrelation: 'unavailable' } : {}) }
    this.calls.push(entry)
    this.correlate()
    await this.flush()
    return new ToolCallEvidence(this, entry)
  }

  /** Match only unambiguous actual SDK calls; never equate the two identities. */
  private correlate(): void {
    const used = new Set(this.calls.map(call => call.sdkCallId).filter(Boolean))
    for (const call of this.calls) {
      if (call.sdkCallId !== undefined || call.correlationLimited === true) continue
      const candidates = this.events.filter(event => event.type === 'tool/call'
        && event.sessionId === this.turnId).map(event => evidenceRecord(event.data))
        .filter(data => typeof data.callId === 'string' && !used.has(data.callId)
          && data.name === call.toolName && data.domainRequestDigest === call.domainRequestDigest)
      call.sdkCorrelation = candidates.length > 1 ? 'ambiguous' : 'unavailable'
      if (candidates.length === 1) {
        call.sdkCallId = candidates[0]!.callId
        call.sdkCorrelation = 'matched'
        used.add(call.sdkCallId)
      }
    }
  }

  async rejected(identity: RecordValue, error: unknown): Promise<void> {
    const entry = { ...identity, error: bounded(this.error(error), [], 4096) }
    if (this.rejections.length < EVIDENCE_LIMITS.calls) this.rejections.push(entry)
    else {
      this.rejections[this.rejections.length - 1] = entry
      this.facts.rejectionsDropped = Number(this.facts.rejectionsDropped ?? 0) + 1
    }
    await this.flush()
  }

  async checkpoint(phase: string, error?: unknown): Promise<void> {
    this.facts.phase = phase
    if (error !== undefined && this.facts.failure === undefined) this.facts.failure = this.error(error)
    await this.flush()
  }

  async cleanup(error: unknown | null): Promise<void> {
    this.facts.harnessClose = error === null ? { status: 'closed' }
      : { status: 'failed', error: this.error(error) }
    await this.flush()
  }

  async flush(): Promise<void> {
    if (this.writeFailed) throw new EvidenceWriteError()
    this.pending = this.pending.then(async () => {
      const dir = join(this.root, this.runId, 'diagnostics')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, `${this.turnId}.json`)
      const data = redactEvidence({ ...this.facts, runId: this.runId, turnId: this.turnId,
        epoch: this.epoch, sdkEvents: this.events, sdkEventsDropped: this.dropped,
        sdkPayloadsTruncated: this.payloadsTruncated,
        calls: this.calls, rejections: this.rejections }, [...this.secrets])
      await writeFile(`${path}.tmp`, `${JSON.stringify(data)}\n`, { mode: 0o600 })
      await rename(`${path}.tmp`, path)
    }).catch(() => {
      this.writeFailed = true
      console.error('[worker] evidence persistence failed', this.runId, this.turnId)
      throw new EvidenceWriteError()
    })
    await this.pending
  }
}

/** Shared by SDK and authenticated tools; release only removes the lookup. */
export class PluginCoreEvidenceStore {
  private readonly turns = new Map<string, TurnEvidence>()
  constructor(private readonly root: string) {}

  begin(runId: RunId, turnId: string, epoch: number, secrets: readonly string[] = []): TurnEvidence {
    runIdSchema.parse(runId)
    if (!/^[a-f0-9-]{36}$/u.test(turnId)) throw new Error('plugin_core_evidence_turn_invalid')
    let turn = this.turns.get(turnId)
    if (turn === undefined) {
      turn = new TurnEvidence(this.root, runId, turnId, epoch)
      this.turns.set(turnId, turn)
    }
    if (turn.runId !== runId || turn.epoch !== epoch) throw new Error('plugin_core_evidence_identity_conflict')
    turn.addSecrets(secrets)
    return turn
  }

  get(turnId: string): TurnEvidence | undefined { return this.turns.get(turnId) }
  release(turnId: string): void { this.turns.delete(turnId) }
}
