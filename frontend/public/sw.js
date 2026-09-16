// Never persist authenticated API responses. An offline response must not
// cross account boundaries or outlive a revoked calendar permission.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('termina-')).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
