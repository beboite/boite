/**
 * What the palette is being asked for.
 *
 * One box, three questions. Until now it answered exactly one of them: a list
 * of commands, threads and projects, filtered by fuzzy match. An app that ships
 * an editor, a tab strip and a diff viewer had no way to open a file except
 * opening a panel and aiming at it with a mouse, and the command that opens a
 * web page reached for `window.prompt`, which draws a grey OS box that ignores
 * the theme, the language and the keyboard scope.
 *
 * The mode is a function of what has been typed plus what the palette was
 * opened as, and nothing else. Keeping it a pure read of the string is what
 * makes "does `>` still mean commands" a test rather than a click.
 */

export type PaletteMode = "commands" | "files" | "url";

/**
 * The character that switches a mode, and how a prompt says which one is on.
 *
 * `>` is the command prefix everyone already has in their fingers from VS Code,
 * and the palette's own default is commands, so typing it changes nothing
 * except that it stops being searched as a literal `>`.
 */
export const MODE_PREFIX: Record<PaletteMode, string> = {
  commands: ">",
  files: "/",
  url: "",
};

export interface ParsedQuery {
  mode: PaletteMode;
  /** What to search for, with the prefix taken off. */
  term: string;
}

const URL_START = /^https?:\/\//i;

/**
 * Which mode a raw input means.
 *
 * `opened` is the mode the palette was opened in, which is what an unprefixed
 * query stays in: a file search that flipped back to commands on the first
 * character typed would be unusable.
 *
 * A pasted absolute URL is its own answer whatever mode is on. Somebody who
 * pastes `http://localhost:5173` into a search box has said what they want, and
 * the alternative is a fuzzy match against a list that will never contain it.
 */
export function parsePaletteQuery(
  raw: string,
  opened: PaletteMode = "commands",
): ParsedQuery {
  if (URL_START.test(raw.trim())) return { mode: "url", term: raw.trim() };
  if (raw.startsWith(MODE_PREFIX.commands)) {
    return { mode: "commands", term: raw.slice(1) };
  }
  if (raw.startsWith(MODE_PREFIX.files)) {
    return { mode: "files", term: raw.slice(1) };
  }
  // A URL mode with something half-typed in it stays in URL mode: the box was
  // opened to take an address, and `local` is a prefix of one.
  return { mode: opened, term: raw };
}

/**
 * Whether a mode answers from a list held in memory or from a call.
 *
 * The commands are rebuilt on open and filtered locally, so every keystroke is
 * a fuzzy pass over an array. Files are a search on the other side of the
 * backend, which is why they are debounced, cancelled and never re-filtered
 * here: filtering an already-filtered answer with a second, different matcher
 * is how a hit the backend found disappears from the list that shows it.
 */
export function modeQueriesBackend(mode: PaletteMode): boolean {
  return mode === "files";
}

/** How short a term is not worth a search. */
export const FILE_SEARCH_MIN = 1;
export const FILE_SEARCH_LIMIT = 40;
