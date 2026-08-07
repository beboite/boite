import { hasTauri } from "$lib/backend/env";

// Clipboard that works in the desktop shell (Tauri plugin) and in a plain
// browser / installed PWA (Async Clipboard API). Dynamic imports keep the
// Tauri plugin out of the web bundle.
//
// Failures are raised, never swallowed. Only the caller knows what the user was
// trying to do, so it owns the message and the log line: a rejection caught and
// dropped here is what turned a clipboard the OS refused into a Ctrl+V that
// appeared to work and a "Path copied" toast for a path nobody could paste.
export async function writeText(text: string): Promise<void> {
  if (hasTauri()) {
    const m = await import("@tauri-apps/plugin-clipboard-manager");
    await m.writeText(text);
    return;
  }
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // The Async Clipboard API is absent outside a secure context, which is the
  // normal case for a boite reached over plain http on a LAN. Resolving here
  // was the swallow this file says it does not do: the caller went on to raise
  // its "copied" toast for a string that never left the page.
  throw new Error("no clipboard on this platform");
}

// "" only where there is no clipboard to read at all, which is not a failure:
// a platform without one has nothing to report.
export async function readText(): Promise<string> {
  if (hasTauri()) {
    const m = await import("@tauri-apps/plugin-clipboard-manager");
    return await m.readText();
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    return await navigator.clipboard.readText();
  }
  return "";
}
