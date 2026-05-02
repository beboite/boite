import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

let permissionPromise: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (!permissionPromise) {
    permissionPromise = (async () => {
      try {
        if (await isPermissionGranted()) return true;
        const status = await requestPermission();
        return status === "granted";
      } catch (err) {
        console.error("notification permission failed:", err);
        return false;
      }
    })();
  }
  return permissionPromise;
}

async function isWindowFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    return true;
  }
}

export async function notifyWhenUnfocused(
  title: string,
  body: string,
): Promise<void> {
  if (await isWindowFocused()) return;
  if (!(await ensurePermission())) return;
  try {
    sendNotification({ title, body });
  } catch (err) {
    console.error("sendNotification failed:", err);
  }
}
