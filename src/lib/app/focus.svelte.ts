/**
 * Whether the user is actually looking at this window.
 *
 * `document.hidden` is the tempting answer and it is the wrong one for a
 * desktop window: it goes true on minimize and on nothing else, so boite
 * sitting unfocused behind a browser reads as watched, and anything asking "did
 * they see this happen" gets a yes about a window nobody has looked at in an
 * hour. Focus is the question. Under Tauri the webview is not reliably the one
 * who knows the answer either, so the window itself is asked.
 *
 * Two ways in, because the callers disagree about when they ask. A notification
 * fires once and can afford to await the truth; a probe answering "was this
 * thread on screen" is called from inside a status transition and cannot. The
 * live read is the source, the tracked one is it cached against an event.
 */

import { hasTauri } from "$lib/backend/env";

/** What the window would say if asked right now. */
export async function windowIsFocused(): Promise<boolean> {
  if (hasTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      return await getCurrentWindow().isFocused();
    } catch {
      // Nothing to ask means nothing to hide behind: treat it as focused, which
      // is the quiet answer for the notification path that has always used it.
      return true;
    }
  }
  return webFocus();
}

/**
 * The web answer, which is synchronous and is also the seed for the tracked one.
 *
 * Visibility and focus are both needed and neither is enough: a background tab
 * is not focused but a minimized window is not hidden.
 */
function webFocus(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

// Seeded from the web answer rather than from a flat `true`. It is right on
// both platforms at boot, and under Tauri the authoritative one replaces it
// within a tick of `watch()` running.
let focused = $state(webFocus());

/** The tracked answer, for the synchronous callers. Reactive. */
export function windowFocused(): boolean {
  return focused;
}

/**
 * Keeps the tracked answer current, for the lifetime of the window.
 *
 * Under Tauri only the window's own event drives it. Listening to the webview's
 * `focus`/`blur` as well would let the two disagree, and the disagreements are
 * real: a native menu takes focus off the document while the window still has
 * it, and the last event to land would win rather than the one that is right.
 */
export function watchWindowFocus(): () => void {
  if (typeof window === "undefined") return () => {};
  if (hasTauri()) {
    let unlisten: (() => void) | null = null;
    let stopped = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        focused = await w.isFocused();
        const off = await w.onFocusChanged(({ payload }) => {
          focused = payload;
        });
        if (stopped) off();
        else unlisten = off;
      } catch {
        // Same as above: an unaskable window is not a window hiding something.
        focused = true;
      }
    })();
    return () => {
      stopped = true;
      unlisten?.();
      unlisten = null;
    };
  }
  const sync = () => {
    focused = webFocus();
  };
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    window.removeEventListener("focus", sync);
    window.removeEventListener("blur", sync);
    document.removeEventListener("visibilitychange", sync);
  };
}
