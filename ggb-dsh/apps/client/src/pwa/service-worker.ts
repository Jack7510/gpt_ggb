/**
 * Service Worker for the client PWA (§11). Cache policy only: it never reads
 * IndexedDB Session data, never stores keys/runTokens, and never proxies DSH
 * or retries run mutations.
 */
export const SHELL_CACHE = 'ggb-shell-v1'
// New bytes at pinned engine URLs: retire the pre-path-origin-fix cache.
export const RUNTIME_CACHE = 'ggb-runtime-v2'
export const PUBLIC_CACHES = [SHELL_CACHE, RUNTIME_CACHE] as const

export type CacheStrategy = 'immutable' | 'revalidate' | 'runtime' | 'network-only'

/**
 * Classifies a request. Anything run-related is `network-only` so API payloads,
 * SSE frames, artifacts and receipts never enter Cache Storage.
 */
export function classifyRequest(url: string, destination: string): CacheStrategy {
  const parsed = new URL(url)
  if (parsed.pathname.startsWith('/api/')) return 'network-only'
  if (parsed.pathname.startsWith('/health/')) return 'network-only'
  if (parsed.pathname.startsWith('/bootstrap')) return 'network-only'
  if (parsed.pathname.startsWith('/geogebra/')) return 'runtime'
  if (destination === 'document') return 'revalidate'
  if (/\.(?:js|css|woff2?|png|svg|webp|ico)$/.test(parsed.pathname)) return 'immutable'
  if (parsed.pathname.endsWith('.webmanifest') || parsed.pathname === '/release.json') return 'revalidate'
  return 'network-only'
}

export function cacheNameFor(strategy: CacheStrategy): string | null {
  switch (strategy) {
    case 'immutable':
    case 'revalidate':
      return SHELL_CACHE
    case 'runtime':
      return RUNTIME_CACHE
    case 'network-only':
      return null
  }
}

/**
 * Only same-origin GETs are cacheable; anything with credentials-bearing
 * headers or a non-GET method is passed straight through.
 */
export function isCacheableRequest(method: string, url: string, origin: string): boolean {
  if (method !== 'GET') return false
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void
}

interface FetchEventLike extends ExtendableEventLike {
  request: Request
  respondWith(response: Promise<Response>): void
}

interface ServiceWorkerScopeLike {
  location: { origin: string }
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void
}

export function isServiceWorkerScope(scope: unknown = globalThis): boolean {
  return (
    typeof scope === 'object' &&
    scope !== null &&
    typeof (scope as { skipWaiting?: unknown }).skipWaiting === 'function' &&
    typeof (scope as { clients?: unknown }).clients === 'object'
  )
}

if (isServiceWorkerScope()) {
  installServiceWorker(globalThis as unknown as ServiceWorkerScopeLike)
}

function installServiceWorker(scope: ServiceWorkerScopeLike): void {
  scope.addEventListener('install', (event) => {
    event.waitUntil(scope.skipWaiting())
  })

  scope.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        const names = await caches.keys()
        await Promise.all(
          names
            .filter((name) => !PUBLIC_CACHES.includes(name as (typeof PUBLIC_CACHES)[number]))
            .map((name) => caches.delete(name)),
        )
        await scope.clients.claim()
      })(),
    )
  })

  scope.addEventListener('fetch', (event) => {
    const request = event.request
    if (!isCacheableRequest(request.method, request.url, scope.location.origin)) return
    const strategy = classifyRequest(request.url, request.destination)
    const cacheName = cacheNameFor(strategy)
    if (cacheName === null) return
    event.respondWith(
      strategy === 'revalidate' ? revalidate(request, cacheName) : cacheFirst(request, cacheName),
    )
  })
}

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached !== undefined) return cached
  // A new Cache Storage generation must not inherit old HTTP-cached engine
  // fragments, whose URLs and upstream permutation names remain unchanged.
  const response = await fetch(request,
    cacheName === RUNTIME_CACHE ? { cache: 'reload' } : undefined)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

async function revalidate(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(request)
    if (cached !== undefined) return cached
    throw error
  }
}
