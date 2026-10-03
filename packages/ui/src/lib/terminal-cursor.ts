/*
 * The shape of the terminal cursor, per device: a bar as in Windows Terminal, a
 * block or an underline. It blinks whatever its shape, and a program that asks
 * for another shape (vim's block in normal mode) still gets it. Choosing one
 * stamps `data-terminal-cursor` on `<html>`, which the open screens watch.
 */

export type TerminalCursor = 'bar' | 'block' | 'underline';

export const TERMINAL_CURSORS: readonly TerminalCursor[] = ['bar', 'block', 'underline'];

export const TERMINAL_CURSOR_STORAGE_KEY = 'boite.terminalCursor';

/** The stored shape, `bar` when nothing is stored, storage is refused or the id is unknown. */
export function readTerminalCursor(): TerminalCursor {
  try {
    const raw = window.localStorage.getItem(TERMINAL_CURSOR_STORAGE_KEY);
    return TERMINAL_CURSORS.includes(raw as TerminalCursor) ? (raw as TerminalCursor) : 'bar';
  } catch {
    return 'bar';
  }
}

export function setTerminalCursor(cursor: TerminalCursor): void {
  try {
    if (cursor === 'bar') window.localStorage.removeItem(TERMINAL_CURSOR_STORAGE_KEY);
    else window.localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, cursor);
  } catch {
    /* a browser that refuses storage still changes the open screens */
  }
  document.documentElement.dataset['terminalCursor'] = cursor;
}
