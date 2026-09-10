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
}

/** Threads shown before any typing: the most recent ones, whatever the project. */
export const RECENT_THREADS = 8;
/** The most rows the list ever holds. */
export const PALETTE_LIMIT = 24;

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * How well `text` answers `query`, higher is better, null is no match. A
 * prefix beats a word start, a word start beats a substring, a substring
 * beats letters found in order with gaps between them.
 */
export function scoreMatch(query: string, text: string): number | null {
  const needle = fold(query.trim());
  if (needle.length === 0) return 0;
  const hay = fold(text);
  if (hay.startsWith(needle)) return 100;
  const at = hay.indexOf(needle);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s\-_/.:]/.test(hay.charAt(at - 1));
    return (wordStart ? 80 : 60) - Math.min(at, 20);
  }
  // Letters in order: each gap costs, a query longer than the text cannot fit.
  let index = 0;
  let gaps = 0;
  let last = -1;
  for (const char of needle) {
    const found = hay.indexOf(char, index);
    if (found < 0) return null;
    if (last >= 0 && found > last + 1) gaps += 1;
    last = found;
    index = found + 1;
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
