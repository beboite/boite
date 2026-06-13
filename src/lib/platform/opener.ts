import { hasTauri } from "$lib/backend/env";

// Open an external URL: the OS browser on desktop, a new tab on web.
export async function openUrl(url: string): Promise<void> {
  try {
    if (hasTauri()) {
      const m = await import("@tauri-apps/plugin-opener");
      await m.openUrl(url);
    } else if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  } catch (err) {
    console.error("openUrl failed:", err);
  }
}

// Reveal a file in the OS file manager. Desktop-only; no web equivalent.
export async function revealItemInDir(path: string): Promise<void> {
  if (!hasTauri()) return;
  try {
    const m = await import("@tauri-apps/plugin-opener");
    await m.revealItemInDir(path);
  } catch (err) {
    console.error("revealItemInDir failed:", err);
  }
}
