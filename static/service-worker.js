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

// Web Push: the server sends one awareness value per meaningful transition —
// {title, body, tag, url, phase, threadId} — built by boite_core::awareness, so
// what lands here is the same sentence every other consumer gets. Show it as a
// system notification even with the app closed (the push service woke this
// worker).
//
// `url` is a path, not an absolute URL, and is resolved against this worker's
// own scope below. The server cannot build the absolute one: it is behind a
// proxy and does not know the address this browser reached it at.
self.addEventListener("push", (event) => {
  let payload = { title: "Boite", body: "", tag: "boite", url: "/", phase: "" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }
  // The payload is only as trusted as whoever can post to the subscription:
  // an absolute cross-origin `url` must not survive into the tap target.
  const resolved = new URL(payload.url || "/", self.location.origin);
  const url =
    resolved.origin === self.location.origin
      ? resolved.href
      : new URL("/", self.location.origin).href;
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // A phase that holds a turn open is not something to be scrolled past on
      // a lock screen: it stays until it is touched, and it vibrates.
      requireInteraction:
        payload.phase === "waiting_for_input" ||
        payload.phase === "waiting_for_approval",
      data: { url },
    }),
  );
});

// Focus an existing window if one is open, otherwise open the app.
//
// Focusing alone was not enough once the notification started carrying a
// thread: a window already open would come to the front still showing whatever
// the user last had on it, and the tap that was meant to answer a dialog landed
// nowhere. `navigate` is what makes the deep link a link.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if (!("focus" in client)) continue;
        const focused = await client.focus();
        // Same origin by construction (the URL was resolved against this
        // scope), and a client that refuses to navigate is still focused.
        if ("navigate" in client) {
          try {
            return await client.navigate(target);
          } catch {
            return focused;
          }
        }
        return focused;
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
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
