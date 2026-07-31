import { hasTauri } from "$lib/backend/env";

// Open an external URL: the OS browser on desktop, a new tab on web.
//
// Raises rather than swallows, for the same reason the clipboard helpers do:
// the call site is the only place that knows which link the user clicked, and
// Terminal.svelte already had a catch that could never fire.
export async function openUrl(url: string): Promise<void> {
  if (hasTauri()) {
    const m = await import("@tauri-apps/plugin-opener");
    await m.openUrl(url);
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

// Reveal a file in the OS file manager. Desktop-only; no web equivalent, so a
// browser silently does nothing rather than raising.
export async function revealItemInDir(path: string): Promise<void> {
  if (!hasTauri()) return;
  const m = await import("@tauri-apps/plugin-opener");
  await m.revealItemInDir(path);
}
