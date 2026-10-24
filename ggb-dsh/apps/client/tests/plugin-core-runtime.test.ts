import { describe, expect, it, vi } from 'vitest'
import { interactionSummary } from '../src/app/interaction-summary.js'
import { createDirectAppletPort } from '../src/geogebra/host.js'
import { ClientRuntime, type ClientRuntimeOptions } from '../src/app/runtime.js'
import type { CanvasSummary, CanvasSnapshot, GeogebraAppletPort } from '../src/geogebra/host.js'
import { createMemoryDatabase } from '../src/persistence/indexeddb.js'
import { createMemoryArtifactStore } from '../src/persistence/opfs-artifacts.js'

const runId = 'run_00000000-0000-4000-8000-000000000201'
const artifactId = 'c'.repeat(64)

function view(phase: 'running' | 'completed') {
  return {
    runId, engine: 'plugin_core' as const, phase,
    stopRequested: false,
    finalResponse: phase === 'completed' ? 'done' : null,
    failure: null,
    delivery: phase === 'completed' ? {
      id: artifactId,
      artifacts: [{
        artifactId, kind: 'result_ggb' as const, sizeBytes: 6,
        sha256: 'c'.repeat(64), contentType: 'application/octet-stream',
      }],
      verification: { construction: { status: 'passed' } },
    } : null,
    usage: phase === 'completed' ? {
      calls: 1, inputTokens: 10, outputTokens: 5, reasoningTokens: 0,
      cacheReadTokens: 0, complete: true, source: 'sdk' as const,
    } : null,
    durationMs: phase === 'completed' ? 100 : null,
    createdAt: '2026-10-17T00:00:00.000Z',
    events: { earliestEventId: 1, latestEventId: phase === 'completed' ? 2 : 1 },
    terminal: phase === 'completed',
  }
}

function sseFrame(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
}

function harness(readyOnly = false, suppliedApplet?: GeogebraAppletPort) {
  let active: CanvasSnapshot = {
    canvasVersion: 'v0', contentBase64: 'ZW1wdHk=', contentDigest: 'empty',
  }
  let objects: unknown[] = []
  const applet: GeogebraAppletPort = suppliedApplet ?? {
    ready: async () => undefined,
    currentVersion: async () => active.canvasVersion,
    context: async () => ({ objects: objects as never, selectedLabels: [] }),
    snapshot: async () => active,
    restore: async () => {
      // GeoGebra re-serializes the file, so the canvas copy differs from the
      // delivered artifact. The download must still return the artifact bytes.
      active = {
        canvasVersion: 'v1', contentBase64: Buffer.from('reserialized').toString('base64'),
        contentDigest: 'restored',
      }
      objects = [{ label: 'A', kind: 'point', definition: '(0,0)' }]
    },
    reset: async () => { active = { canvasVersion: 'v0', contentBase64: 'ZW1wdHk=', contentDigest: 'empty' } },
    setSpace: async () => undefined,
    setViews: vi.fn(async () => undefined),
    resize: async () => undefined,
    dispose: () => undefined,
  }
  const requests: { method: string; url: string; body?: unknown }[] = []
  let getCount = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ method: init?.method ?? 'GET', url,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
    if (url.endsWith('/api/v3/plugin-core/runs') && init?.method === 'POST') {
      return new Response(JSON.stringify({ runId, phase: 'accepted' }), { status: 202 })
    }
    if (url.includes('/artifacts/')) {
      return new Response(Uint8Array.from(Buffer.from('PKfake')), { status: 200 })
    }
    if (url.includes('/events')) {
      const terminal = sseFrame('plugin_core.delivery', {
        type: 'plugin_core.delivery', schemaVersion: 1, eventId: 2,
        occurredAt: '2026-10-17T00:00:01.000Z', runId,
        finalResponse: 'done', delivery: view('completed').delivery,
        usage: view('completed').usage, durationMs: 100,
      })
      return new Response(`${sseFrame('plugin_core.ready', {
        schemaVersion: 1, type: 'plugin_core.ready', generation: 'g',
        run: view('running'), cursor: 1, terminal: false,
      })}${readyOnly ? '' : terminal}`, { status: 200 })
    }
    getCount += 1
    return new Response(JSON.stringify(view(readyOnly || getCount === 1 ? 'running' : 'completed')),
      { status: 200 })
  })
  const artifacts = createMemoryArtifactStore()
  let nextId = 0
  const db = createMemoryDatabase()
  const runtime = new ClientRuntime({
    baseUrl: '',
    presentationLocale: 'en',
    fetch: async (input, init) => {
      const response = await fetchMock(input, init)
      if (String(input).includes('/artifacts/')) return response
      // Echo the capability ID from the request, as the real Server does.
      const id = String(input).match(/\/runs\/(run_[^/?]+)/)?.[1]
        ?? (init?.body ? JSON.parse(String(init.body)).runId as string : undefined)
      return id ? new Response((await response.text()).split(runId).join(id), {
        status: response.status, headers: response.headers,
      }) : response
    },
    db,
    artifacts,
    applet,
    subtle: crypto.subtle,
    random: crypto,
    now: () => '2026-10-17T00:00:00.000Z',
    newId: () => `id-${++nextId}`,
    reload: () => undefined,
    createChannel: () => ({
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      close: () => undefined,
    }),
    locks: { request: async (_name, _options, callback) => callback({}) },
  } satisfies ClientRuntimeOptions)
  return { runtime, requests, applet, db, fetchMock, artifacts }
}

function selectionHarness() {
  let summary: CanvasSummary = { objects: [], selectedLabels: [], objectsTruncated: false }
  const snapshot = () => ({ canvasVersion: 'v0', contentDigest: JSON.stringify(summary.objects),
    contentBase64: Buffer.from('PK' + JSON.stringify(summary.objects)).toString('base64') })
  const port: GeogebraAppletPort = { ready: async () => {}, currentVersion: async () => 'v0',
    context: async () => structuredClone(summary), snapshot: vi.fn(async () => snapshot()),
    restore: async content => {
      const text = Buffer.from(content, 'base64').toString()
      summary = { objects: text === 'PKfake' ? [{ label: 'delivered', kind: 'circle', definition: '' }]
        : JSON.parse(text.slice(2)), selectedLabels: [], objectsTruncated: false }
    },
    reset: async () => { summary = { objects: [], selectedLabels: [], objectsTruncated: false } },
    setSpace: async () => {}, setViews: async () => {}, resize: async () => {}, dispose: () => {} }
  return { ...harness(true, port), select: (labels: string[]) => { summary = { ...summary, selectedLabels: labels } },
    addCircle: (label: string, caption: string) => { summary = { ...summary, objects: [...summary.objects,
      { label, kind: 'circle', caption, definition: 'Circle(P,B)' }] } },
    scene: (label: string, caption = '圆') => { summary = { objectsTruncated: false,
      selectedLabels: [], objects: [{ label, kind: 'circle', caption, definition: 'Circle(O,A)' }] } } }
}

describe('plugin-core PWA integration', () => {
  it('sends exact selected identities, records them locally and drops deselected context on the next turn', async () => {
    const h = selectionHarness()
    try {
      await h.runtime.setProviderKey('fake')
      const id = await h.runtime.createSession()
      await h.runtime.openSession(id)
      h.scene('c1', '我的圆'); h.addCircle('c2', '我的圆')
      h.select(['c1', 'c2'])
      await h.runtime.sendMessage(id, '把它们填充红色')
      const post = h.requests.find(r => r.method === 'POST')!.body as { prompt: string; base: { name: string } }
      expect(post.prompt).toContain('{"label":"c1","type":"circle","displayName":"我的圆"}')
      expect(post.prompt).toContain('{"label":"c2","type":"circle","displayName":"我的圆"}')
      expect(post.prompt).toContain('User request:\n把它们填充红色')
      expect(post.base.name).toBe(`session-${id}.ggb`)
      expect((await h.runtime.view(id)).messages[0]?.content).toBe('把它们填充红色')
      expect((await h.runtime.view(id)).title).toBe('把它们填充红色')
      h.select([])
      await h.runtime.sendMessage(id, '继续')
      expect((h.requests.filter(r => r.method === 'POST').at(-1)!.body as { prompt: string }).prompt).toBe('继续')
    } finally { h.runtime.dispose() }
  })

  it('never borrows another Session selection or baseline and does not restore old selection', async () => {
    const h = selectionHarness()
    try {
      await h.runtime.setProviderKey('fake')
      const first = await h.runtime.createSession(), second = await h.runtime.createSession()
      await h.runtime.openSession(first)
      h.scene('c1'); h.select(['c1'])
      await h.runtime.openSession(second)
      h.scene('c2'); h.select(['c2'])
      await h.runtime.sendMessage(first, '后台任务')
      const posts = () => h.requests.filter(r => r.method === 'POST').map(r => r.body as { prompt: string; base: { dataBase64: string } })
      expect(posts()[0]?.prompt).toBe('后台任务')
      expect(Buffer.from(posts()[0]!.base.dataBase64, 'base64').toString()).toContain('c1')
      expect(Buffer.from(posts()[0]!.base.dataBase64, 'base64').toString()).not.toContain('c2')
      await h.runtime.sendMessage(second, '改成蓝色')
      expect(posts()[1]?.prompt).toContain('"label":"c2"')
      expect(posts()[1]?.prompt).not.toContain('c1')
      await h.runtime.openSession(first)
      await h.runtime.sendMessage(first, '继续修改')
      expect(posts()[2]?.prompt).toBe('继续修改')
    } finally { h.runtime.dispose() }
  })

  it('refuses a Session switch during export without posting a stale selection', async () => {
    const h = selectionHarness()
    try {
      await h.runtime.setProviderKey('fake')
      const first = await h.runtime.createSession(), second = await h.runtime.createSession()
      await h.runtime.openSession(first)
      h.scene('c1'); h.select(['c1'])
      const original = h.applet.snapshot.bind(h.applet)
      let release!: () => void, entered!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      const reading = new Promise<void>(resolve => { entered = resolve })
      vi.spyOn(h.applet, 'snapshot').mockImplementationOnce(async () => {
        const captured = await original(); entered(); await pending; return captured
      })
      const outcome = h.runtime.sendMessage(first, 'red').catch(error => error as Error)
      await reading
      await h.runtime.openSession(second)
      release()
      expect(await outcome).toMatchObject({ message: 'canvas_context_changed' })
      expect(h.requests.filter(r => r.method === 'POST')).toEqual([])
      expect((await h.runtime.view(first)).messages).toEqual([])
    } finally { h.runtime.dispose() }
  })

  it('rejects a selected object that was deleted before send', async () => {
    const h = selectionHarness()
    try {
      await h.runtime.setProviderKey('fake')
      const id = await h.runtime.createSession()
      await h.runtime.openSession(id)
      h.scene('c1'); h.select(['removed'])
      await expect(h.runtime.sendMessage(id, 'red')).rejects.toThrow('selected_object_missing')
      expect(h.requests.filter(r => r.method === 'POST')).toEqual([])
    } finally { h.runtime.dispose() }
  })

  it.each([false, true])('isolates late background delivery and checks local bytes (corrupt=%s)', async corrupt => {
    const h = selectionHarness()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const originalFetch = h.fetchMock.getMockImplementation()!
    h.fetchMock.mockImplementation(async (input, init) => String(input).includes('/events')
      ? new Response(stream) : originalFetch(input, init))
    try {
      await h.runtime.setProviderKey('fake')
      const first = await h.runtime.createSession(), second = await h.runtime.createSession()
      await h.runtime.openSession(first)
      h.scene('c1'); h.select(['c1'])
      await h.runtime.sendMessage(first, 'red')
      await h.runtime.openSession(second)
      h.scene('c2'); h.select(['c2'])
      const completed = view('completed')
      controller.enqueue(new TextEncoder().encode(sseFrame('plugin_core.ready', {
        schemaVersion: 1, type: 'plugin_core.ready', generation: 'g', run: completed, cursor: 2, terminal: true,
      })))
      controller.close()
      await vi.waitFor(async () => expect((await h.runtime.view(first)).delivery).not.toBeNull())
      expect((await h.applet.context()).selectedLabels).toEqual(['c2'])
      expect((await h.applet.context()).objects[0]?.label).toBe('c2')
      expect((await h.runtime.view(first)).canvas?.digestKind).toBe('ggb-bytes')
      if (corrupt) {
        const stored = (await h.runtime.view(first)).canvas!
        await h.artifacts.put(stored.opfsPath, new TextEncoder().encode('PKcorrupt'))
        await expect(h.runtime.sendMessage(first, 'background')).rejects.toThrow('local_canvas_digest_mismatch')
        await h.runtime.openSession(first)
        expect((await h.applet.context()).objects).toEqual([])
        expect((await h.applet.context()).selectedLabels).toEqual([])
        return
      }
      await h.runtime.openSession(first)
      expect((await h.applet.context()).objects[0]?.label).toBe('delivered')
      expect((await h.applet.context()).selectedLabels).toEqual([])
      expect((await h.runtime.view(first)).canvas?.digestKind).toBeUndefined()
    } finally { h.runtime.dispose() }
  })

  it('bounds the combined selection and user prompt before creating a run', async () => {
    const h = selectionHarness()
    try {
      await h.runtime.setProviderKey('fake')
      const id = await h.runtime.createSession()
      await h.runtime.openSession(id)
      h.scene('c'); h.select(['c'])
      await expect(h.runtime.sendMessage(id, 'x'.repeat(11_999))).rejects.toThrow('plugin_core_prompt_invalid')
      expect(h.requests.filter(r => r.method === 'POST')).toEqual([])
      expect((await h.runtime.view(id)).messages).toEqual([])
    } finally { h.runtime.dispose() }
  })

  it('reconnects an interrupted stream from the durable tool cursor and receives terminal delivery once', async () => {
    const { runtime, fetchMock, db } = harness(true)
    let streams = 0
    const after: number[] = []
    const fact = { sequence: 1, tool: 'ggb_build', status: 'started', callId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-17T00:00:01.000Z', attempt: 1, limit: 3 }
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ runId, phase: 'accepted' }))
      if (String(input).includes('/artifacts/')) return new Response(Buffer.from('PKfake'))
      if (String(input).includes('/events')) {
        after.push(Number(new URL(String(input), 'http://localhost').searchParams.get('after')))
        streams++
        const running = { ...view('running'), progress: fact, events: { earliestEventId: 1, latestEventId: 3 } }
        if (streams === 1) return new Response(sseFrame('plugin_core.ready', {
          schemaVersion: 1, type: 'plugin_core.ready', generation: 'first', run: running, cursor: 3, terminal: false,
        })) // clean EOF without terminal: must reconnect
        return new Response(sseFrame('plugin_core.ready', {
          schemaVersion: 1, type: 'plugin_core.ready', generation: 'second',
          run: { ...view('completed'), progress: { ...fact, sequence: 2, status: 'accepted' },
            events: { earliestEventId: 1, latestEventId: 5 } }, cursor: 5, terminal: true,
        }))
      }
      return new Response(JSON.stringify(view('running')))
    })
    try {
      await runtime.setProviderKey('fake')
      const id = await runtime.createSession()
      await runtime.sendMessage(id, 'draw')
      await vi.waitFor(async () => expect((await runtime.view(id)).runs[0]?.progress).toEqual(fact))
      await vi.waitFor(async () => expect((await runtime.view(id)).delivery).not.toBeNull(), { timeout: 2000 })
      expect(after).toEqual([1, 3])
      expect((await db.getAll<{ eventCursor: number }>('run_bindings'))[0]?.eventCursor).toBe(5)
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    } finally { runtime.dispose() }
  })

  it('keeps terminal dominance while retrying a failed final snapshot download', async () => {
    const { runtime, fetchMock } = harness(true)
    let streams = 0
    let gets = 0
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ runId, phase: 'accepted' }))
      if (String(input).includes('/artifacts/')) return new Response(Buffer.from('PKfake'))
      if (String(input).includes('/events')) {
        streams++
        if (streams === 1) return new Response(sseFrame('plugin_core.ready', {
          schemaVersion: 1, type: 'plugin_core.ready', generation: 'first', run: view('running'), cursor: 1, terminal: false,
        }) + sseFrame('plugin_core.delivery', { type: 'plugin_core.delivery', schemaVersion: 1,
          eventId: 2, occurredAt: '2026-10-17T00:00:01.000Z', runId, finalResponse: 'done',
          delivery: view('completed').delivery, usage: null, durationMs: 100 }))
        return new Response(sseFrame('plugin_core.ready', {
          schemaVersion: 1, type: 'plugin_core.ready', generation: 'second', run: view('completed'), cursor: 2, terminal: true,
        }))
      }
      if (gets++ > 0) throw new TypeError('network interrupted after terminal event')
      return new Response(JSON.stringify(view('running')))
    })
    try {
      await runtime.setProviderKey('fake')
      const id = await runtime.createSession()
      await runtime.sendMessage(id, 'draw')
      await vi.waitFor(async () => expect((await runtime.view(id)).runs[0]?.terminal).toBe(true))
      await vi.waitFor(async () => expect((await runtime.view(id)).delivery).not.toBeNull(), { timeout: 2000 })
      expect(streams).toBe(2)
      expect((await runtime.view(id)).runs[0]?.phase).toBe('completed')
    } finally { runtime.dispose() }
  })

  it('names the first user turn locally without an extra network request and preserves a manual title', async () => {
    const { runtime, requests } = harness(true)
    try {
      await runtime.setProviderKey('fake')
      const first = await runtime.createSession(), second = await runtime.createSession()
      await runtime.sendMessage(first, '## Draw **a circle**\n with radius 3')
      expect((await runtime.view(first)).title).toBe('Draw a circle with radius 3')
      expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
      await runtime.renameSession(second, 'New session')
      await runtime.sendMessage(second, 'Draw a triangle')
      expect((await runtime.view(second)).title).toBe('New session')
      expect((await runtime.view(first)).title).toBe('Draw a circle with radius 3')
    } finally { runtime.dispose() }
  })
  it('names a generic image-only task without persisting the image in its title', async () => {
    const { runtime } = harness(true)
    try {
      await runtime.setProviderKey('fake')
      const id = await runtime.createSession()
      await runtime.sendMessage(id, 'Construct the geometry described in this image.', { mediaType: 'image/png',
        dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' })
      expect((await runtime.view(id)).title).toBe('Image construction')
    } finally { runtime.dispose() }
  })
  it('upgrades a generic image title from the completed report', async () => {
    const { runtime, fetchMock } = harness()
    const completed = { ...view('completed'), finalResponse: '我根据题目完成了构图：\n- 已绘制圆 c=Circle(O,3)，圆心 O=(0,0)。' }
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ runId, phase: 'accepted' }))
      if (String(input).includes('/artifacts/')) return new Response(Buffer.from('PKfake'))
      if (String(input).includes('/events')) return new Response(sseFrame('plugin_core.ready', {
        schemaVersion: 1, type: 'plugin_core.ready', generation: 'g', run: completed, cursor: 2, terminal: true,
      }))
      return new Response(JSON.stringify(completed))
    })
    try {
      await runtime.setProviderKey('fake')
      const id = await runtime.createSession()
      await runtime.sendMessage(id, '请根据图片中的题目完成几何构图。', { mediaType: 'image/png',
        dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' })
      await vi.waitFor(async () => expect((await runtime.view(id)).title).toBe('圆 c=Circle(O,3)，圆心 O=(0,0)'))
    } finally { runtime.dispose() }
  })
  it.each([{ manual: false, snapshot: false }, { manual: false, snapshot: true }, { manual: true, snapshot: true }])(
    'saves the image question before its summary, names the first topic and respects manual names (%j)', async ({ manual, snapshot }) => {
    const { runtime, fetchMock, db } = harness()
    const question = '抛物线 y²=4x 的焦点为 F，A 为准线上一点，作 FA 的中垂线。'
    const completed = { ...view('completed'), finalResponse: `### 原题（图片识别）\n\n> ${question}\n\n构图完成。` }
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ runId, phase: 'accepted' }))
      if (String(input).includes('/artifacts/')) return new Response(Buffer.from('PKfake'))
      if (String(input).includes('/events')) return new Response(snapshot ? sseFrame('plugin_core.ready', {
        schemaVersion: 1, type: 'plugin_core.ready', generation: 'g', run: completed, cursor: 2, terminal: true,
      }) : sseFrame('plugin_core.delivery', {
        schemaVersion: 1, type: 'plugin_core.delivery', eventId: 2, occurredAt: completed.createdAt,
        runId, finalResponse: completed.finalResponse, delivery: completed.delivery,
        usage: completed.usage, durationMs: completed.durationMs,
      }))
      return new Response(JSON.stringify(completed))
    })
    try {
      await runtime.setProviderKey('fake')
      const id = await runtime.createSession()
      if (manual) await runtime.renameSession(id, '我的课件')
      await runtime.sendMessage(id, '帮我完成这道题', { mediaType: 'image/png',
        dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' })
      await vi.waitFor(async () => expect((await runtime.view(id)).title).toBe(manual ? '我的课件' : question.slice(0, 32)))
      await vi.waitFor(async () => expect((await db.getAll<{ role: string; content: string }>('messages'))
        .filter(m => m.role === 'final_report')).toHaveLength(1))
      const reports = (await db.getAll<{ role: string; content: string }>('messages')).filter(m => m.role === 'final_report')
      expect(reports[0]?.content.startsWith(`### 原题（图片识别）\n\n> ${question}`)).toBe(true)
      fetchMock.mockRejectedValue(new Error('offline'))
      await runtime.openSession(await runtime.createSession())
      const restored = await runtime.openSession(id)
      expect(restored.messages.some(m => m.content.includes(question))).toBe(true)
      expect(restored.title).toBe(manual ? '我的课件' : question.slice(0, 32))
    } finally { runtime.dispose() }
  })
  it('persists the accepted construction record per run and restores it when switching sessions offline', async () => {
    const { runtime, fetchMock, db } = harness()
    const binding = { runId, turnId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222',
      toolCallId: '33333333-3333-4333-8333-333333333333', epoch: 1, buildId: '44444444-4444-4444-8444-444444444444',
      domainRequestDigest: 'a'.repeat(64), baseSha256: null, pluginName: 'fixture', pluginVersion: '1',
      packageIntegrity: 'b'.repeat(64), runtimeIdentity: {} }
    const construction = { schemaVersion: 1, origin: 'host-accepted-build', buildId: binding.buildId,
      domainRequestDigest: binding.domainRequestDigest, baseSha256: null, text: '1. [algebra] O\nO=(0,0)\n' }
    const completed = { ...view('completed'), delivery: { ...view('completed').delivery!, construction,
      verification: { interaction: { status: 'not_sampled', samples: 0 } },
      trustedBuild: { binding, receipt: {}, receiptSha256: 'c'.repeat(64) } } }
    let gets = 0
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ runId, phase: 'accepted' }))
      if (String(input).includes('/artifacts/')) return new Response(Buffer.from('PKfake'))
      if (String(input).includes('/events')) return new Response(sseFrame('plugin_core.ready', {
        schemaVersion: 1, type: 'plugin_core.ready', generation: 'g', run: completed, cursor: 2, terminal: true,
      }))
      return new Response(JSON.stringify(gets++ === 0 ? view('running') : completed))
    })
    try {
      await runtime.setProviderKey('fake')
      const first = await runtime.createSession(), second = await runtime.createSession()
      const localRunId = await runtime.sendMessage(first, 'Draw a point')
      await vi.waitFor(async () => expect((await runtime.view(first)).delivery?.construction).toEqual(construction))
      expect((await db.getAll<{ delivery?: { construction?: unknown } }>('run_bindings'))[0]?.delivery?.construction).toEqual(construction)
      expect((await runtime.view(first)).constructionReports[localRunId]).toEqual(construction)
      expect((await runtime.view(second)).constructionReports).toEqual({})
      fetchMock.mockRejectedValue(new Error('offline'))
      await runtime.openSession(second)
      const restored = await runtime.openSession(first)
      expect(restored.constructionReports[localRunId]).toEqual(construction)
      expect(restored.delivery?.verification).toEqual(completed.delivery.verification)
      expect(interactionSummary(restored.delivery?.verification, 'zh-CN')).toContain('未采样')
    } finally { runtime.dispose() }
  })

  it('shows the last failed check from SSE and preserves its structured evidence in the run view', async () => {
    const { runtime, fetchMock } = harness(true)
    const details = { kind: 'verification_failed' as const, lastBuildId: '11111111-1111-4111-8111-111111111111',
      error: { code: 'verification_failed', message: 'Required checks did not pass' },
      failedChecks: [{ requirementId: 'shape', checkId: 'shape:2', method: 'expression', status: 'unverified',
        reason: 'expression unverified: probe returned line (defined=false); expected boolean' }],
      reasons: ['shape/shape:2: expression unverified: probe returned line (defined=false); expected boolean'] }
    const failure = { code: 'plugin_core_no_delivery', message: 'The last build did not satisfy verification.', details }
    const notices: string[] = []
    let gets = 0
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ runId, phase: 'accepted' }), { status: 202 })
      if (String(input).includes('/events')) return new Response(sseFrame('plugin_core.ready', {
        schemaVersion: 1, type: 'plugin_core.ready', generation: 'g', run: view('running'), cursor: 1, terminal: false,
      }) + sseFrame('plugin_core.failed', { schemaVersion: 1, eventId: 2, runId,
        occurredAt: '2026-10-17T00:00:01.000Z', type: 'plugin_core.failed', ...failure, usage: null }))
      return new Response(JSON.stringify(gets++ === 0 ? view('running')
        : { ...view('completed'), phase: 'failed', failure, delivery: null }))
    })
    const dispose = runtime.onNotice(notice => notices.push(notice.detail))
    try {
      await runtime.setProviderKey('fake')
      const sessionId = await runtime.createSession()
      await runtime.sendMessage(sessionId, 'draw')
      await vi.waitFor(() => expect(notices.some(notice => notice.includes('probe returned line'))).toBe(true))
      expect(notices.at(-1)).toContain(details.lastBuildId)
      expect(notices.at(-1)).toContain('probe returned line (defined=false); expected boolean')
      expect(notices.at(-1)?.match(/plugin_core_no_delivery/g)).toHaveLength(1)
      expect((await runtime.view(sessionId)).runs[0]?.failure?.details).toEqual(details)
    } finally { dispose(); runtime.dispose() }
  })

  it('does not silently drop an image or fall back to text when creation fails', async () => {
    const { runtime, requests, fetchMock } = harness(true)
    try {
      await runtime.setProviderKey('fake')
      const sessionId = await runtime.createSession()
      const image = { mediaType: 'image/png' as const, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' }
      fetchMock.mockImplementationOnce(async () => { throw new Error('offline') })
      await expect(runtime.sendMessage(sessionId, 'from image', image)).rejects.toThrow()
      expect(requests).toHaveLength(0)
      expect(image.dataBase64).toContain('iVBOR')
      expect((await runtime.view(sessionId)).messages[0]?.deliveryState).toBe('failed')
      await runtime.sendMessage(sessionId, 'from image', image)
      expect(requests.filter(r => r.method === 'POST')[0]?.body).toMatchObject({ image })
    } finally { runtime.dispose() }
  })

  it('transmits an image only for its explicit turn and never persists its bytes', async () => {
    const { runtime, requests, db } = harness(true)
    try {
      await runtime.setProviderKey('fake-provider-key')
      const first = await runtime.createSession()
      const second = await runtime.createSession()
      const image = { mediaType: 'image/png' as const, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' }
      await runtime.sendMessage(first, 'from this image', image)
      await runtime.sendMessage(second, 'text only')
      const bodies = requests.filter(r => r.method === 'POST').map(r => r.body)
      expect(bodies[0]).toMatchObject({ image })
      expect(bodies[1]).not.toHaveProperty('image')
      expect(JSON.stringify(await db.getAll('messages'))).not.toContain(image.dataBase64)
      const count = requests.length
      await expect(runtime.sendMessage(second, 'invalid', { ...image, dataBase64: 'bad' })).rejects.toThrow()
      expect(requests).toHaveLength(count)
    } finally { runtime.dispose() }
  })

  it('persists the ready snapshot high-water mark without another create request', async () => {
    const { runtime, requests, db } = harness(true)
    await runtime.setProviderKey('provider-key')
    const sessionId = await runtime.createSession()
    await runtime.sendMessage(sessionId, 'draw a point')
    await vi.waitFor(async () => {
      const bindings = await db.getAll<{ eventCursor: number }>('run_bindings')
      expect(bindings[0]?.eventCursor).toBe(1)
    })
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect((await runtime.view(sessionId)).delivery).toBeNull()
    runtime.dispose()
  })

  it('keeps selected views through real runtime delivery, import and session switching', async () => {
    let perspective = 'file-layout'
    const api = {
      evalCommand: () => true,
      setPerspective: (value: string) => { perspective = value },
      showAlgebraInput: () => undefined,
      getAllObjectNames: () => ['A'], getObjectType: () => 'point',
      getXML: () => `<geogebra><gui><layout>${perspective}</layout></gui><construction><element type="point" label="A"/></construction></geogebra>`,
      getBase64: (callback: (value: string) => void) => callback(Buffer.from('PKsnapshot').toString('base64')),
      setBase64: (_value: string, callback: () => void) => { perspective = 'file-layout'; callback() },
      newConstruction: () => { perspective = 'reset-layout' },
    }
    vi.stubGlobal('GGBApplet', class {
      constructor(private readonly options: { appletOnLoad(api: unknown): void }) {}
      inject() { this.options.appletOnLoad(api) }
      setHTML5Codebase() {}
    })
    vi.stubGlobal('localStorage', { getItem: () => null })
    const port = createDirectAppletPort({ container: {
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
    } as HTMLElement })
    const { runtime } = harness(false, port)
    try {
      await runtime.setProviderKey('fake-provider-key')
      const first = await runtime.createSession()
      await runtime.openSession(first)
      expect(perspective).toBe('G')
      await runtime.setCanvasViews({ algebra: false, cas: true })
      await runtime.sendMessage(first, 'mock construction')
      await vi.waitFor(async () => expect((await runtime.view(first)).delivery).not.toBeNull())
      expect(perspective).toBe('GC')
      await runtime.importGgb(first, new TextEncoder().encode('PKimport'))
      expect(perspective).toBe('GC')
      const second = await runtime.createSession()
      await runtime.openSession(second)
      expect(perspective).toBe('GC')
      await runtime.openSession(first)
      expect(perspective).toBe('GC')
    } finally { runtime.dispose(); vi.unstubAllGlobals() }
  })

  it('routes browser view changes without starting a Provider run', async () => {
    const { runtime, requests, applet } = harness()
    await runtime.setCanvasViews({ algebra: false, cas: true })
    expect(applet.setViews).toHaveBeenCalledExactlyOnceWith({ algebra: false, cas: true })
    expect(requests).toEqual([])
    runtime.dispose()
  })

  it('creates a run, restores the delivered GGB and chains the next base', async () => {
    const { runtime, requests } = harness()
    await runtime.setProviderKey('provider-key')
    const sessionId = await runtime.createSession()
    await runtime.sendMessage(sessionId, 'draw a circle')
    await vi.waitFor(async () => {
      expect((await runtime.view(sessionId)).delivery).not.toBeNull()
    })
    const session = await runtime.view(sessionId)
    expect(session.messages.some(message => message.role === 'final_report')).toBe(true)
    expect(session.delivery?.sha256).toBe('c'.repeat(64))
    const download = await runtime.downloadDelivery(sessionId)
    expect(Buffer.from(download!.base64, 'base64').toString()).toBe('PKfake')
    expect(requests[0]).toMatchObject({
      method: 'POST', url: '/api/v3/plugin-core/runs',
      body: { runId: expect.stringMatching(/^run_/), prompt: 'draw a circle', base: null },
    })
    const status = await runtime.view(sessionId)
    expect(status.runs.at(-1)?.phase).toBe('completed')

    await runtime.sendMessage(sessionId, 'change the color')
    const creates = requests.filter(request => request.method === 'POST')
    expect(creates).toHaveLength(2)
    expect(creates[1]?.body).toMatchObject({
      prompt: 'change the color',
      base: {
        dataBase64: Buffer.from('reserialized').toString('base64'),
        name: expect.stringContaining('session-'),
      },
    })
    runtime.dispose()
  })
})
