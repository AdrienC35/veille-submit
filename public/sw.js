const CACHE = 'veille-v2';
const ASSETS = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Share target POST — let it go to network (don't cache)
  if (url.pathname === '/share' && e.request.method === 'POST') {
    return;
  }

  // API calls — network only
  if (url.pathname.startsWith('/submit') || url.pathname.startsWith('/recent') || url.pathname.startsWith('/health')) {
    return;
  }

  // Static assets — cache first
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
