import { afterEach, describe, expect, it, vi } from 'vitest'

interface WorkerEvent {
  request: Request
  waitUntil(promise: Promise<unknown>): void
  respondWith(promise: Promise<Response>): void
}

async function worker() {
  const handlers = new Map<string, (event: WorkerEvent) => void>()
  const cached = new Response('fixed')
  const match = vi.fn<() => Promise<Response | undefined>>().mockResolvedValue(undefined)
  const put = vi.fn().mockResolvedValue(undefined)
  const remove = vi.fn().mockResolvedValue(true)
  const claim = vi.fn().mockResolvedValue(undefined)
  const fetch = vi.fn().mockResolvedValue(new Response('fixed'))
  vi.stubGlobal('skipWaiting', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('clients', { claim })
  vi.stubGlobal('location', { origin: 'http://localhost' })
  vi.stubGlobal('addEventListener', (type: string, handler: (event: WorkerEvent) => void) => handlers.set(type, handler))
  vi.stubGlobal('caches', {
    keys: async () => ['ggb-shell-v1', 'ggb-runtime-v1', 'ggb-runtime-v2'],
    delete: remove,
    open: async () => ({ match, put }),
  })
  vi.stubGlobal('fetch', fetch)
  const module = await import('../src/pwa/service-worker.js')
  const event = {
    request: new Request('http://localhost/geogebra/HTML5/5.0/web3d/engine.js'),
    waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
    respondWith: vi.fn<(promise: Promise<Response>) => void>(),
  }
  return { handlers, match, put, remove, claim, fetch, cached, module, event }
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

describe('PWA runtime compatibility cache migration', () => {
  it('retires old engine caches when the repaired worker activates', async () => {
    const f = await worker()
    f.handlers.get('activate')?.(f.event)
    await f.event.waitUntil.mock.calls[0]?.[0]
    expect(f.remove.mock.calls).toEqual([['ggb-runtime-v1']])
    expect(f.claim).toHaveBeenCalledOnce()
    expect(f.module.RUNTIME_CACHE).toBe('ggb-runtime-v2')
  })

  it('bypasses the old HTTP cache on first download, then reuses fixed bytes', async () => {
    const f = await worker()
    f.handlers.get('fetch')?.(f.event)
    await f.event.respondWith.mock.calls[0]?.[0]
    expect(f.fetch).toHaveBeenCalledWith(f.event.request, { cache: 'reload' })
    expect(f.put).toHaveBeenCalledOnce()
    f.match.mockResolvedValue(f.cached)
    f.handlers.get('fetch')?.(f.event)
    await f.event.respondWith.mock.calls[1]?.[0]
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('keeps API and run traffic outside Cache Storage', async () => {
    const f = await worker()
    f.event.request = new Request('http://localhost/api/v3/runs/run-test/events')
    f.handlers.get('fetch')?.(f.event)
    expect(f.event.respondWith).not.toHaveBeenCalled()
    expect(f.match).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
