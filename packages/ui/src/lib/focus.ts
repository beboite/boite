/**
 * Where the keyboard goes when an overlay or an inline field closes. Left on
 * `<body>`, the next Escape reaches the window's own handler, which stops the
 * running turn: every close path hands the focus back to something instead.
 */

/** The composer's text box, when one is on the screen. */
export function focusComposer(): boolean {
  const box = document.querySelector<HTMLElement>('[data-testid=composer-input]');
  if (!box) return false;
  box.focus({ preventScroll: true });
  return true;
}

/**
 * The mousedown of a button beside the composer's box. A press moves the focus
 * there, and on a phone that blur closes the keyboard: Send then took a first
 * tap to close it and a second to send, and the keyboard dropped and came back
 * around removing an attachment. Prevented, the box keeps the focus it had.
 */
export function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}

/** True when the focus is inside `root`, the case a keyboard user is in. */
export function focusWithin(root: Element | null | undefined): boolean {
  return !!root && document.activeElement instanceof Element && root.contains(document.activeElement);
}

/** What had the focus before an overlay took it, or null when that was nothing worth coming back to. */
export function focusedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/** Back to what held the focus before, while it is still in the page, else the composer. */
export function restoreFocus(previous: HTMLElement | null): void {
  if (previous?.isConnected) {
    previous.focus({ preventScroll: true });
    if (document.activeElement === previous) return;
  }
  focusComposer();
}
