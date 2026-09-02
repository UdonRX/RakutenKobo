const CACHE = 'kobo-finder-v0.3.2';
const SHELL = ['/', '/public/manifest.json', '/styles.css', '/app.js', '/ui.js', '/catalog.js', '/public/amazon-ranking-client.js', '/public/sale-snapshot-client.js'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((hit) => hit || caches.match('/'))));
});
