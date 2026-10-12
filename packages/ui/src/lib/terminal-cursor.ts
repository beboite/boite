/*
 * The shape of the terminal cursor, per device: a bar as in Windows Terminal, a
 * block or an underline. It blinks whatever its shape, and a program that asks
 * for another shape (vim's block in normal mode) still gets it. Choosing one
 * stamps `data-terminal-cursor` on `<html>`, which the open screens watch.
 */

export type TerminalCursor = 'bar' | 'block' | 'underline';

export const TERMINAL_CURSORS: readonly TerminalCursor[] = ['bar', 'block', 'underline'];

export const TERMINAL_CURSOR_STORAGE_KEY = 'boite.terminalCursor';

/** The shape picked on this page, which storage may have refused to keep. */
let picked: TerminalCursor | undefined;

/** The shape picked here, else the stored one: `bar` when nothing is stored, storage is refused or the id is unknown. */
export function readTerminalCursor(): TerminalCursor {
  if (picked !== undefined) return picked;
  try {
    const raw = window.localStorage.getItem(TERMINAL_CURSOR_STORAGE_KEY);
    return TERMINAL_CURSORS.includes(raw as TerminalCursor) ? (raw as TerminalCursor) : 'bar';
  } catch {
    return 'bar';
  }
}

export function setTerminalCursor(cursor: TerminalCursor): void {
  picked = cursor;
  try {
    if (cursor === 'bar') window.localStorage.removeItem(TERMINAL_CURSOR_STORAGE_KEY);
    else window.localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, cursor);
  } catch {
    /* a browser that refuses storage still changes the open screens */
  }
  document.documentElement.dataset['terminalCursor'] = cursor;
}

/**
 * Whether terminals draw on the GPU (WebGL), per device. On by default; off
 * draws with xterm's DOM renderer, for a GPU or driver that draws badly. It
 * applies to screens opened after the change.
 */
export const TERMINAL_GPU_STORAGE_KEY = 'boite.terminalGpu';

let gpuPicked: boolean | undefined;

export function readTerminalGpu(): boolean {
  if (gpuPicked !== undefined) return gpuPicked;
  try {
    return window.localStorage.getItem(TERMINAL_GPU_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setTerminalGpu(on: boolean): void {
  gpuPicked = on;
  try {
    // Stored either way: an empty key means "never chosen", which a fresh profile can default.
    window.localStorage.setItem(TERMINAL_GPU_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* a browser that refuses storage still changes the next screens */
  }
}
