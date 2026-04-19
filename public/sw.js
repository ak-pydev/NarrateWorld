// public/sw.js — minimal offline shell.
// Caches the static PWA shell so the app loads without network.
// API calls are NEVER cached (they need fresh keys + real-time inference).

const VERSION = 'v3';
const SHELL_CACHE = `nmw-shell-${VERSION}`;
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles/app.css',
  '/src/app.js',
  '/src/camera.js',
  '/src/gemini.js',
  '/src/elevenlabs.js',
  '/src/classifier.js',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API — always hit the network.
  if (url.pathname.startsWith('/api/')) return;

  // Same-origin GET only: cache-first, fall back to network.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request)
          .then((resp) => {
            const copy = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(event.request, copy)).catch(() => undefined);
            return resp;
          })
          .catch(() => caches.match('/index.html'))
    )
  );
});
