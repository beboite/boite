import type { MemoryEvent, Message, MessagePart } from '@boite/contracts';
import { promptText, visibleAnswer } from './message-display';

/**
 * What the timeline's window counts and measures. A message is one row, except
 * the kind a long agent session leaves: an assistant message that carries a
 * whole turn of work, a thousand tool calls and more with a paragraph between
 * each run of them. Drawn as one block it was all mounted whenever any of it
 * was near the viewport, tens of thousands of pixels of it, and each scroll
 * across its edge built or tore down every part at once. Such a message is
 * cut into rows of about `ROW_PARTS` parts, each one measured and windowed
 * like a message of its own (docs/performance.md, "A long turn is many rows").
 *
 * A cut falls only in front of a paragraph the page draws. An activity run
 * never spans it, so the rows draw exactly what the whole message drew, and
 * the gap above a continuing row is always the one a paragraph takes under
 * whatever came before it (`BLOCK_GAP`).
 */

/** The parts a row of a cut message holds before the next paragraph may start another. */
export const ROW_PARTS = 40;
/** A message is left whole up to this many parts: cutting it would save nothing. */
export const CUT_FROM = 64;

export interface TimelineRow {
  /** The message's id for a whole message and for the first row of a cut one, `<id>#<n>` for the rows after it. */
  id: string;
  message: Message;
  /** The parts this row draws, `[from, to)`. A whole message is `[0, parts.length)`. */
  from: number;
  to: number;
  /** Whether this is the first, and the last, row of its message. */
  first: boolean;
  last: boolean;
}

/**
 * What one part of a cut message is worth in pixels before its row is
 * measured: a run of a dozen calls is one line and the paragraph after it
 * three or four, about 150 px for thirteen parts in the threads this was read
 * from. An estimate a row's real height replaces; closer than the 80 px a
 * whole message gets, it moves the scrollbar less as a scroll measures rows.
 */
const PART_ESTIMATE = 11;

/** What a row weighs before it is measured: `whole` for a message drawn as one row. */
export function rowEstimate(row: TimelineRow, whole: number): number {
  return row.first && row.last ? whole : Math.max(whole, (row.to - row.from) * PART_ESTIMATE);
}

/** The text an assistant or system message shows for a part: what `AssistantMessage` draws. */
export function shownText(message: Message, part: Extract<MessagePart, { type: 'text' }>): string {
  return message.role === 'system' ? promptText(part) : visibleAnswer(part.text);
}

/**
 * Where a message is cut: the indices of the parts that start a row after the
 * first, in order. Each is a paragraph the page draws, at least `ROW_PARTS`
 * parts after the row's own start, and never the last part: the one an answer
 * is still writing is not read here, so a streamed delta cuts nothing again.
 * A memory notice anchored on a part keeps its place in the run before it.
 */
export function rowCuts(message: Message, anchored?: ReadonlySet<number>): number[] {
  const parts = message.parts;
  const count = parts.length;
  if (count <= CUT_FROM || message.role === 'user') return [];
  const cuts: number[] = [];
  let at = ROW_PARTS;
  while (at < count - 1) {
    const part = parts[at];
    if (part?.type === 'text' && !anchored?.has(at) && shownText(message, part).trim().length > 0) {
      cuts.push(at);
      at += ROW_PARTS;
    } else at += 1;
  }
  return cuts;
}

/** The part indices the memory notices of a message are anchored on. */
function anchoredParts(events: readonly MemoryEvent[] | undefined): ReadonlySet<number> | undefined {
  if (!events?.length) return undefined;
  return new Set(events.flatMap(event => event.anchor ? [event.anchor.partIndex] : []));
}

/**
 * The rows of a timeline, and the same row objects from one call to the next
 * for the messages that did not change: a part arriving at the bottom of a
 * streaming message leaves every row above its last one as it was, so nothing
 * that draws them runs again.
 */
export class TimelineRows {
  #known = new Map<string, TimelineRow>();
  #rows: TimelineRow[] = [];
  #order = '';
  #changedFrom = 0;

  /** The ids of the last rows built, in order and joined: what tells a reordered list from the same one. */
  get order(): string { return this.#order; }
  /**
   * The first index the last build put a different row at, the count of rows
   * when it changed none. A row that grew or was cut weighs something else
   * until it is measured, so the window's totals are repaired from there.
   */
  get changedFrom(): number { return this.#changedFrom; }

  build(timeline: readonly Message[], memory?: ReadonlyMap<string, MemoryEvent[]>): TimelineRow[] {
    const known = new Map<string, TimelineRow>();
    const rows: TimelineRow[] = [];
    let changedFrom = -1;
    const add = (id: string, message: Message, from: number, to: number, first: boolean, last: boolean): void => {
      const before = this.#known.get(id);
      const row = before && before.message === message && before.from === from && before.to === to && before.first === first && before.last === last
        ? before : { id, message, from, to, first, last };
      known.set(id, row);
      if (changedFrom < 0 && this.#rows[rows.length] !== row) changedFrom = rows.length;
      rows.push(row);
    };
    for (const message of timeline) {
      const count = message.parts.length;
      const cuts = count > CUT_FROM ? rowCuts(message, anchoredParts(memory?.get(message.id))) : [];
      if (cuts.length === 0) { add(message.id, message, 0, count, true, true); continue; }
      add(message.id, message, 0, cuts[0]!, true, false);
      cuts.forEach((from, index) => add(`${message.id}#${index + 1}`, message, from, cuts[index + 1] ?? count, false, index === cuts.length - 1));
    }
    this.#known = known;
    this.#changedFrom = changedFrom < 0 ? rows.length : changedFrom;
    // The same array while every row is the same object: what reads it has nothing to redo.
    if (changedFrom < 0 && rows.length === this.#rows.length) return this.#rows;
    this.#rows = rows;
    this.#order = rows.map(row => row.id).join('\0');
    return rows;
  }
}

/** The row of `messageId` that draws `part`, or its first row with no part named. -1 when the message is not listed. */
export function rowIndexOf(rows: readonly TimelineRow[], messageId: string, part?: number): number {
  let at = rows.findIndex(row => row.id === messageId);
  if (at < 0 || part === undefined) return at;
  while (rows[at + 1]?.message === rows[at]!.message && rows[at + 1]!.from <= part) at += 1;
  return at;
}

/**
 * How an assistant message that carries on the turn of the row above joins it.
 * A provider can open a new message in the middle of a turn, and the gap
 * between messages then cut one run of work in two. Joined, the seam takes the
 * gap the parts of one message take: `block` where text meets it, the space a
 * paragraph keeps, `part` between two runs of activity. Null for any other row.
 */
export function seam(previous: TimelineRow | undefined, row: TimelineRow): 'part' | 'block' | null {
  if (!previous || !row.first || row.message.role !== 'assistant' || previous.message.role !== 'assistant') return null;
  if (previous.message.turnId !== row.message.turnId || previous.message.id === row.message.id) return null;
  const shown = (part: MessagePart) => !(part.type === 'text' && part.text.trim() === '');
  const lead = row.message.parts.find(shown);
  const tail = previous.message.parts.slice(previous.from, previous.to).findLast(shown);
  return lead?.type === 'text' || tail?.type === 'text' ? 'block' : 'part';
}
