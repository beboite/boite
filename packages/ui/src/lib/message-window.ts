import type { Message } from '@boite/contracts';

/**
 * What the window has cost since the page loaded: one count per recompute of
 * the slice, one per slot height read. The bench test in `MessageList.test.ts`
 * reads them to prove both stay flat while a message streams; nothing else
 * does, and neither is reactive.
 */
export const windowStats = { recomputes: 0, slots: 0 };

/** Under this many messages the list renders whole: a window would cost more than it saves. */
export const WINDOW_FROM = 60;
/** Messages kept rendered above and below the viewport, so a scroll finds them already there. */
export const OVERSCAN = 8;
/** What a message's slot is worth before it has been measured. */
export const ESTIMATE = 80;
/** The column's flex gap, which belongs to the slot a message takes. */
export const GAP = 24;

// -- the running totals ------------------------------------------------------
// `sums[i]` is the height of everything above message `i`. A spacer is then
// one subtraction and the slice one bisection, instead of the walk over every
// message the window used to do on each recompute, streaming deltas included.

export class SlotTotals {
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

  /** `heights` holds the measured slot heights by message id. What is not in it is worth ESTIMATE. */
  constructor(private readonly heights: Map<string, number>) {}

  slotAt(list: Message[], index: number): number {
    windowStats.slots += 1;
    const message = list[index];
    if (!message) return ESTIMATE;
    return this.heights.get(message.id) ?? ESTIMATE;
  }

  rebuild(list: Message[], timelineOrder: string): void {
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
  totals(list: Message[], timelineOrder: string): number[] {
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
  indexOf(timeline: Message[], id: string): number {
    const at = this.positions.get(id);
    if (at !== undefined && timeline[at]?.id === id) return at;
    return timeline.findIndex((message) => message.id === id);
  }
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
