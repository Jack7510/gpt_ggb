import {
  bodyDigest,
  isTerminalPluginCoreEvent,
  pluginCoreEventToSseFrame,
  runIdSchema,
  RunError,
  type AgentEngine,
  type Metrics,
  type PluginCoreEvent,
  type PluginCoreRunView,
  type RunId,
  type RunToken,
} from '@ggb-copilot/application'
import { createHash, randomUUID } from 'node:crypto'
import { streamRunEvents } from '../event-stream/sse.js'
import type { ApiHandler, HttpContext } from '../http/http-server.js'
import { parseJsonBody, sendJson } from '../http/http-server.js'
import type { LegacyNativeRunGuard } from '../legacy/native-run-probe.js'
import type { PluginCoreRunService } from '../plugin-core/run-service.js'

export interface RouteDeps {
  sse: { pollMs: number; heartbeatMs: number }
  /** §15 metrics sink; omitted in tests that do not assert on metrics. */
  metrics?: Metrics
  /** Plugin-core run lifecycle; present when the release packs the engine. */
  pluginCore?: PluginCoreRunService
  /** Reject-only probe for retired Native runs; never reads a checkpoint. */
  legacyNativeRuns: LegacyNativeRunGuard
  agentEngine: AgentEngine
  checkWorkerReady?: () => Promise<void>
}

/** Builds the §6.1/§6.2 route table on top of the native http handler. */
export function createApiHandler(deps: RouteDeps): ApiHandler {
  return async (ctx) => {
    const segments = ctx.url.pathname.split('/').filter((segment) => segment.length > 0)
    const method = ctx.method

    // §6.1: every endpoint lives under the public `/api/v3` prefix, including the
    // non-run endpoints, so the Edge can forward `/api/` unchanged.
    if (segments[0] !== 'api' || segments[1] !== 'v3') {
      throw new RunError('not_found', 'unknown endpoint')
    }
    if (method === 'GET' && segments.length === 3 && segments[2] === 'bootstrap') {
      return sendJson(ctx.res, 200, {
        schemaVersion: 1,
        versions: {},
        provider: { allowed: ['deepseek'] },
        limits: { promptChars: 12_000, baseBytes: 8 * 1024 * 1024 },
        retention: {},
        agentEngine: deps.agentEngine,
        pluginCore: deps.pluginCore === undefined ? null : await deps.pluginCore.capacity(),
      })
    }
    if (method === 'GET' && segments.length === 4 && segments[2] === 'health' && segments[3] === 'live') {
      return sendJson(ctx.res, 200, { status: 'ok' })
    }
    if (method === 'GET' && segments.length === 4 && segments[2] === 'health' && segments[3] === 'ready') {
      if (deps.pluginCore === undefined) {
        return sendJson(ctx.res, 503, { status: 'unavailable' })
      }
      const readiness = await deps.pluginCore.healthReady()
      if (readiness.status !== 'ok') return sendJson(ctx.res, 503, readiness)
      try {
        if (!deps.checkWorkerReady) throw new Error('worker readiness unavailable')
        await deps.checkWorkerReady()
      } catch { return sendJson(ctx.res, 503, { status: 'unavailable' }) }
      const current = await deps.pluginCore.healthReady()
      return sendJson(ctx.res, current.status === 'ok' ? 200 : 503, current)
    }

    if (segments[2] === 'plugin-core') {
      await pluginCoreRoute(ctx, deps, segments, method)
      return
    }

    // The Native engine is retired. New writes are rejected explicitly; any
    // existing Native run is rejected after token verification, without reading
    // its checkpoint or mutating it.
    if (segments[2] === 'runs') {
      if (method === 'POST' && segments.length === 3) {
        throw new RunError('engine_not_supported',
          'The Native engine was removed; use /api/v3/plugin-core/runs')
      }
      if (segments.length < 4) throw new RunError('not_found', 'unknown endpoint')
      const runId = parseRunId(segments[3])
      const verdict = await deps.legacyNativeRuns.check(runId, requireToken(ctx))
      if (verdict === 'incompatible') {
        throw new RunError('checkpoint_incompatible',
          'Native nine-stage runs are retired and cannot be read or resumed')
      }
      throw new RunError('not_found', 'run not found')
    }

    throw new RunError('not_found', 'unknown endpoint')
  }
}

/** Route one `/api/v3/plugin-core` request; every other path is a 404. */
async function pluginCoreRoute(ctx: HttpContext, deps: RouteDeps,
  segments: string[], method: string): Promise<void> {
  if (deps.pluginCore === undefined) {
    throw new RunError('plugin_core_unavailable', 'plugin-core is unavailable')
  }
  if (segments[3] !== 'runs') throw new RunError('not_found', 'unknown endpoint')
  if (segments.length === 4 && method === 'POST') {
    return await createPluginCoreRun(ctx, deps.pluginCore)
  }
  if (segments.length < 5) throw new RunError('not_found', 'unknown endpoint')
  const runId = parseRunId(segments[4])
  const token = requireToken(ctx)
  if (segments.length === 5 && method === 'GET') {
    sendJson(ctx.res, 200, await deps.pluginCore.getRunView(runId, token))
    return
  }
  if (segments.length === 5 && method === 'DELETE') {
    await deps.pluginCore.deleteRun(runId, token)
    ctx.res.writeHead(204)
    ctx.res.end()
    return
  }
  if (segments.length === 6 && segments[5] === 'events' && method === 'GET') {
    return await streamPluginCoreEvents(ctx, deps, deps.pluginCore, runId, token)
  }
  if (segments.length === 6 && segments[5] === 'stop' && method === 'POST') {
    sendJson(ctx.res, 200, await deps.pluginCore.stop(runId, token))
    return
  }
  if (segments.length === 7 && segments[5] === 'artifacts' && method === 'GET') {
    return await sendPluginCoreArtifact(ctx, deps.pluginCore, runId, token, segments[6]!)
  }
  throw new RunError('not_found', 'unknown endpoint')
}

async function createPluginCoreRun(ctx: HttpContext,
  service: PluginCoreRunService): Promise<void> {
  const token = requireToken(ctx)
  const providerHeader = ctx.req.headers['x-ggb-provider-key']
  const providerKey = typeof providerHeader === 'string' ? providerHeader.trim() : ''
  if (providerKey.length === 0) {
    throw new RunError('invalid_request', 'x-ggb-provider-key is required')
  }
  const body = parseJsonBody(ctx.body)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RunError('invalid_request', 'request body must be an object')
  }
  const record = body as Record<string, unknown>
  if (typeof record.runId !== 'string') {
    throw new RunError('invalid_request', 'runId is required')
  }
  const runId = parseRunId(record.runId)
  const prompt = record.prompt
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 12_000) {
    throw new RunError('invalid_request', 'prompt must be 1..12000 characters')
  }
  const idempotency = ctx.req.headers['idempotency-key']
  if (typeof idempotency !== 'string' || idempotency.length === 0) {
    throw new RunError('invalid_request', 'Idempotency-Key is required')
  }
  const base = parsePluginCoreBase(record.base) ?? null
  const result = await service.createRun({
    runId,
    runToken: token,
    idempotencyKey: idempotency,
    providerKey,
    prompt,
    base,
    ...(record.image === undefined ? {} : { image: record.image }),
    requestDigest: bodyDigest(ctx.body),
  })
  if (ctx.url.searchParams.get('wait') === '1') {
    const view = await waitForPluginTerminal(service, runId, token)
    sendJson(ctx.res, 200, await legacyPluginResult(service, runId, token, view))
    return
  }
  sendJson(ctx.res, 202, result)
}

async function streamPluginCoreEvents(ctx: HttpContext, deps: RouteDeps,
  service: PluginCoreRunService, runId: RunId, token: RunToken): Promise<void> {
  const view = await service.getRunView(runId, token)
  const source = await service.eventsSource(runId, token)
  const after = Math.max(0, Number(ctx.url.searchParams.get('after') ?? '0') || 0)
  streamRunEvents<PluginCoreEvent>({
    store: {
      listRunEvents: (id, afterEventId, limit) =>
        source.listEvents(id, afterEventId, limit),
    },
    runId,
    after,
    pollMs: deps.sse.pollMs,
    heartbeatMs: deps.sse.heartbeatMs,
    res: ctx.res,
    ready: {
      schemaVersion: 1,
      type: 'plugin_core.ready',
      generation: randomUUID(),
      run: view,
      cursor: view.events.latestEventId ?? 0,
      terminal: view.terminal,
    },
    readyEvent: 'plugin_core.ready',
    frame: pluginCoreEventToSseFrame,
    isTerminal: event => isTerminalPluginCoreEvent(event.payload),
    ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
  })
}

async function sendPluginCoreArtifact(ctx: HttpContext, service: PluginCoreRunService,
  runId: RunId, token: RunToken, artifactId: string): Promise<void> {
  const artifact = await service.getArtifact(runId, token, decodeURIComponent(artifactId))
  const bytes = Buffer.from(artifact.contentBase64, 'base64')
  ctx.res.writeHead(200, {
    'content-type': artifact.record.contentType,
    'content-length': bytes.length,
    'x-ggb-sha256': artifact.record.sha256,
    'cache-control': 'no-store',
  })
  ctx.res.end(bytes)
}

async function waitForPluginTerminal(service: PluginCoreRunService,
  runId: RunId, token: RunToken): Promise<PluginCoreRunView> {
  const deadline = Date.now() + 14 * 60_000
  for (;;) {
    const view = await service.getRunView(runId, token)
    if (view.terminal) return view
    if (Date.now() >= deadline) {
      throw new RunError('plugin_core_unavailable',
        'plugin-core did not reach a terminal state before the wait deadline')
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** Compatibility projection for the authorized batch tools. */
async function legacyPluginResult(service: PluginCoreRunService, runId: RunId,
  token: RunToken, view: PluginCoreRunView): Promise<Record<string, unknown>> {
  const artifacts = view.delivery?.artifacts ?? []
  const ggb = artifacts.find(artifact => artifact.kind === 'result_ggb')
  const preview = artifacts.find(artifact => artifact.kind === 'preview')
  const ggbBase64 = ggb === undefined ? null
    : (await service.getArtifact(runId, token, ggb.artifactId)).contentBase64
  const screenshotBase64 = preview === undefined ? null
    : (await service.getArtifact(runId, token, preview.artifactId)).contentBase64
  return {
    runId,
    finalResponse: view.finalResponse ?? '',
    delivery: view.delivery === null ? null : {
      id: view.delivery.id,
      ggbBase64,
      ggbBytes: ggb?.sizeBytes ?? 0,
      screenshotBase64,
      verification: view.delivery.verification,
    },
    error: view.failure === null ? null : {
      code: view.failure.code, message: view.failure.message,
    },
    usage: view.usage === null ? null : {
      calls: view.usage.calls,
      inputTokens: view.usage.inputTokens,
      outputTokens: view.usage.outputTokens,
      reasoningTokens: view.usage.reasoningTokens,
      cacheReadTokens: view.usage.cacheReadTokens,
      complete: view.usage.complete,
    },
    diagnostics: null,
  }
}

/** Validate a base GGB upload; the API computes its digest before the channel. */
function parsePluginCoreBase(value: unknown): { dataBase64: string; sha256: string;
  name: string | null } | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RunError('invalid_request', 'base must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.dataBase64 !== 'string' || record.dataBase64.length === 0) {
    throw new RunError('invalid_request', 'base.dataBase64 is required')
  }
  const bytes = Buffer.from(record.dataBase64, 'base64')
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
    throw new RunError('payload_too_large', 'base GGB must be 1..8388608 bytes')
  }
  if (bytes.subarray(0, 2).toString() !== 'PK') {
    throw new RunError('invalid_request', 'base GGB must be a ZIP archive')
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (record.sha256 !== undefined && record.sha256 !== sha256) {
    throw new RunError('invalid_request', 'base.sha256 does not match the upload')
  }
  const name = record.name === undefined || record.name === null ? null : record.name
  if (name !== null && (typeof name !== 'string' || name.trim().length === 0 || name.length > 256)) {
    throw new RunError('invalid_request', 'base.name must be 1..256 characters')
  }
  return { dataBase64: record.dataBase64, sha256, name }
}

function requireToken(ctx: HttpContext): RunToken {
  const header = ctx.req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new RunError('unauthorized', 'missing bearer run token')
  }
  return header.slice('Bearer '.length) as RunToken
}

function parseRunId(segment: string | undefined): RunId {
  try {
    return runIdSchema.parse(segment ?? '')
  } catch {
    throw new RunError('not_found', 'run not found')
  }
}
