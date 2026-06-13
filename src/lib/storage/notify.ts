import { hasTauri } from "$lib/backend/env";

// Local OS notification when a thread needs attention and the app is not
// focused. Desktop uses the Tauri notification plugin; web / installed PWA
// uses the Web Notifications API. (App-closed delivery on mobile is handled
// server-side via the webhook -> ntfy path, not here.)
let permissionPromise: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (!permissionPromise) {
    permissionPromise = (async () => {
      try {
        if (hasTauri()) {
          const m = await import("@tauri-apps/plugin-notification");
          if (await m.isPermissionGranted()) return true;
          return (await m.requestPermission()) === "granted";
        }
        if (typeof Notification === "undefined") return false;
        if (Notification.permission === "granted") return true;
        if (Notification.permission === "denied") return false;
        return (await Notification.requestPermission()) === "granted";
      } catch (err) {
        console.error("notification permission failed:", err);
        return false;
      }
    })();
  }
  return permissionPromise;
}

async function isFocused(): Promise<boolean> {
  if (hasTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      return await getCurrentWindow().isFocused();
    } catch {
      return true;
    }
  }
  if (typeof document !== "undefined") {
    return document.visibilityState === "visible" && document.hasFocus();
  }
  return true;
}

export async function notifyWhenUnfocused(
  title: string,
  body: string,
): Promise<void> {
  if (await isFocused()) return;
  if (!(await ensurePermission())) return;
  try {
    if (hasTauri()) {
      const m = await import("@tauri-apps/plugin-notification");
      m.sendNotification({ title, body });
    } else if (typeof Notification !== "undefined") {
      new Notification(title, { body });
    }
  } catch (err) {
    console.error("notification failed:", err);
  }
}
