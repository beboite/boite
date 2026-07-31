/**
 * What every floating surface in the app needs and none of them owns: who gets
 * Escape, where focus goes back to, and how tall the viewport really is.
 *
 * These lived in ContextMenu.svelte's module block for a while, which made a
 * component the home of app-wide keyboard policy and had GitPanel importing a
 * context menu it never renders just to reach them.
 */

/**
 * One Escape stack for every floating surface.
 *
 * The global dispatcher (shared/keyboard/controller.ts) claims Escape in the
 * capture phase on `window` and stops propagation, so a menu listening on
 * `document` never saw the key: the view behind it changed and the menu stayed
 * up. Listeners on the same target in the same phase run in registration order
 * and `stopPropagation` does not silence them, so running first is the only way
 * to win, and module evaluation happens before the layout's onMount.
 *
 * LIFO, so a context menu opened over an open dropdown closes first.
 */
const escapeStack: Array<() => void> = [];

function handleEscapeFirst(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const close = escapeStack[escapeStack.length - 1];
  if (!close) return;
  // A modal dialog is a layer above every menu and brings its own Escape
  // (ConfirmDialog, the folder browser, the mobile sheet). Same probe the layout
  // scopes on, so both agree on who is in front.
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  e.preventDefault();
  // Immediate: the dispatcher listens on this same target in this same phase,
  // where a plain stopPropagation would leave it running and one press would
  // still close two things.
  e.stopImmediatePropagation();
  close();
}

// Module lifetime by design: it has to outlive every surface that uses it, and
// it costs one early return per keystroke while nothing is open.
if (typeof window !== "undefined") {
  window.addEventListener("keydown", handleEscapeFirst, { capture: true });
}

/** Claim Escape while a surface is open. Call the result to release it. */
export function registerEscape(close: () => void): () => void {
  escapeStack.push(close);
  return () => {
    const i = escapeStack.lastIndexOf(close);
    if (i >= 0) escapeStack.splice(i, 1);
  };
}

/**
 * Restore focus to whoever had it before a surface stole it, unless something
 * else has taken it since: closing by clicking elsewhere already moved focus,
 * and taking it back would undo the click that closed the surface.
 */
export function restoreFocus(
  previous: HTMLElement | null,
  surface: HTMLElement | null,
) {
  const active = document.activeElement;
  if (active !== document.body && !surface?.contains(active)) return;
  previous?.focus?.();
}

/** Viewport height an open soft keyboard has already taken its share of. */
export function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}
