// ChurchOS member app service worker (L121).
// - The app shell and icons are cached, so the installed app opens instantly and shows its screens offline.
// - Sign-in, personal data and every non-GET request are never cached.
// - Public reads (church pages) go network first and fall back to the last copy.
const VERSION = 'v27';
const SHELL_CACHE = `churchos-member-shell-${VERSION}`;
const PUBLIC_CACHE = `churchos-member-public-${VERSION}`;
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)));
  // No automatic skipWaiting: an updated worker waits until the member taps Refresh ('skip-waiting' message below).
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL_CACHE, PUBLIC_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

const PRIVATE = ['/auth', '/me', '/wallets', '/messages', '/groups', '/members', '/records', '/staff', '/admin', '/audit', '/kyc'];

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The API lives on another origin in development. Only public reads are ever kept.
  if (url.origin !== location.origin) {
    if (PRIVATE.some((p) => url.pathname.startsWith(p)) || !url.pathname.startsWith('/public')) return;
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r.ok) { const copy = r.clone(); caches.open(PUBLIC_CACHE).then((c) => c.put(req, copy)); }
          return r;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Pages: network first so updates arrive, the cached shell when there is no network.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }

  // Built files, icons and the manifest: use the cache, refresh it in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((r) => {
          if (r.ok) { const copy = r.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)); }
          return r;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
