/** @fileoverview Previous Cache First policy, used only by browser upgrade tests. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin
    || !url.pathname.startsWith('/geogebra/')) return
  event.respondWith((async () => {
    const cache = await caches.open('ggb-runtime-v1')
    const cached = await cache.match(event.request)
    if (cached) return cached
    const response = await fetch(event.request)
    if (response.ok) await cache.put(event.request, response.clone())
    return response
  })())
})
