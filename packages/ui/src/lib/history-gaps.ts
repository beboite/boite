import type { Message, MessageId } from '@boite/contracts';
import { ESTIMATE, atOrBefore } from './message-window';
import type { TimelineRow } from './timeline-rows';
import type { MissingStretch } from './store/message-positions.svelte';

/**
 * The history a thread does not hold, drawn where it belongs. Each stretch of
 * missing messages is one row worth every message at the estimate, so the
 * scrollbar spans the whole thread from the first page on and a drag to the
 * top lands on the top. The stretch that comes within reach of the screen is
 * read by position (`MessagePositions.loadRange`), and the reader keeps the
 * row it reads as the page goes in (`loadKeepingReader`): a message cut in
 * rows weighs more than the gap counted for it. The measurements that follow
 * keep the reader still like any message entering the window.
 */

/** No stretch missing: one map, so a thread held whole never looks changed. */
export const NO_GAPS: ReadonlyMap<MessageId, MissingStretch> = new Map();

/** What a missing stretch weighs: every message at the estimate. */
export function gapHeight(count: number): number {
  return count * ESTIMATE;
}

/** Where a gap row sits in the rows, the stretch it stands for and the held message right below it. */
export interface GapAt extends MissingStretch { index: number; below: MessageId }

/**
 * A page to read: `limit` messages from position `from` on, or, with `below`,
 * the `limit` messages right above that held message, the newest first when
 * the page runs out of bytes.
 */
export interface WantedRange { from: number; limit: number; below?: MessageId }

/**
 * The rows with a gap row for each missing stretch. A stretch goes right
 * after the last row of the messages held above it, so a card written while
 * it was going on (agent mail, a launch, a run) waits below it, beside the
 * next message held, until its page lands. `at` maps an index of `rows` to
 * the same row's index once the gaps are in.
 */
export function withGaps(rows: TimelineRow[], messages: readonly Message[], gaps: ReadonlyMap<MessageId, MissingStretch>): { rows: TimelineRow[]; gaps: GapAt[]; at: (index: number) => number } {
  if (gaps.size === 0) return { rows, gaps: [], at: index => index };
  const rank = new Map(messages.map((message, index) => [message.id, index]));
  // The last row of every held message, then of every message up to it.
  const lastRow = new Array<number>(messages.length).fill(-1);
  rows.forEach((row, index) => {
    const at = rank.get(row.message.id);
    if (at !== undefined) lastRow[at] = index;
  });
  for (let index = 1; index < lastRow.length; index += 1) lastRow[index] = Math.max(lastRow[index]!, lastRow[index - 1]!);
  // Two stretches can meet at one place, around a held message that draws no row of its own: each keeps its row.
  const before = new Map<number, (MissingStretch & { below: MessageId })[]>();
  for (const [id, stretch] of gaps) {
    const next = rank.get(id);
    if (next === undefined) continue;
    const at = next === 0 ? 0 : lastRow[next - 1]! + 1;
    before.set(at, [...(before.get(at) ?? []), { ...stretch, below: id }]);
  }
  const out: TimelineRow[] = [];
  const found: GapAt[] = [];
  const moved: number[] = [];
  const place = (index: number) => {
    for (const stretch of before.get(index) ?? []) {
      const id = `gap:${stretch.from}:${stretch.count}`;
      const message: Message = { id, threadId: '', turnId: id, role: 'system', parts: [], state: 'complete', createdAt: 0 };
      found.push({ index: out.length, ...stretch });
      out.push({ id, message, from: 0, to: 0, first: true, last: true, gap: { from: stretch.from, count: stretch.count } });
    }
  };
  rows.forEach((row, index) => {
    place(index);
    moved.push(out.length);
    out.push(row);
  });
  place(rows.length);
  return { rows: out, gaps: found, at: index => moved[index] ?? out.length };
}

/**
 * `withGaps` once per change of the rows or of the stretches: a streamed delta
 * hands back the same rows and the same stretches, and so gets the very same
 * answer, and nothing that reads the rows runs again.
 */
export class GapRows {
  #rows: TimelineRow[] | null = null;
  #gaps: ReadonlyMap<MessageId, MissingStretch> | null = null;
  #last: ReturnType<typeof withGaps> | null = null;

  place(rows: TimelineRow[], messages: readonly Message[], gaps: ReadonlyMap<MessageId, MissingStretch>): ReturnType<typeof withGaps> {
    if (this.#last && rows === this.#rows && gaps === this.#gaps) return this.#last;
    this.#rows = rows;
    this.#gaps = gaps;
    return this.#last = withGaps(rows, messages, gaps);
  }
}

/**
 * The row drawn at the top of `view` and how far its top is from the view's,
 * read off the page: what a page landing above it must not move.
 */
export function rowOnScreen(view: HTMLElement): { id: string; offset: number } | null {
  const top = view.getBoundingClientRect().top;
  for (const node of view.querySelectorAll<HTMLElement>('[data-mid]')) {
    const box = node.getBoundingClientRect();
    if (box.bottom > top) return { id: node.dataset['mid']!, offset: box.top - top };
  }
  return null;
}

/**
 * A range read with the reader kept on their row. Where it stands on screen is
 * read as the page lands (`landing`), on the rows still drawn, not when it was
 * asked for, since the reader goes on scrolling meanwhile. `hold` then puts
 * the window on that row among the rows placed: a row cut in parts is worth
 * more than the gap gave its message, and a page of long answers pushed the
 * row thousands of pixels down, out of the rows drawn, and the reader onto the
 * skeleton where it was (`hold` keeps it drawn). The row is read again once
 * the new rows are drawn (`drawn`): the view moves by the difference. A
 * browser that anchors the scroll has often kept the row already, and then
 * nothing moves; one that does not, or a list streaming with anchoring off,
 * is put back here. `box` is undefined while the list keeps to its bottom: it
 * has no row to keep.
 */
export async function loadKeepingReader(
  load: (landing: () => void) => Promise<number>,
  box: () => HTMLElement | undefined,
  hold: (kept: { id: string; offset: number }) => void,
  drawn: () => Promise<void>,
  moved: (top: number) => void
): Promise<number> {
  const reading: { kept: { id: string; offset: number } | null } = { kept: null };
  const added = await load(() => {
    const view = box();
    reading.kept = view ? rowOnScreen(view) : null;
    if (reading.kept) hold(reading.kept);
  });
  const kept = reading.kept;
  if (!added || !kept) return added;
  await drawn();
  const view = box();
  if (!view) return added;
  const node = view.querySelector<HTMLElement>(`[data-mid="${CSS.escape(kept.id)}"]`);
  const drift = node ? node.getBoundingClientRect().top - view.getBoundingClientRect().top - kept.offset : 0;
  if (drift !== 0) view.scrollTop += drift;
  // The window was put where the rows say the reader is; the page says where it is.
  moved(view.scrollTop);
  return added;
}

/**
 * The page to ask for: in the gap that meets `[top, bottom]`, the one closest
 * to it, the stretch that band covers grown to `page` messages. A band that
 * reaches the message held below the gap takes the page right above that
 * message, read up from it (`below`), so a scroll up meets each message once
 * and a page cut short by its bytes keeps the messages next to the reader; one
 * that reaches the message held above takes the page right below it. A band
 * over a whole gap reads from the edge nearer its middle. Null when no gap
 * meets the band. `total[i]` is the top of row `i`.
 */
export function wantedRange(total: number[], gaps: readonly GapAt[], top: number, bottom: number, page: number): WantedRange | null {
  let best: GapAt | null = null;
  let distance = Infinity;
  for (const gap of gaps) {
    const start = total[gap.index] ?? 0;
    const end = start + gapHeight(gap.count);
    const away = end < top ? top - end : start > bottom ? start - bottom : 0;
    if (away < distance) {
      distance = away;
      best = gap;
    }
  }
  if (!best || distance > 0) return null;
  const start = total[best.index] ?? 0;
  const end = best.from + best.count;
  const first = best.from + Math.min(best.count - 1, Math.max(0, Math.floor((top - start) / ESTIMATE)));
  const last = best.from + Math.min(best.count, Math.max(1, Math.ceil((bottom - start) / ESTIMATE)));
  const middle = (top + bottom) / 2;
  if (last >= end && (first > best.from || middle - start >= start + gapHeight(best.count) - middle)) {
    const from = Math.max(best.from, end - page);
    return { from, limit: end - from, below: best.below };
  }
  let from: number;
  if (first <= best.from) from = best.from;
  else from = Math.max(best.from, Math.min(end - page, Math.floor((first + last - page) / 2)));
  return { from, limit: Math.min(page, end - from) };
}

/**
 * Screens of history read ahead of a reader off the bottom: at a fast wheel a
 * page lands before its gap reaches the screen.
 */
export const READ_AHEAD = 3;

/**
 * How many of the newest `messages` draw a row within `reach` of the bottom of
 * `rows`, whose tops `total` holds, or a view one of those rows' turns placed
 * (`views` by turn: an answer draws it inline, with no row of its own): what
 * the live end keeps (`releaseOlder`), so the history it lets go of is never
 * on screen or about to be read.
 */
export function heldNear(total: number[], rows: readonly TimelineRow[], messages: readonly Message[], reach: number, views: ReadonlyMap<string, readonly Message[]>): number {
  const at = new Map(messages.map((message, index) => [message.id, index]));
  const turns = new Set<string>();
  let oldest = messages.length;
  for (let row = atOrBefore(total, rows.length, (total[rows.length] ?? 0) - reach); row < rows.length; row += 1) {
    for (const message of rows[row]!.failures ?? [rows[row]!.message]) {
      oldest = Math.min(oldest, at.get(message.id) ?? oldest);
      turns.add(message.turnId);
    }
  }
  for (const turn of turns) for (const view of views.get(turn) ?? []) oldest = Math.min(oldest, at.get(view.id) ?? oldest);
  return messages.length - oldest;
}

/**
 * Asks for a range a frame after the view moved, with what the view is by
 * then: a scroll the list makes itself (a jump to the latest page, then its
 * glide down) has started before the frame, and asks for nothing on its way.
 * An ask already waiting for its frame keeps it and reads the newest view:
 * a wheel or a finger moves the view on every frame, and an ask put off by
 * each move was never sent while the reader kept scrolling, who then crossed
 * the whole unread stretch on its estimate. The same range from the same
 * place is asked once. A page that landed nothing, failed or dropped because
 * the window changed under it, is asked again after 1 s, then 2, 4, up to
 * 30 s while it keeps landing nothing: a reader standing still gets it in the
 * end, a core that refuses is not asked every frame.
 */
export class RangeAsk {
  #last = '';
  #misses = 0;
  #quietUntil = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #frame = 0;
  #wanted: (() => { top: number; range: WantedRange | null } | null) | undefined;
  #load: ((range: WantedRange) => Promise<number>) | undefined;

  soon(wanted: () => { top: number; range: WantedRange | null } | null, load: (range: WantedRange) => Promise<number>): void {
    this.#wanted = wanted;
    this.#load = load;
    if (this.#timer !== undefined || this.#frame) return;
    const wait = this.#quietUntil - performance.now();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#run(); });
    }, Math.max(0, wait));
  }

  /** Drops the ask waiting for its frame: the list is gone. */
  stop(): void {
    clearTimeout(this.#timer);
    cancelAnimationFrame(this.#frame);
    this.#timer = undefined;
    this.#frame = 0;
  }

  #run(): void {
    const next = this.#wanted?.();
    const load = this.#load;
    if (!next?.range || !load) return;
    const key = `${next.range.from}:${next.range.limit}:${next.range.below ?? ''}:${Math.round(next.top)}`;
    if (key === this.#last) return;
    this.#last = key;
    void load(next.range).then((added) => {
      if (added > 0) { this.#misses = 0; return; }
      this.#quietUntil = performance.now() + Math.min(30_000, 1_000 * 2 ** this.#misses++);
      this.#last = '';
    });
  }
}
