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
