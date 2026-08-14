import { hasTauri } from "$lib/backend/env";
// Same question the unread marks ask, and it only ever had one right answer, so
// it lives in one place now rather than being written out again per caller.
import { windowIsFocused } from "$lib/app/focus.svelte";
import { logger } from "$lib/shared/services/logger.svelte";

// Local OS notification when a thread needs attention and the app is not
// focused. Desktop uses the Tauri notification plugin; web / installed PWA
// uses the Web Notifications API. (App-closed delivery on mobile is handled
// server-side via the webhook -> ntfy path, not here.)
let permissionPromise: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (hasTauri()) {
    // One OS dialog per install, so the answer is worth caching.
    if (!permissionPromise) {
      permissionPromise = (async () => {
        try {
          const m = await import("@tauri-apps/plugin-notification");
          if (await m.isPermissionGranted()) return true;
          return (await m.requestPermission()) === "granted";
        } catch (err) {
          logger.warn("notify", "permission request failed", err);
          return false;
        }
      })();
    }
    return permissionPromise;
  }
  // Never prompts, and never caches. A prompt fired from a background event is
  // the pattern Chrome's quieter UI auto-blocks, and a block is permanent, so the
  // ask lives on an explicit control in Settings > General. Read live because
  // that control can grant it at any point in the session.
  if (typeof Notification === "undefined") return false;
  return Notification.permission === "granted";
}

// Android Chrome throws `TypeError: Illegal constructor` for `new Notification`:
// there, only a service worker registration may put one on screen. The old code
// had that throw land in a catch that logged and moved on, so a PWA simply never
// showed a foreground notification and nothing said why.
async function showWebNotification(title: string, body: string): Promise<void> {
  try {
    new Notification(title, { body });
    return;
  } catch {
    // Fall through to the registration.
  }
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification(title, { body });
}

export async function notifyWhenUnfocused(
  title: string,
  body: string,
): Promise<void> {
  if (await windowIsFocused()) return;
  if (!(await ensurePermission())) return;
  try {
    if (hasTauri()) {
      const m = await import("@tauri-apps/plugin-notification");
      m.sendNotification({ title, body });
    } else if (typeof Notification !== "undefined") {
      await showWebNotification(title, body);
    }
  } catch (err) {
    logger.warn("notify", "could not show notification", err);
  }
}
