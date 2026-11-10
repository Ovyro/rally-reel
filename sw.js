// Keeps the app itself (a few small files) available offline. Videos are never cached here.
const CACHE = 'rally-reel-v6';
const SHELL = ['./', 'styles.css?v=6', 'config.js?v=6', 'app.js?v=6', 'drive.js?v=6', 'recorder.js?v=6', 'analyzer.js?v=6',
  'highlights.js?v=6', 'renderer.js?v=6', 'demo.js?v=6', 'importer.js?v=6', 'rooms.js?v=6', 'privacy.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // the page itself is always re-checked so it never pairs with old code
  const req = e.request.mode === 'navigate' ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(e.request);
  e.respondWith(req.then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
