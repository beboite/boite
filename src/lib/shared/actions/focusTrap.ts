import { restoreFocus } from "$lib/shared/keyboard/overlay";

/**
 * Tab stays inside an open surface, and the keyboard goes back where it was.
 *
 * Every overlay in the app had written half of this for itself: ConfirmDialog
 * cycled Tab over its two buttons, FolderBrowser over every enabled button,
 * MobileSheet over a selector, and the palette, the wizard, the merge overlay,
 * the remote picker, the colour popover and the launcher menu over nothing at
 * all — Tab walked out of the dialog and onto the page underneath, which is
 * still painted and still clickable behind a scrim nobody with a keyboard can
 * see.
 *
 * The listener is on `document` in the capture phase rather than on the node.
 * A trap whose node hears the key only works while focus is already inside it,
 * and the case that matters most is the one where it is not: the merge overlay
 * replaces its file list, the folder browser replaces its rows, and the element
 * that had the keyboard is gone by the next frame, so focus has fallen on
 * `<body>` and nothing bubbles through the dialog any more.
 *
 * Only the innermost trap answers, so a colour popover opened over the settings
 * panel cycles its swatches rather than the panel behind it.
 */

/**
 * What the browser would put in the tab order. `[tabindex="-1"]` is excluded on
 * purpose: it is how this app spells "focusable by script, not by Tab", and
 * every dialog root wears it.
 */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type FocusTrapOptions = {
  /**
   * Takes the keyboard when the surface opens, instead of the first focusable
   * child. ConfirmDialog opens a destructive question on Cancel, and the wizard
   * opens on Next, neither of which is first in the markup.
   */
  initial?: HTMLElement | null;
};

/**
 * Where Tab goes, or `null` to let the browser move focus itself.
 *
 * Pure so the cycling can be tested without a DOM: the test run has no browser
 * (`vitest.config.ts` says why), and this is the half of the trap that has an
 * off-by-one in it.
 */
export function tabTarget<T>(
  items: readonly T[],
  active: T | null,
  shiftKey: boolean,
): T | null {
  if (items.length === 0) return null;
  const first = items[0];
  const last = items[items.length - 1];
  const index = active === null ? -1 : items.indexOf(active);
  // Focus has left the surface, or sits on the surface itself: Tab re-enters at
  // the end it came from rather than jumping to the top every time.
  if (index === -1) return shiftKey ? last : first;
  if (!shiftKey && index === items.length - 1) return first;
  if (shiftKey && index === 0) return last;
  return null;
}

/** The tabbable elements of a surface, in document order, minus the hidden. */
export function focusablesIn(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.offsetParent !== null,
  );
}

const stack: HTMLElement[] = [];

function handleTab(e: KeyboardEvent) {
  if (e.key !== "Tab" || e.defaultPrevented) return;
  const node = stack[stack.length - 1];
  if (!node) return;
  const items = focusablesIn(node);
  if (items.length === 0) {
    // A surface with nothing to tab through still has to keep the keyboard:
    // letting Tab out of it is what put focus on the page behind the scrim.
    e.preventDefault();
    node.focus({ preventScroll: true });
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const target = tabTarget(items, active && node.contains(active) ? active : null, e.shiftKey);
  if (!target) return;
  e.preventDefault();
  target.focus({ preventScroll: true });
}

// Module lifetime, like the Escape stack next door: it has to outlive every
// surface that uses it, and it costs one early return per keystroke while
// nothing is open.
if (typeof document !== "undefined") {
  document.addEventListener("keydown", handleTab, { capture: true });
}

/**
 * `use:focusTrap` on the element the surface draws itself in.
 *
 * On mount the keyboard moves inside, unless the surface has already placed it
 * somewhere itself: the palette puts the caret in its own input, and the two
 * dialogs pick which button opens focused. On destroy it goes back to whoever
 * had it, which is the half that makes closing a dialog with Escape leave you
 * where you were rather than on `<body>` with a terminal that has stopped
 * taking keys.
 */
export function focusTrap(node: HTMLElement, options: FocusTrapOptions = {}) {
  let opts = options;
  const previous = document.activeElement as HTMLElement | null;
  stack.push(node);

  function place() {
    if (node.contains(document.activeElement)) return;
    const selfFocusable = node.hasAttribute("tabindex") && node.tabIndex === -1 ? node : null;
    const target = opts.initial ?? selfFocusable ?? focusablesIn(node)[0] ?? null;
    target?.focus({ preventScroll: true });
  }

  // Deferred by one microtask: a `bind:this` on a child is written after the
  // parent's action has run, so `initial` is still null right now.
  queueMicrotask(place);

  return {
    update(next: FocusTrapOptions) {
      opts = next;
      // The surface re-rendered under the keyboard: the wizard drops its footer
      // on the consent step, the merge overlay replaces its file list, and the
      // element that had focus went with it, leaving it on <body>. Put it back
      // inside rather than let the page behind the scrim keep it.
      if (document.activeElement === document.body) place();
    },
    destroy() {
      const i = stack.lastIndexOf(node);
      if (i >= 0) stack.splice(i, 1);
      // A node the surface has already torn out of the page cannot take the
      // keyboard, and handing it back would be the same as dropping it.
      if (previous?.isConnected) restoreFocus(previous, node);
    },
  };
}
