/*
 * The PWA's service worker. Plain JavaScript, copied to `dist/sw.js` as it is:
 * Vite never touches `public/`, so nothing here is bundled or transpiled.
 *
 * What it buys a phone that opened the pairing link once: the app shell paints
 * on the next open before the core has answered, and Vite's hashed files are
 * read from disk instead of the wire. What it must never touch: the RPC socket,
 * which is the only thing that carries live state.
 *
 * Bump CACHE whenever the strategy below changes. `activate` deletes older
 * Boite caches when a new worker takes over, leaving other apps alone.
 */
const CACHE = 'boite-ui-v3';
const SHELL = '/';
const MANIFEST = '/manifest.webmanifest';
const WORKER = '/sw.js';
const RPC_PATH = '/rpc';
const ASSETS_PREFIX = '/assets/';
/** How long a navigation waits on the core before the cached shell is served instead. */
const SHELL_PATIENCE_MS = 2500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // The manifest is precached so a host that does not serve it fails the
      // install loudly; it is still read from the network on every load, below.
      const shell = await fetch(SHELL, { cache: 'reload' });
      if (!shell.ok) throw new Error('the app shell could not be cached');
      const html = await shell.clone().text();
      const assets = [...new Set(html.match(/\/assets\/[^\s"'<>]+/g) ?? [])];
      await cache.addAll([...assets, MANIFEST, '/icons/icon-192.png', '/fonts/Geist-Variable.woff2', '/fonts/GeistMono-Variable.woff2']);
      await cache.put(SHELL, shell);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith('boite-ui-') && name !== CACHE).map((name) => caches.delete(name)));
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
    event.respondWith(shellFromNetworkFirst(event));
    return;
  }

  if (url.pathname.startsWith(ASSETS_PREFIX) || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(assetFromCacheFirst(request));
  }
});

/**
 * A navigation goes to the core first, because the shell it serves is the one
 * that matches the core's version. The cached shell is what a phone gets when
 * the core is asleep or off the network, and also when the network is there
 * but slow: past SHELL_PATIENCE_MS the cached shell is served and the answer,
 * when it lands, is kept for the next open.
 */
async function shellFromNetworkFirst(event) {
  const cache = await caches.open(CACHE);
  const fromNetwork = (async () => {
    const response = await fetch(event.request);
    if (response.ok) await cache.put(SHELL, response.clone());
    if (response.status >= 500) throw new Error('core unavailable');
    return response;
  })();
  // The request carries the pairing query, the precached entry does not, so
  // the shell is matched by its own path rather than by this request.
  const cached = await cache.match(SHELL);
  if (!cached) return fromNetwork;
  // Keeps the worker alive until the late answer is stored.
  event.waitUntil(fromNetwork.catch(() => undefined));
  let timer;
  const patience = new Promise((resolve) => { timer = setTimeout(() => resolve(cached), SHELL_PATIENCE_MS); });
  try {
    return await Promise.race([fromNetwork, patience]);
  } catch {
    return cached;
  } finally {
    clearTimeout(timer);
  }
}
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data?.json() ?? {}; } catch { /* Show a generic notification for an empty push. */ }
    const threadId = typeof payload.threadId === 'string' ? payload.threadId : null;
    await self.registration.showNotification(typeof payload.title === 'string' ? payload.title : 'Boite', {
      body: typeof payload.body === 'string' ? payload.body : '',
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      tag: threadId ? `thread-${threadId}` : typeof payload.tag === 'string' ? payload.tag : 'boite-update',
      data: { threadId }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const threadId = event.notification.data?.threadId;
  const url = new URL('/', self.location.origin);
  if (typeof threadId === 'string') url.searchParams.set('thread', threadId);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === url.origin);
    if (existing) { existing.postMessage({ type: 'boite.open-thread', threadId: typeof threadId === 'string' ? threadId : null }); await existing.focus(); }
    else await self.clients.openWindow(url.href);
  })());
});

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
