/**
 * Which slice of a long timeline is worth a DOM node.
 *
 * A thread of two thousand items is two thousand cards, and a card is a border,
 * a heading and a `<pre>`; mounting all of them costs a second of layout on
 * open and makes every delta a reflow of the whole column. The list keeps a
 * measured height per row and draws the rows the viewport can actually see,
 * with a spacer standing in for the ones above and below.
 *
 * Heights are measured rather than assumed because these rows are not uniform:
 * a `notice` is one line and a tool card with the tail of its output is thirty.
 * A row that has never been on screen has no measurement, so it counts as
 * [`ESTIMATE`] until it has been drawn once, which is what keeps the scrollbar
 * roughly honest before anything has been scrolled.
 *
 * Pure, so the arithmetic is a test rather than a scroll.
 */

/** What an unmeasured row is worth. Roughly a two-line assistant paragraph. */
export const ESTIMATE = 72;

/**
 * Rows drawn past each edge of the viewport.
 *
 * Not zero: a fast scroll paints before the next frame has decided anything,
 * and the band is what keeps that from showing blank. Not large either, since
 * every extra row is a card mounted for nothing.
 */
export const OVERSCAN = 6;

export interface Window {
  /** First row to draw, inclusive. */
  start: number;
  /** Last row to draw, exclusive. */
  end: number;
  /** Pixels the spacer above stands in for. */
  before: number;
  /** Pixels the spacer below stands in for. */
  after: number;
  /** Every row's height, which is what the scrollbar is made of. */
  total: number;
}

/**
 * The rows covering `[scrollTop, scrollTop + viewport]`, plus the overscan.
 *
 * One pass over the heights rather than a prefix array rebuilt per frame: the
 * array is rewritten every time a row is measured, and a thread that is being
 * streamed into measures a row a frame.
 */
export function windowFor(
  heights: readonly number[],
  scrollTop: number,
  viewport: number,
): Window {
  const count = heights.length;
  if (count === 0) return { start: 0, end: 0, before: 0, after: 0, total: 0 };

  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewport);

  let offset = 0;
  let start = count;
  let end = count;
  let before = 0;
  for (let i = 0; i < count; i++) {
    const height = heights[i] > 0 ? heights[i] : ESTIMATE;
    const rowBottom = offset + height;
    if (start === count && rowBottom > top) {
      start = i;
      before = offset;
    }
    if (start !== count && offset >= bottom) {
      end = i;
      break;
    }
    offset = rowBottom;
  }
  if (start === count) {
    // Scrolled past everything, which a shrinking list can produce between two
    // frames. The tail is the honest answer, never an empty window.
    start = Math.max(0, count - 1);
  }
  if (end === count && start !== count) end = count;

  const padded = Math.max(0, start - OVERSCAN);
  const paddedEnd = Math.min(count, end + OVERSCAN);
  for (let i = padded; i < start; i++) before -= heights[i] > 0 ? heights[i] : ESTIMATE;

  let total = 0;
  for (let i = 0; i < count; i++) total += heights[i] > 0 ? heights[i] : ESTIMATE;
  let drawn = 0;
  for (let i = padded; i < paddedEnd; i++) drawn += heights[i] > 0 ? heights[i] : ESTIMATE;

  return {
    start: padded,
    end: paddedEnd,
    before: Math.max(0, before),
    after: Math.max(0, total - Math.max(0, before) - drawn),
    total,
  };
}

/**
 * Whether the list should follow the bottom.
 *
 * The rule is the user's, not the stream's: a timeline that jumped to the
 * bottom while somebody was reading three turns up would make a long thread
 * unreadable for as long as the agent is talking. Within this many pixels of
 * the end counts as being at the end, because a scroll container rounds and a
 * zoomed page rounds differently.
 */
export const STICK_SLACK = 48;

export function atBottom(scrollTop: number, viewport: number, total: number): boolean {
  return scrollTop + viewport >= total - STICK_SLACK;
}
