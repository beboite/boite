import { backend } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
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

/** Whether this browser can be subscribed to Web Push at all. */
export function pushSupported(): boolean {
  if (hasTauri() || typeof window === "undefined") return false;
  return (
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
  );
}

/** What the browser currently says about notification permission. */
export function pushPermission(): NotificationPermission | "unsupported" {
  if (!pushSupported()) return "unsupported";
  return Notification.permission;
}

// Subscribe this browser to Web Push and register the endpoint server-side.
// Web/PWA only: the desktop notifies through the OS. Idempotent (the server
// keys subscriptions by endpoint), so it is safe to call on every connect.
//
// Never prompts. It used to call requestPermission() here, which meant a prompt
// on every connect with no user gesture behind it and no sentence explaining what
// it was for: Chrome's quieter permission UI auto-blocks that pattern, the block
// is permanent, and there was no in-app way to ask again. The ask now lives on the
// control in Settings > General, and this only picks up a permission that already
// exists.
export async function registerPush(): Promise<void> {
  if (!pushSupported()) return;
  const push = backend().push;
  if (!push) return;

  try {
    if (Notification.permission !== "granted") return;

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
    logger.warn("push", "registration failed", e);
  }
}

/**
 * Ask the browser for notification permission, then subscribe. Call this from a
 * click and nowhere else: the gesture is what keeps Chrome from swallowing the
 * prompt, and a swallowed prompt cannot be reopened from inside the app.
 *
 * Returns what the browser decided, so the caller can say so.
 */
export async function enablePush(): Promise<NotificationPermission | "unsupported"> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission !== "default") {
    // Already answered. Granted still runs the registration: the subscription
    // may be missing on this device even when the permission is not.
    if (Notification.permission === "granted") await registerPush();
    return Notification.permission;
  }
  let result: NotificationPermission;
  try {
    result = await Notification.requestPermission();
  } catch (e) {
    logger.warn("push", "permission request failed", e);
    return Notification.permission;
  }
  if (result === "granted") await registerPush();
  return result;
}
