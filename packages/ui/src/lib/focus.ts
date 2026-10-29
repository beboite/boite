/**
 * Where the keyboard goes when an overlay or an inline field closes. Left on
 * `<body>`, the next Escape reaches the window's own handler, which stops the
 * running turn: every close path hands the focus back to something instead.
 */

import { touchScreen } from './device';

/** Automatic focus must not summon a touch keyboard. Keep existing typing uninterrupted. */
export function focusInitial(preferred: HTMLElement | null | undefined, fallback?: HTMLElement | null): boolean {
  if (preferred && document.activeElement === preferred) return true;
  const editsText = preferred?.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=reset]):not([type=file]):not([type=color]):not([type=hidden]):not([type=image]), [contenteditable]:not([contenteditable=false])');
  const target = touchScreen() && editsText ? fallback : preferred;
  target?.focus({ preventScroll: true });
  return !!target && document.activeElement === target;
}

/** Navigation returns to the composer frame on touch; explicit writing opens its text box. */
export function focusComposer({ typing = false }: { typing?: boolean } = {}): boolean {
  const box = document.querySelector<HTMLElement>('[data-testid=composer-input]');
  if (!box) return false;
  if (typing) { box.focus({ preventScroll: true }); return document.activeElement === box; }
  return focusInitial(box, box.closest<HTMLElement>('[data-testid=composer]'));
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
  if (previous?.isConnected && focusInitial(previous)) return;
  focusComposer();
}
