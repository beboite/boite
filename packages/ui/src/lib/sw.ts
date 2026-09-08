/**
 * Registering `public/sw.js`, and deciding where that is worth doing.
 *
 * Only the core serves this build over http(s) to a phone, and only there does
 * a cache help. The Tauri shell loads the very same build from `tauri://` (or
 * `http://tauri.localhost`, which is still an http origin), where the files are
 * already on disk and a worker would only add a stale copy of them. `?fake=1`
 * runs the UI on the in-memory client with no core behind it, and is left
 * uncached so a reload always takes the build that was just rebuilt.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (window.__TAURI_INTERNALS__ !== undefined) return;

  const protocol = window.location.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return;
  if (new URLSearchParams(window.location.search).get('fake') === '1') return;

  const start = (): void => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      // One line and no more: a browser that refuses the worker still runs the app.
      console.warn('the service worker did not register', error);
    });
  };

  // After the first paint, never before it: the registration must not delay
  // what the user sees, and it has nothing to do with the socket opening.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
