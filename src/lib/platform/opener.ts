import { hasTauri } from "$lib/backend/env";
import { workspace } from "$lib/backend";

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

/**
 * Whether this path names a file the OS file manager here can be pointed at.
 *
 * The plugin always opens the local Explorer or Finder, and a path off a boite
 * means nothing to it: it errors, or worse it finds a same-named directory on
 * this disk and opens the wrong one. Pure remote mode answers no for every
 * path, since the rows carry no origin there and everything on screen is the
 * server's; dynamic mode asks which project the path falls under.
 *
 * Call sites use this to leave the affordance out rather than draw a button
 * that does nothing, which is what the web path had been doing all along.
 */
export function canRevealItem(path: string): boolean {
  if (!hasTauri()) return false;
  if (workspace.mode === "remote") return false;
  if (workspace.mode === "dynamic") {
    return (workspace.pathOriginResolver?.(path) ?? "local") === "local";
  }
  return true;
}

// Reveal a file in the OS file manager. Desktop-only and this-machine-only; a
// browser or a path on a boite silently does nothing rather than raising.
export async function revealItemInDir(path: string): Promise<void> {
  if (!canRevealItem(path)) return;
  const m = await import("@tauri-apps/plugin-opener");
  await m.revealItemInDir(path);
}
