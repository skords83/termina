const CACHE = 'termina-v1';
const API_ROUTES = ['/api/calendars', '/api/events'];

let apiToken = null;

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SET_TOKEN') {
    apiToken = event.data.token;
  }
});

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isApiRoute = API_ROUTES.some((r) => url.pathname.startsWith(r));

  if (!isApiRoute) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
