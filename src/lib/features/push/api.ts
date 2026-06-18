import { backend } from "$lib/backend";
import { hasTauri } from "$lib/backend/env";

// applicationServerKey must be the raw bytes of the VAPID public key; the
// server hands it to us base64url-encoded.
function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Subscribe this browser to Web Push and register the endpoint server-side.
// Web/PWA only: the desktop notifies through the OS. Idempotent (the server
// keys subscriptions by endpoint), so it is safe to call on every connect.
export async function registerPush(): Promise<void> {
  if (hasTauri() || typeof window === "undefined") return;
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return;
  }
  const push = backend().push;
  if (!push) return;

  try {
    if (Notification.permission === "denied") return;
    if (Notification.permission === "default") {
      const granted = await Notification.requestPermission();
      if (granted !== "granted") return;
    }

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = await push.publicKey();
      if (!key) return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
    }

    const json = sub.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!json.endpoint || !p256dh || !auth) return;
    await push.subscribe({ endpoint: json.endpoint, keys: { p256dh, auth } });
  } catch (e) {
    console.warn("push registration failed:", e);
  }
}
