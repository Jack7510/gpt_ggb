/** @fileoverview Compiled v2 Worker snapshot from ggb-agent 8c87666. */
export const SHELL_CACHE = 'ggb-shell-v1';
export const RUNTIME_CACHE = 'ggb-runtime-v2';
export const PUBLIC_CACHES = [SHELL_CACHE, RUNTIME_CACHE];
export function classifyRequest(url, destination) {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/api/'))
        return 'network-only';
    if (parsed.pathname.startsWith('/health/'))
        return 'network-only';
    if (parsed.pathname.startsWith('/bootstrap'))
        return 'network-only';
    if (parsed.pathname.startsWith('/geogebra/'))
        return 'runtime';
    if (destination === 'document')
        return 'revalidate';
    if (/\.(?:js|css|woff2?|png|svg|webp|ico)$/.test(parsed.pathname))
        return 'immutable';
    if (parsed.pathname.endsWith('.webmanifest') || parsed.pathname === '/release.json')
        return 'revalidate';
    return 'network-only';
}
export function cacheNameFor(strategy) {
    switch (strategy) {
        case 'immutable':
        case 'revalidate':
            return SHELL_CACHE;
        case 'runtime':
            return RUNTIME_CACHE;
        case 'network-only':
            return null;
    }
}
export function isCacheableRequest(method, url, origin) {
    if (method !== 'GET')
        return false;
    try {
        return new URL(url).origin === origin;
    }
    catch {
        return false;
    }
}
export function isServiceWorkerScope(scope = globalThis) {
    return (typeof scope === 'object' &&
        scope !== null &&
        typeof scope.skipWaiting === 'function' &&
        typeof scope.clients === 'object');
}
if (isServiceWorkerScope()) {
    installServiceWorker(globalThis);
}
function installServiceWorker(scope) {
    scope.addEventListener('install', (event) => {
        event.waitUntil(scope.skipWaiting());
    });
    scope.addEventListener('activate', (event) => {
        event.waitUntil((async () => {
            const names = await caches.keys();
            await Promise.all(names
                .filter((name) => !PUBLIC_CACHES.includes(name))
                .map((name) => caches.delete(name)));
            await scope.clients.claim();
        })());
    });
    scope.addEventListener('fetch', (event) => {
        const request = event.request;
        if (!isCacheableRequest(request.method, request.url, scope.location.origin))
            return;
        const strategy = classifyRequest(request.url, request.destination);
        const cacheName = cacheNameFor(strategy);
        if (cacheName === null)
            return;
        event.respondWith(strategy === 'revalidate' ? revalidate(request, cacheName) : cacheFirst(request, cacheName));
    });
}
async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached !== undefined)
        return cached;
    const response = await fetch(request, cacheName === RUNTIME_CACHE ? { cache: 'reload' } : undefined);
    if (response.ok)
        await cache.put(request, response.clone());
    return response;
}
async function revalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const response = await fetch(request);
        if (response.ok)
            await cache.put(request, response.clone());
        return response;
    }
    catch (error) {
        const cached = await cache.match(request);
        if (cached !== undefined)
            return cached;
        throw error;
    }
}
