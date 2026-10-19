// ChurchOS staff app service worker.
// - The app shell and icons are cached, so the installed app opens fast and shows a friendly page when there is no signal.
// - Nothing from the API is ever cached: staff screens hold members' details and money, so they are always read live and never stored on the phone.
// - Every non-GET request is passed straight through.
const VERSION = 'v1';
const SHELL_CACHE = `churchos-staff-shell-${VERSION}`;
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)));
  // No automatic skipWaiting: an updated worker waits until the person taps Refresh.
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

const OFFLINE = new Response(
  '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><body style="font-family:system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#faf8f3;color:#17212b;text-align:center;padding:24px"><div><h1 style="font-size:20px">You are offline</h1><p>ChurchOS Staff needs a connection to show members and money. Please check your signal and try again.</p><button onclick="location.reload()" style="font-size:16px;padding:10px 18px;border-radius:10px;border:0;background:#123456;color:#fff">Try again</button></div></body>',
  { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // the API and everything else: straight to the network, never stored

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/').then((r) => r || OFFLINE)));
    return;
  }
  // Built files, icons and the manifest: use the cache, refresh it in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((r) => {
          if (r.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || SHELL.includes(url.pathname))) { const copy = r.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)); }
          return r;
        })
        .catch(() => hit || OFFLINE);
      return hit || net;
    }),
  );
});
