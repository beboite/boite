/**
 * The fenced code block grammar every reader of an answer shares: the streaming
 * paragraph scan, the Markdown renderer, view placement, the goal marker and
 * the code copy buttons. A run of three or more backticks or tildes opens a
 * block after at most three spaces, followed by an info string (no backtick in
 * a backtick fence's). The block closes on a line of the same character, at
 * least as long, with nothing after it.
 */
const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)\r?$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[\t ]*\r?$/;

export interface Fence {
  /** The opening run, which the closing line must match in character and at least in length. */
  marker: string;
  /** Spaces before the opening run, taken off each line of the code. */
  indent: number;
  /** The words after the opening run; the first one names the language. */
  info: string;
}

/** The fence this line opens, or null. */
export function openFence(line: string): Fence | null {
  const match = OPEN.exec(line);
  if (!match) return null;
  const marker = match[2]!;
  const info = match[3]!.trim();
  if (marker[0] === '`' && info.includes('`')) return null;
  return { marker, indent: match[1]!.length, info };
}

/** Whether this line closes `fence`. */
export function closesFence(line: string, fence: Fence): boolean {
  const run = CLOSE.exec(line)?.[1];
  return run !== undefined && run[0] === fence.marker[0] && run.length >= fence.marker.length;
}

/** The language a fence's info string names, or the empty string. */
export function fenceLanguage(fence: Fence): string {
  return fence.info.split(/\s/, 1)[0] ?? '';
}

/** Follows fences one line at a time. */
export class FenceScan {
  #open: Fence | null = null;

  /** Inside a block, after its opening line and before its closing one. */
  get inside(): boolean {
    return this.#open !== null;
  }

  /** Reads the next line; true when it opens or closes a block. */
  line(line: string): boolean {
    if (this.#open) {
      if (!closesFence(line, this.#open)) return false;
      this.#open = null;
      return true;
    }
    this.#open = openFence(line);
    return this.#open !== null;
  }

  reset(): void {
    this.#open = null;
  }
}
