/*
 * The command palette's list: threads across every project and the app's own
 * commands, ranked against what is typed. Pure, so the ranking is a unit
 * test and the component only draws.
 */

export type PaletteKind = 'thread' | 'project' | 'command';

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
  /** The heading a row sits under: a thread's project on its machine. Rows without one group by kind. */
  section?: string;
}

/** A text a query word may land on, and what landing there costs against the label. */
export interface SearchField {
  text: string;
  penalty?: number;
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
 * How well a row with these fields answers `query`, null when it does not. The
 * whole query may land on one field ("port the" on a title); otherwise every
 * word lands on its own field, the weakest decides, so "boite m2" finds the
 * project boite on the machine m2 and "trace boite" a thread of boite.
 */
export function scoreFields(query: string, fields: readonly SearchField[]): number | null {
  const best = (needle: string): number | null => {
    let top: number | null = null;
    for (const field of fields) {
      const score = scoreMatch(needle, field.text);
      if (score !== null) top = Math.max(top ?? -Infinity, score - (field.penalty ?? 0));
    }
    return top;
  };
  const whole = best(query);
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  if (words.length < 2) return whole;
  let worst: number | null = Infinity;
  for (const word of words) {
    const score = best(word);
    if (score === null) { worst = null; break; }
    worst = Math.min(worst, score);
  }
  if (worst === null) return whole;
  return Math.max(whole ?? -Infinity, worst);
}

/** A row's fields: its label, then its keywords, then its hint, each a little weaker. */
function itemFields(item: PaletteItem): SearchField[] {
  return [
    { text: item.label },
    ...(item.keywords === undefined ? [] : [{ text: item.keywords, penalty: 5 }]),
    ...(item.hint === undefined ? [] : [{ text: item.hint, penalty: 10 }])
  ];
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
    const score = scoreFields(query, itemFields(item));
    if (score !== null && score >= 0) scored.push({ item, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((entry) => entry.item);
}

export interface PaletteSection {
  /** The rows' `section`, or their kind for rows without one. */
  id: string;
  kind: PaletteKind;
  items: PaletteItem[];
}

/**
 * Ranked rows cut into the headings the palette draws: a project's threads
 * together, then the projects, then the commands. A section stands where its
 * best row ranked, its rows keep their order inside it, so typing still puts
 * the best match first and the first row is always the best one.
 */
export function sectionRows(ranked: readonly PaletteItem[]): PaletteSection[] {
  const sections = new Map<string, PaletteSection>();
  for (const item of ranked) {
    const id = item.section ?? item.kind;
    const section = sections.get(id);
    if (section) section.items.push(item);
    else sections.set(id, { id, kind: item.kind, items: [item] });
  }
  return [...sections.values()];
}
