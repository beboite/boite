import { hasTauri } from "$lib/backend/env";

// Clipboard that works in the desktop shell (Tauri plugin) and in a plain
// browser / installed PWA (Async Clipboard API). Dynamic imports keep the
// Tauri plugin out of the web bundle.
export async function writeText(text: string): Promise<void> {
  try {
    if (hasTauri()) {
      const m = await import("@tauri-apps/plugin-clipboard-manager");
      await m.writeText(text);
    } else if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    }
  } catch (err) {
    console.error("clipboard write failed:", err);
  }
}

export async function readText(): Promise<string> {
  try {
    if (hasTauri()) {
      const m = await import("@tauri-apps/plugin-clipboard-manager");
      return await m.readText();
    }
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (err) {
    console.error("clipboard read failed:", err);
  }
  return "";
}
