/*
 * The PWA's service worker. Plain JavaScript, copied to `dist/sw.js` as it is:
 * Vite never touches `public/`, so nothing here is bundled or transpiled.
 *
 * What it buys a phone that opened the pairing link once: the app shell paints
 * on the next open before the core has answered, and Vite's hashed files are
 * read from disk instead of the wire. What it must never touch: the RPC socket,
 * which is the only thing that carries live state.
 *
 * Bump CACHE whenever the strategy below changes. `activate` deletes every
 * other cache, so an old name is gone the moment a new worker takes over.
 */
const CACHE = 'boite-ui-v1';
const SHELL = '/';
const MANIFEST = '/manifest.webmanifest';
const WORKER = '/sw.js';
const RPC_PATH = '/rpc';
const ASSETS_PREFIX = '/assets/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // The manifest is precached so a host that does not serve it fails the
      // install loudly; it is still read from the network on every load, below.
      await cache.addAll([SHELL, MANIFEST]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The RPC is a WebSocket upgrade: answering it from a cache would hand the UI
  // a dead socket. The header check covers any other upgrade the core grows.
  if (url.pathname === RPC_PATH) return;
  if (request.headers.get('upgrade') === 'websocket') return;

  // These two decide what the next load caches, so a stale copy would pin the
  // worker and the manifest forever.
  if (url.pathname === WORKER || url.pathname === MANIFEST) return;

  if (request.mode === 'navigate') {
    event.respondWith(shellFromNetworkFirst(request));
    return;
  }

  if (url.pathname.startsWith(ASSETS_PREFIX)) {
    event.respondWith(assetFromCacheFirst(request));
  }
});

/**
 * A navigation goes to the core first, because the shell it serves is the one
 * that matches the core's version. The cached shell is what a phone gets when
 * the core is asleep or off the network.
 */
async function shellFromNetworkFirst(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(CACHE);
    // The request carries the pairing query, the precached entry does not, so
    // the shell is matched by its own path rather than by this request.
    const cached = await cache.match(SHELL);
    if (cached) return cached;
    throw error;
  }
}

/**
 * A file under `/assets/` carries its content hash in its name, so the copy in
 * the cache is the file. A new build asks for new names and stores those.
 */
async function assetFromCacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  // Only a whole 200 is worth keeping: a 206 or an opaque answer would be
  // replayed later as if it were the entire file.
  if (response.status === 200 && response.type === 'basic') {
    await cache.put(request, response.clone());
  }
  return response;
}
