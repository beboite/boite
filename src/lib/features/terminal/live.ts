/**
 * The xterm instances currently on screen, by thread id.
 *
 * Exists for one reason: an agent driving this app through the MCP bridge can
 * read the DOM, and the terminals are not in it. They render to a WebGL canvas,
 * so `document.querySelector` finds an element with no text in it and the
 * entire output of every agent Boite runs is invisible to the one tool that
 * could check whether a change worked.
 *
 * Registered unconditionally, and since the status engine started reading the
 * live rows off the emulator (`statusEngine.ts`) it is no longer only the dev
 * inspector looking: the map is load-bearing in release builds too.
 */

import type { Terminal } from "@xterm/xterm";

const live = new Map<string, Terminal>();

export function registerTerminal(threadId: string, term: Terminal) {
  live.set(threadId, term);
}

export function unregisterTerminal(threadId: string) {
  live.delete(threadId);
}

export function liveTerminal(threadId: string): Terminal | null {
  return live.get(threadId) ?? null;
}

export function liveTerminalIds(): string[] {
  return [...live.keys()];
}

/**
 * What the terminal is showing, as text.
 *
 * Trailing blank lines are dropped because a terminal is almost always mostly
 * empty rows, and `tail` counts from the end for the same reason: the answer to
 * "did it work" is at the bottom.
 */
export function terminalText(term: Terminal, tail = 200): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-tail).join("\n");
}

/**
 * The last `rows` rows the process has written something on, oldest first.
 *
 * Walks backwards from the bottom and stops as soon as it has them, so the cost
 * is the answer's size and not the buffer's. That matters: this runs for every
 * open terminal on the status tick, where `terminalText`'s full-scrollback walk
 * would be the most expensive thing in the app.
 *
 * Bounded below by `baseY`, the top of the screen region: rows above it are
 * scrollback, which is history and has nothing to say about what the agent is
 * doing now. Scrolling up to read something does not change the answer. On the
 * alternate screen `baseY` is 0 and the region is the whole buffer, which is
 * the same thing.
 *
 * Blank rows are skipped rather than returned. How many of them sit under an
 * agent's prompt box is a layout accident, and letting them fill the window
 * would push the footer out of it.
 */
export function terminalScreenRows(term: Terminal, rows: number): string[] {
  const buffer = term.buffer.active;
  const out: string[] = [];
  for (let i = buffer.length - 1; i >= buffer.baseY && out.length < rows; i--) {
    const text = buffer.getLine(i)?.translateToString(true) ?? "";
    if (text.trim() === "") continue;
    out.push(text);
  }
  return out.reverse();
}
