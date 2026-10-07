import type { Message } from '@boite/contracts';

/** What the window lists: a message, or one row of a message cut in several (`timeline-rows.ts`). */
type Slot = { readonly id: string };

/**
 * What the window has cost since the page loaded: one count per recompute of
 * the slice, one per slot height read, one per walk over the tool calls of the
 * turns that end on screen. The bench tests in `MessageList.test.ts` read them
 * to prove they stay flat while a message streams and while a scroll stays
 * inside the rows drawn; nothing else does, and none is reactive.
 */
export const windowStats = { recomputes: 0, slots: 0, turnFiles: 0 };

/** Under this many messages the list renders whole: a window would cost more than it saves. */
export const WINDOW_FROM = 24;
/** Messages kept rendered above and below the viewport, so a scroll finds them already there. */
export const OVERSCAN = 4;
/** What a message's slot is worth before it has been measured. */
export const ESTIMATE = 80;
/** The column's --chat-message-gap in app.css, included in each measured slot. */
export const GAP = 20;
/** --chat-block-gap in app.css: what a row that continues a cut message keeps above it instead. */
export const BLOCK_GAP = 12;
/** A prompt's picture before it is opened: `UserMessage`'s thumbnail height. */
export const THUMB_HEIGHT = 240;
/** What a picture adds besides itself: the row's margin and the frame. */
const THUMB_ROW = 10;

/**
 * What a message is worth before it is measured. A prompt's pictures count
 * their thumbnails on top of `ESTIMATE`, at the height their size gives when a
 * light page sent one: a screenshot taken for 80 px became 330 once on
 * screen, and everything below the reader moved by the difference.
 */
export function estimateSlot(message: Message): number {
  if (message.role !== 'user') return ESTIMATE;
  let pictures = 0;
  for (const part of message.parts) {
    if (part.type !== 'image') continue;
    pictures += (part.width && part.height ? Math.min(THUMB_HEIGHT, part.height) : THUMB_HEIGHT) + THUMB_ROW;
  }
  return ESTIMATE + pictures;
}

// -- the running totals ------------------------------------------------------
// `sums[i]` is the height of everything above message `i`. A spacer is then
// one subtraction and the slice one bisection, instead of the walk over every
// message the window used to do on each recompute, streaming deltas included.

export class SlotTotals<S extends Slot = Slot> {
  sums: number[] = [0];
  /** What `sums` was built on: how many messages there were, and the id at the head. */
  sumsCount = 0;
  sumsHead = '';
  sumsTail = '';
  sumsOrder = '';
  /** The lowest index a measurement invalidated. Repaired from there on the next read. */
  dirty = 0;
  /** Where each message sits, so a measurement finds its index without scanning. */
  readonly positions = new Map<string, number>();

  /**
   * `heights` holds the measured slot heights by row id. What is not in it is
   * worth `estimate`: ESTIMATE here, `estimateSlot` and a cut row's own count
   * of parts in the timeline.
   */
  constructor(private readonly heights: Map<string, number>, private readonly estimate: (slot: S) => number = () => ESTIMATE) {}

  /** What a row weighs until it is measured. */
  estimateOf(slot: S | undefined): number {
    return slot ? this.estimate(slot) : ESTIMATE;
  }

  slotAt(list: readonly S[], index: number): number {
    windowStats.slots += 1;
    const slot = list[index];
    if (!slot) return ESTIMATE;
    return this.heights.get(slot.id) ?? this.estimate(slot);
  }

  rebuild(list: readonly S[], timelineOrder: string): void {
    this.sums = new Array<number>(list.length + 1);
    this.sums[0] = 0;
    this.positions.clear();
    for (let i = 0; i < list.length; i += 1) {
      const message = list[i];
      if (message) this.positions.set(message.id, i);
      this.sums[i + 1] = (this.sums[i] ?? 0) + this.slotAt(list, i);
    }
    this.sumsCount = list.length;
    this.sumsHead = list[0]?.id ?? '';
    this.sumsTail = list.at(-1)?.id ?? '';
    this.sumsOrder = timelineOrder;
    this.dirty = list.length;
  }

  /**
   * The totals for this list. A page prepended above the window moves every
   * index and starts the array again; messages arriving at the bottom extend
   * it; a height that moved repairs the totals from its own index down, never
   * from the top.
   */
  totals(list: readonly S[], timelineOrder: string): number[] {
    const head = list[0]?.id ?? '';
    if (head !== this.sumsHead || list.length < this.sumsCount || (list.length === this.sumsCount && timelineOrder !== this.sumsOrder) || (list.length > this.sumsCount && list[this.sumsCount - 1]?.id !== this.sumsTail)) {
      this.rebuild(list, timelineOrder);
      return this.sums;
    }
    if (list.length > this.sumsCount) {
      this.sums.length = list.length + 1;
      if (this.sumsCount < this.dirty) this.dirty = this.sumsCount;
      for (let i = this.sumsCount; i < list.length; i += 1) {
        const message = list[i];
        if (message) this.positions.set(message.id, i);
      }
      this.sumsCount = list.length;
    }
    for (let i = this.dirty; i < list.length; i += 1) this.sums[i + 1] = (this.sums[i] ?? 0) + this.slotAt(list, i);
    this.dirty = list.length;
    this.sumsTail = list.at(-1)?.id ?? '';
    this.sumsOrder = timelineOrder;
    return this.sums;
  }

  /** Where a message sits now, off the map the totals keep; a miss falls back to a scan. */
  indexOf(timeline: readonly S[], id: string): number {
    const at = this.positions.get(id);
    if (at !== undefined && timeline[at]?.id === id) return at;
    return timeline.findIndex((message) => message.id === id);
  }
}

/**
 * The observed sizes that still count once their frame comes. A row the window
 * dropped since the observer ran keeps the box it reported: discarding it left
 * the row's slot at the estimate, so the spacer that replaced it was shorter
 * than the row, the browser's scroll anchoring moved the list, the window
 * mounted the row again for one frame, and the cycle never ended. A detached
 * row counts only while its message is still `listed` and no element on screen
 * reports the same message.
 */
export function measurable(entries: ResizeObserverEntry[], listed: (id: string) => boolean): ResizeObserverEntry[] {
  const mid = (entry: ResizeObserverEntry) => (entry.target as HTMLElement).dataset?.['mid'];
  const shown = new Set(entries.filter(entry => entry.target.isConnected).map(mid));
  return entries.filter((entry) => {
    if (entry.target.isConnected) return true;
    const id = mid(entry);
    return !!id && !shown.has(id) && (entry.borderBoxSize?.[0]?.blockSize ?? 0) > 0 && listed(id);
  });
}

/** One computed window: the rows drawn, the first one on screen, and what the two spacers weigh. */
export interface WindowView { start: number; end: number; first: number; above: number; below: number }

/**
 * `next`, or `previous` itself when it says the same thing. A scroll inside
 * the rows already drawn then hands back the very object the page was built
 * from, and nothing that reads the window runs again: the slice, the turns it
 * shows, the effects that follow its spacers.
 */
export function sameView(previous: WindowView | undefined, next: WindowView): WindowView {
  return previous && previous.start === next.start && previous.end === next.end && previous.first === next.first
    && previous.above === next.above && previous.below === next.below ? previous : next;
}

/** The last message whose top is at or above `at`. The totals only ever grow. */
export function atOrBefore(total: number[], count: number, at: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((total[mid] ?? 0) <= at) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The first message at or after `from` whose top reaches `at`, or the end of the list. */
export function reaches(total: number[], count: number, from: number, at: number): number {
  let low = from;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((total[mid] ?? 0) >= at) high = mid;
    else low = mid + 1;
  }
  return low;
}
