// Minimal app-shell cache. API calls are network-first and never cached for auth or non-GET requests.
const CACHE = 'churchos-member-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/auth') || url.pathname.startsWith('/me')) return; // never cache sign-in or personal data
  if (url.origin !== location.origin) {
    // API on another origin: network first, fall back to cache for public reads only.
    if (!url.pathname.startsWith('/public')) return;
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; }).catch(() => caches.match(req)));
    return;
  }
  e.respondWith(
    fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; })
      .catch(() => caches.match(req).then((m) => m || caches.match('/'))),
  );
});
