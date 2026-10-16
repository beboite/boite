import type { Message, MessageId } from '@boite/contracts';
import { ESTIMATE } from './message-window';
import type { TimelineRow } from './timeline-rows';
import type { MissingStretch } from './store/message-positions.svelte';

/**
 * The history a thread does not hold, drawn where it belongs. Each stretch of
 * missing messages is one row worth every message at the estimate, so the
 * scrollbar spans the whole thread from the first page on and a drag to the
 * top lands on the top. The stretch that comes within reach of the screen is
 * read by position (`MessagePositions.loadRange`), and its messages replace
 * rows worth what they are worth before they are measured: the page moves
 * nothing on screen, and the measurements that follow keep the reader still
 * like any message entering the window.
 */

/** What a missing stretch weighs: every message at the estimate. */
export function gapHeight(count: number): number {
  return count * ESTIMATE;
}

/** Where a gap row sits in the rows, and the stretch it stands for. */
export interface GapAt extends MissingStretch { index: number }

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
  const before = new Map<number, MissingStretch>();
  for (const [id, stretch] of gaps) {
    const next = rank.get(id);
    if (next !== undefined) before.set(next === 0 ? 0 : lastRow[next - 1]! + 1, stretch);
  }
  const out: TimelineRow[] = [];
  const found: GapAt[] = [];
  const moved: number[] = [];
  const place = (index: number) => {
    const stretch = before.get(index);
    if (!stretch) return;
    const id = `gap:${stretch.from}:${stretch.count}`;
    const message: Message = { id, threadId: '', turnId: id, role: 'system', parts: [], state: 'complete', createdAt: 0 };
    found.push({ index: out.length, ...stretch });
    out.push({ id, message, from: 0, to: 0, first: true, last: true, gap: stretch });
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
 * The page to ask for: in the gap that meets `[top, bottom]`, the one closest
 * to it, the stretch that band covers grown to `page` messages. A band that
 * reaches the message held below the gap takes the page right above that
 * message, so a scroll up meets each message once; one that reaches the
 * message held above takes the page right below it. Null when no gap meets
 * the band. `total[i]` is the top of row `i`.
 */
export function wantedRange(total: number[], gaps: readonly GapAt[], top: number, bottom: number, page: number): { from: number; limit: number } | null {
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
  let from: number;
  if (last >= end) from = Math.max(best.from, end - page);
  else if (first <= best.from) from = best.from;
  else from = Math.max(best.from, Math.min(end - page, Math.floor((first + last - page) / 2)));
  return { from, limit: Math.min(page, end - from) };
}

/**
 * Asks for a range a frame after the view moved, with what the view is by
 * then: a scroll the list makes itself (a jump to the latest page, then its
 * glide down) has started before the frame, and asks for nothing on its way.
 * A page that failed or landed nothing is asked again only after the reader
 * moved, never in a loop. Answers the cancel, for the effect that asked.
 */
export class RangeAsk {
  #last = '';

  soon(wanted: () => { top: number; range: { from: number; limit: number } | null } | null, load: (from: number, limit: number) => unknown): () => void {
    const frame = requestAnimationFrame(() => {
      const next = wanted();
      if (!next?.range) return;
      const key = `${next.range.from}:${next.range.limit}:${Math.round(next.top)}`;
      if (key === this.#last) return;
      this.#last = key;
      void load(next.range.from, next.range.limit);
    });
    return () => cancelAnimationFrame(frame);
  }
}
