import { trustedDelivery } from './fixtures/trusted-delivery.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { runIdSchema, type ChannelPluginCoreResult } from '@ggb-copilot/application'
import { MemoryPluginCoreStore } from '@ggb-copilot/run-persistence'
import type { RunningApiServer } from '../src/http/http-server.js'
import { startApiServer } from '../src/http/http-server.js'
import { createApiHandler } from '../src/routes/v3.js'
import { PluginCoreRunService } from '../src/plugin-core/run-service.js'
import type { LegacyNativeRunGuard } from '../src/legacy/native-run-probe.js'

const servers: RunningApiServer[] = []
const token = 'test-run-token'

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

function result(delivery: ChannelPluginCoreResult['delivery']): ChannelPluginCoreResult {
  return {
    type: 'plugin-core.result', requestId: crypto.randomUUID(),
    finalResponse: 'done', delivery, error: null,
    usage: { calls: 1, inputTokens: 10, outputTokens: 5,
      reasoningTokens: 0, cacheReadTokens: 0, complete: true },
    modelId: 'deepseek-flash', durationMs: 1234,
  }
}

async function fixture(runPluginCore = vi.fn(async () => result({
  id: createHash('sha256').update('PKfake').digest('hex'), ggbBase64: Buffer.from('PKfake').toString('base64'),
  ggbBytes: 6, screenshotBase64: null, verification: { construction: { passed: 1 } },
})), legacyVerdict: 'incompatible' | 'not_found' = 'incompatible') {
  const service = new PluginCoreRunService(new MemoryPluginCoreStore(),
    { runPluginCore: async (request, signal) => { const result = await runPluginCore(request, signal); return { ...result,
      delivery: result.delivery ? trustedDelivery(request.runId, result.delivery) : null,
      cleanup: { runId: request.runId, confirmed: true, completedAt: new Date().toISOString() } } } }, {
      engine: 'plugin_core', serverPepper: 'a'.repeat(64), maxConcurrentRuns: 2,
      activeRunTtlMs: 60_000, terminalRunTtlMs: 60_000,
    })
  const legacyNativeRuns: LegacyNativeRunGuard = {
    check: async () => legacyVerdict,
  }
  const server = await startApiServer({
    port: 0,
    listenHost: '127.0.0.1',
    maxBodyBytes: 64 * 1024,
    allowedOrigin: null,
    handler: createApiHandler({
      sse: { pollMs: 20, heartbeatMs: 50 },
      pluginCore: service,
      legacyNativeRuns,
      agentEngine: 'plugin_core',
    }),
  })
  servers.push(server)
  return { base: `http://127.0.0.1:${server.port}`, service, runPluginCore }
}

async function create(base: string, body: unknown) {
  const runId = (body as { runId: string }).runId
  return await fetch(`${base}/api/v3/plugin-core/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': runId,
      'x-ggb-provider-key': 'provider-key',
    },
    body: JSON.stringify(body),
  })
}

function request(runId: string, prompt = 'draw a circle') {
  return { runId, prompt }
}

describe('plugin-core API route', () => {
  it('forwards validated image bytes ephemerally and binds them to idempotency', async () => {
    const f = await fixture()
    const runId = 'run_00000000-0000-4000-8000-000000000891'
    const image = { mediaType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' }
    expect((await create(f.base, { ...request(runId), image })).status).toBe(202)
    await vi.waitFor(() => expect(f.runPluginCore).toHaveBeenCalled())
    expect(f.runPluginCore).toHaveBeenCalledWith(expect.objectContaining({ image }), expect.any(AbortSignal))
    const view = await f.service.getRunView(runIdSchema.parse(runId), token)
    expect(JSON.stringify(view)).not.toContain(image.dataBase64)
    expect((await create(f.base, { ...request(runId), image })).status).toBe(202)
    expect((await create(f.base, request(runId))).status).toBe(409)
    expect(f.runPluginCore).toHaveBeenCalledTimes(1)
  })
  it.each([null, { mediaType: 'image/svg+xml', dataBase64: 'AAAA' },
    { mediaType: 'image/png', dataBase64: 'data:image/png;base64,AAAA' },
    { mediaType: 'image/jpeg', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' }])('rejects invalid image before dispatch: %j', async image => {
    const f = await fixture()
    const response = await create(f.base, { ...request('run_00000000-0000-4000-8000-000000000892'), image })
    expect(response.status).toBe(400)
    expect(f.runPluginCore).not.toHaveBeenCalled()
  })

  it('creates an async run, exposes SSE state and authorizes artifacts', async () => {
    const runId = runIdSchema.parse(`run_${crypto.randomUUID()}`)
    const fixtureResult = await fixture()
    const response = await create(fixtureResult.base, request(runId))
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ runId, phase: 'accepted' })

    let view: any
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await fetch(
        `${fixtureResult.base}/api/v3/plugin-core/runs/${runId}`,
        { headers: { authorization: `Bearer ${token}` } })
      expect(current.status).toBe(200)
      view = await current.json()
      if (view.terminal) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(view.phase).toBe('completed')
    expect(view.finalResponse).toBe('done')
    expect(view.delivery.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'result_ggb' }),
    ]))
    const artifact = await fetch(
      `${fixtureResult.base}/api/v3/plugin-core/runs/${runId}/artifacts/${createHash('sha256').update('PKfake').digest('hex')}`,
      { headers: { authorization: `Bearer ${token}` } })
    expect(artifact.status).toBe(200)
    expect(Buffer.from(await artifact.arrayBuffer()).toString()).toBe('PKfake')
    const denied = await fetch(
      `${fixtureResult.base}/api/v3/plugin-core/runs/${runId}/artifacts/${createHash('sha256').update('PKfake').digest('hex')}`)
    expect(denied.status).toBe(401)
  })

  it('opens plugin-core SSE with a terminal delivery snapshot', async () => {
    const runId = runIdSchema.parse(`run_${crypto.randomUUID()}`)
    const fixtureResult = await fixture()
    const created = await create(fixtureResult.base, request(runId))
    expect(created.status).toBe(202)
    await new Promise(resolve => setTimeout(resolve, 30))
    const stream = await fetch(
      `${fixtureResult.base}/api/v3/plugin-core/runs/${runId}/events`, {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      })
    expect(stream.status).toBe(200)
    const text = await stream.text()
    expect(text).toContain('event: plugin_core.ready')
    expect(text).toContain('"phase":"completed"')
    expect(text).toContain('"kind":"result_ggb"')
  })

  it('supports the authenticated wait=1 compatibility projection', async () => {
    const runId = runIdSchema.parse(`run_${crypto.randomUUID()}`)
    const fixtureResult = await fixture()
    const response = await create(fixtureResult.base, {
      ...request(runId), wait: undefined,
    })
    expect(response.status).toBe(202)

    const runId2 = runIdSchema.parse(`run_${crypto.randomUUID()}`)
    const waited = await fetch(
      `${fixtureResult.base}/api/v3/plugin-core/runs?wait=1`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'idempotency-key': runId2,
          'x-ggb-provider-key': 'provider-key',
        },
        body: JSON.stringify({ runId: runId2, prompt: 'draw a circle' }),
      })
    expect(waited.status).toBe(200)
    const body = await waited.json() as {
      delivery: { ggbBase64: string } | null
    }
    expect(Buffer.from(body.delivery!.ggbBase64, 'base64').toString()).toBe('PKfake')
  })

  it('passes a validated base GGB to the worker', async () => {
    const runId = runIdSchema.parse(`run_${crypto.randomUUID()}`)
    const fixtureResult = await fixture()
    const baseBytes = Buffer.from('PKbase')
    const base64 = baseBytes.toString('base64')
    const response = await create(fixtureResult.base, {
      ...request(runId, 'edit the circle'),
      base: { dataBase64: base64, name: 'base.ggb' },
    })
    expect(response.status).toBe(202)
    expect(fixtureResult.runPluginCore).toHaveBeenCalledWith(expect.objectContaining({
      base: {
        dataBase64: base64,
        sha256: createHash('sha256').update(baseBytes).digest('hex'),
        name: 'base.ggb',
      },
    }), expect.any(AbortSignal))
  })

  it('rejects a base that is not a GGB ZIP', async () => {
    const runId = runIdSchema.parse(`run_${crypto.randomUUID()}`)
    const fixtureResult = await fixture()
    const response = await create(fixtureResult.base, {
      ...request(runId, 'edit'),
      base: { dataBase64: Buffer.from('not-a-zip').toString('base64') },
    })
    expect(response.status).toBe(400)
    expect(fixtureResult.runPluginCore).not.toHaveBeenCalled()
  })

  it('rejects a request without a provider key or token', async () => {
    const runId = runIdSchema.parse(`run_${crypto.randomUUID()}`)
    const fixtureResult = await fixture()
    const noKey = await fetch(`${fixtureResult.base}/api/v3/plugin-core/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'idempotency-key': runId,
      },
      body: JSON.stringify({ runId, prompt: 'draw a circle' }),
    })
    expect(noKey.status).toBe(400)
    const noToken = await fetch(`${fixtureResult.base}/api/v3/plugin-core/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': runId,
        'x-ggb-provider-key': 'provider-key',
      },
      body: JSON.stringify({ runId, prompt: 'draw a circle' }),
    })
    expect(noToken.status).toBe(401)
  })

  it('rejects a retired Native create with engine_not_supported', async () => {
    const fixtureResult = await fixture()
    const response = await fetch(`${fixtureResult.base}/api/v3/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'engine_not_supported' },
    })
  })

  it.each([
    ['resume', '/api/v3/runs/run_00000000-0000-4000-8000-000000000001/resume'],
    ['input', '/api/v3/runs/run_00000000-0000-4000-8000-000000000001/input'],
    ['recovery', '/api/v3/runs/run_00000000-0000-4000-8000-000000000001/recovery'],
    ['snapshot', '/api/v3/runs/run_00000000-0000-4000-8000-000000000001/snapshot'],
    ['observation', '/api/v3/runs/run_00000000-0000-4000-8000-000000000001/observation'],
    ['finalization', '/api/v3/runs/run_00000000-0000-4000-8000-000000000001/finalization'],
  ])('rejects the retired Native %s write for an authorized old run', async (_name, path) => {
    const fixtureResult = await fixture()
    const response = await fetch(`${fixtureResult.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'checkpoint_incompatible' },
    })
  })

  it('keeps historical Native reads, stop and delete reachable only with a valid token', async () => {
    const fixtureResult = await fixture()
    const runPath = '/api/v3/runs/run_00000000-0000-4000-8000-000000000001'
    const read = await fetch(`${fixtureResult.base}${runPath}`)
    expect(read.status).toBe(401)
    const stop = await fetch(`${fixtureResult.base}${runPath}/stop`, { method: 'POST' })
    expect(stop.status).toBe(401)
    const deleted = await fetch(`${fixtureResult.base}${runPath}`, { method: 'DELETE' })
    expect(deleted.status).toBe(401)
    const authorized = await fetch(`${fixtureResult.base}${runPath}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authorized.status).toBe(409)
    expect(await authorized.json()).toMatchObject({
      error: { code: 'checkpoint_incompatible' },
    })
  })

  it('hides an old run whose token does not own it', async () => {
    const fixtureResult = await fixture(undefined, 'not_found')
    const response = await fetch(
      `${fixtureResult.base}/api/v3/runs/run_00000000-0000-4000-8000-000000000001`,
      { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(404)
  })

  it('reports an unavailable plugin-core path', async () => {
    const server = await startApiServer({
      port: 0,
      listenHost: '127.0.0.1',
      maxBodyBytes: 4096,
      allowedOrigin: null,
      handler: createApiHandler({
        sse: { pollMs: 20, heartbeatMs: 50 },
        legacyNativeRuns: { check: async () => 'not_found' },
        agentEngine: 'plugin_core',
      }),
    })
    servers.push(server)
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/v3/plugin-core/runs`, { method: 'POST' })
    expect(response.status).toBe(503)
  })
})
