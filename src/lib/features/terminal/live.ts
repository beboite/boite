/**
 * The xterm instances currently on screen, by thread id.
 *
 * Exists for one reason: an agent driving this app through the MCP bridge can
 * read the DOM, and the terminals are not in it. They render to a WebGL canvas,
 * so `document.querySelector` finds an element with no text in it and the
 * entire output of every agent Boite runs is invisible to the one tool that
 * could check whether a change worked.
 *
 * Registered unconditionally and read only by the dev inspector, which is
 * itself behind `import.meta.env.DEV`. The map costs one reference per open
 * terminal; guarding the writes as well would mean a conditional in the mount
 * path for nothing.
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
