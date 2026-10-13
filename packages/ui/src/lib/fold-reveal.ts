/**
 * A fold opened near the bottom of a scrolled list grows below the visible
 * edge, and with the list anchored at its end the user sees nothing happen.
 * This follows the opening frame by frame: the list scrolls by what the fold
 * pushed past the bottom edge, and stops when the fold's header reaches the
 * top, so a fold longer than the list still starts at its header. A wheel or
 * a touch on the list hands it back to the user at once.
 */

/** Room kept above the header when it rises to the top. */
const MARGIN = 6;
/** Longer than the fold's own transition, for rows that load at the first opening. */
const FOLLOW_MS = 700;

/** The element that scrolls `node`, the nearest ancestor whose content may overflow vertically. */
export function scrollerOf(node: Element): HTMLElement | null {
  for (let element = node.parentElement; element; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return element;
  }
  return null;
}

/** How far to scroll so `section` shows more of itself without its top leaving `scroller`. */
export function revealDelta(section: DOMRect, scroller: DOMRect, paddingBottom = 0): number {
  const below = section.bottom - (scroller.bottom - paddingBottom);
  const room = section.top - scroller.top - MARGIN;
  return Math.max(0, Math.min(below, room));
}

/** Follows the fold of `header` (its parent section) while it opens. Returns a function that stops early. */
export function revealFold(header: Element, follow = FOLLOW_MS): () => void {
  const section = header.parentElement;
  const scroller = scrollerOf(header);
  if (!section || !scroller || typeof requestAnimationFrame !== 'function') return () => {};
  const until = performance.now() + follow;
  const padding = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    scroller.removeEventListener('wheel', stop);
    scroller.removeEventListener('touchstart', stop);
  };
  scroller.addEventListener('wheel', stop, { passive: true });
  scroller.addEventListener('touchstart', stop, { passive: true });
  const step = (time: number) => {
    if (!section.isConnected || !scroller.isConnected) return stop();
    const delta = revealDelta(section.getBoundingClientRect(), scroller.getBoundingClientRect(), padding);
    // Instant: a list with smooth scrolling would otherwise trail the fold it follows.
    if (delta >= 1) scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: 'instant' });
    if (time < until) frame = requestAnimationFrame(step);
    else stop();
  };
  frame = requestAnimationFrame(step);
  return stop;
}
