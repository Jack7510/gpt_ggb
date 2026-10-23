import {
  pluginCoreEventPayloadSchema,
  type PluginCoreEvent,
  type PluginCoreImage,
  type PluginCoreEventPayload,
  type PluginCoreRunView,
} from '@ggb-copilot/application/browser'
import { RunAdapterError } from './adapter-error.js'

export interface PluginCoreReady {
  schemaVersion: 1
  type: 'plugin_core.ready'
  generation: string
  run: PluginCoreRunView
  cursor: number
  terminal: boolean
}

export interface PluginCoreStreamHandlers {
  onReady?(ready: PluginCoreReady): void | Promise<void>
  onEvent(event: PluginCoreEvent): void | Promise<void>
  onCursor?(eventId: number): void | Promise<void>
}

export interface PluginCoreCreateInput {
  runId: string
  prompt: string
  image?: PluginCoreImage
  base: { dataBase64: string; name: string } | null
}

/** The only plugin-core HTTP surface; the run token stays in memory. */
export class PluginCoreRunAdapter {
  private readonly baseUrl: string

  constructor(private readonly options: {
    baseUrl: string
    fetch: typeof globalThis.fetch
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
  }

  async createRun(input: PluginCoreCreateInput, runToken: string,
    providerKey: string): Promise<{ runId: string; phase: string }> {
    const response = await this.send('POST', '/api/v3/plugin-core/runs',
      input, runToken, { 'x-ggb-provider-key': providerKey,
        'idempotency-key': input.runId })
    return await this.json<{ runId: string; phase: string }>(response)
  }

  async getRun(runId: string, runToken: string): Promise<PluginCoreRunView> {
    return await this.json<PluginCoreRunView>(await this.send(
      'GET', `/api/v3/plugin-core/runs/${runId}`, null, runToken))
  }

  async stop(runId: string, runToken: string): Promise<void> {
    await this.send('POST', `/api/v3/plugin-core/runs/${runId}/stop`, null, runToken)
  }

  async deleteRun(runId: string, runToken: string): Promise<void> {
    await this.send('DELETE', `/api/v3/plugin-core/runs/${runId}`, null, runToken)
  }

  async getArtifact(runId: string, runToken: string,
    artifactId: string): Promise<Uint8Array> {
    const response = await this.send('GET',
      `/api/v3/plugin-core/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}`,
      null, runToken)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Fetch-based SSE; `plugin_core.ready` is a non-persistent opening snapshot. */
  async openEventStream(runId: string, runToken: string, after: number,
    handlers: PluginCoreStreamHandlers, signal: AbortSignal): Promise<void> {
    const response = await this.send('GET',
      `/api/v3/plugin-core/runs/${runId}/events?after=${after}`,
      null, runToken, { accept: 'text/event-stream' }, signal)
    if (response.body === null) {
      throw new RunAdapterError('stream_closed', 'event stream has no body')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const ready = parsePluginReadyFrame(frame)
          if (ready !== null) {
            await handlers.onReady?.(ready)
            continue
          }
          const event = parsePluginEventFrame(frame)
          if (event === null) continue
          await handlers.onEvent(event)
          await handlers.onCursor?.(event.eventId)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async send(method: string, path: string, body: unknown,
    runToken: string | null, headers: Record<string, string> = {},
    signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await this.options.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === null ? {} : { 'content-type': 'application/json' }),
          ...(runToken === null ? {} : { authorization: `Bearer ${runToken}` }),
          ...headers,
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new RunAdapterError('stream_closed', 'request aborted')
      }
      throw new RunAdapterError('network', 'request failed')
    }
    if (!response.ok) {
      let payload: unknown = null
      try { payload = await response.json() } catch { /* non-JSON error */ }
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error
      throw new RunAdapterError(
        mapErrorCode(error?.code), error?.message ?? `request failed: ${String(response.status)}`,
        response.status)
    }
    return response
  }

  private async json<T>(response: Response): Promise<T> {
    try { return await response.json() as T } catch {
      throw new RunAdapterError('internal', 'invalid JSON response')
    }
  }
}

export function parsePluginReadyFrame(frame: string): PluginCoreReady | null {
  let eventName: string | null = null
  let data: string | null = null
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
    if (line.startsWith('data:')) data = line.slice('data:'.length).trimStart()
  }
  if (eventName !== 'plugin_core.ready' || data === null) return null
  try {
    const parsed = JSON.parse(data) as Partial<PluginCoreReady>
    return parsed.schemaVersion === 1 && parsed.type === 'plugin_core.ready'
      && typeof parsed.generation === 'string' && typeof parsed.cursor === 'number'
      && parsed.run !== undefined ? parsed as PluginCoreReady : null
  } catch { return null }
}

export function parsePluginEventFrame(frame: string): PluginCoreEvent | null {
  let data: string | null = null
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('data:')) data = line.slice('data:'.length).trimStart()
  }
  if (data === null) return null
  try {
    const decoded = JSON.parse(data) as Record<string, unknown>
    const { schemaVersion, eventId, occurredAt, runId, ...payload } = decoded
    const parsed = pluginCoreEventPayloadSchema.safeParse(payload)
    if (!parsed.success || schemaVersion !== 1 || typeof eventId !== 'number'
      || typeof occurredAt !== 'string' || typeof runId !== 'string') return null
    return {
      schemaVersion: 1, eventId, occurredAt, runId,
      payload: parsed.data as PluginCoreEventPayload,
    }
  } catch { return null }
}

function mapErrorCode(code: string | undefined): ConstructorParameters<typeof RunAdapterError>[0] {
  switch (code) {
    case 'unauthorized':
    case 'not_found':
    case 'invalid_request':
    case 'payload_too_large':
    case 'capacity_unavailable':
    case 'engine_not_supported':
    case 'plugin_core_unavailable':
      return code
    case 'internal_error':
      return 'internal'
    case 'duplicate_run_conflict':
      return 'conflict'
    default:
      return 'internal'
  }
}

