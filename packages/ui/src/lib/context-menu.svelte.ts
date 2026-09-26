import { focusedElement } from './focus';
import type { MenuItem } from './menu';

/** The one context menu of the app: where it opens, what it lists, who hears the pick. */
export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
  onpick: (id: string) => void;
}

class ContextMenuStore {
  current = $state<ContextMenuState | null>(null);
  /**
   * Where the keyboard goes back when the menu closes: the button that opened
   * it, else what had the focus. Not reactive, the menu reads it once on close.
   */
  returnTo: HTMLElement | null = null;

  /** Opens at the pointer, or at the element's corner when the menu key opened it. */
  open(event: MouseEvent, items: MenuItem[], onpick: (id: string) => void): void {
    event.preventDefault();
    event.stopPropagation();
    let x = event.clientX;
    let y = event.clientY;
    if (x === 0 && y === 0 && event.currentTarget instanceof HTMLElement) {
      const rect = event.currentTarget.getBoundingClientRect();
      x = rect.left + 8;
      y = rect.bottom;
    }
    const opener = event.currentTarget;
    this.returnTo = opener instanceof HTMLButtonElement ? opener : focusedElement();
    this.current = { x, y, items, onpick };
  }

  close(): void {
    this.current = null;
  }
}

export const contextMenu = new ContextMenuStore();
