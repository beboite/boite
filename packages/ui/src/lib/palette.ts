/*
 * The command palette's list: threads across every project and the app's own
 * commands, ranked against what is typed. Pure, so the ranking is a unit
 * test and the component only draws.
 */

export type PaletteKind = 'thread' | 'command';

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  label: string;
  /** The project name for a thread, the shortcut for a command. */
  hint?: string;
  /** Extra words a query may hit, never shown. */
  keywords?: string;
  /** The second line a list may draw under the label. The palette draws none; the slash menu does. */
  description?: string;
}

/** Threads shown before any typing: the most recent ones, whatever the project. */
export const RECENT_THREADS = 8;
/** The most rows the list ever holds: every command still fits under the recent threads. */
export const PALETTE_LIMIT = 32;

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const WORD_BREAK = /[\s\-_/.:]/;

function isWordStart(hay: string, at: number): boolean {
  return at === 0 || WORD_BREAK.test(hay.charAt(at - 1));
}

/** The next place `char` sits at a word start, at or after `from`; -1 when nowhere. */
function nextWordStart(hay: string, char: string, from: number): number {
  let at = hay.indexOf(char, from);
  while (at >= 0 && !isWordStart(hay, at)) at = hay.indexOf(char, at + 1);
  return at;
}

/**
 * How well `text` answers `query`, higher is better, null is no match. A
 * prefix beats a word start, a word start beats a substring, a substring
 * beats an abbreviation: letters in order where each one either starts a word
 * or follows the previous hit directly (`pts` for "Port the scheduler", `ftt`
 * for "Finish the trace tab"). Letters merely found somewhere in order do not
 * count, that rule matched half the list on four letters.
 */
export function scoreMatch(query: string, text: string): number | null {
  const needle = fold(query.trim());
  if (needle.length === 0) return 0;
  const hay = fold(text);
  if (hay.startsWith(needle)) return 100;
  // Several words: each one must land on its own, the weakest decides.
  if (/\s/.test(needle)) {
    let worst = 100;
    for (const word of needle.split(/\s+/)) {
      const score = scoreMatch(word, hay);
      if (score === null) return null;
      worst = Math.min(worst, score);
    }
    return worst;
  }
  const at = hay.indexOf(needle);
  if (at >= 0) return (isWordStart(hay, at) ? 80 : 60) - Math.min(at, 20);
  let gaps = 0;
  let last = -1;
  for (const char of needle) {
    let found = -1;
    if (last >= 0 && hay.charAt(last + 1) === char) found = last + 1;
    else {
      found = nextWordStart(hay, char, last + 1);
      if (found < 0) return null;
      if (last >= 0) gaps += 1;
    }
    last = found;
  }
  return Math.max(1, 30 - gaps * 3 - Math.min(last, 10));
}

/**
 * The rows to draw for `query`: every item that matches, best first, ties in
 * the order given. With nothing typed, the items come back as given, cut at
 * the limit, which is where the caller puts its recents.
 */
export function rankItems(query: string, items: PaletteItem[], limit = PALETTE_LIMIT): PaletteItem[] {
  if (query.trim().length === 0) return items.slice(0, limit);
  const scored: { item: PaletteItem; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const own = scoreMatch(query, item.label);
    const hint = item.hint === undefined ? null : scoreMatch(query, item.hint);
    const words = item.keywords === undefined ? null : scoreMatch(query, item.keywords);
    const best = Math.max(own ?? -1, hint === null ? -1 : hint - 10, words === null ? -1 : words - 5);
    if (best >= 0) scored.push({ item, score: best, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((entry) => entry.item);
}
