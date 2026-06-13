// Minimal PWA service worker: makes the app installable and lets the static
// shell load offline. It NEVER touches the WebSocket (/ws) or the API: those
// are the live link to boite-server and must always hit the network.
const CACHE = "boite-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop old shell caches on version bump.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/ws") || url.pathname.startsWith("/api")) return;

  // Network-first with a cache fallback so updates land immediately online and
  // the shell still opens offline.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200 && fresh.type === "basic") {
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await cache.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") {
          const index = await cache.match("/");
          if (index) return index;
        }
        throw new Error("offline and uncached");
      }
    })(),
  );
});
