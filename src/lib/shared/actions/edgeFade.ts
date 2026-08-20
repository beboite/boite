/**
 * Says a horizontal strip runs past its own edge.
 *
 * The strips that scroll sideways — the editor tab strip, the shortcut bar, the
 * mobile key row, the settings tabs — all wear `hide-scrollbar`, because a 10px
 * bar inside a 32px strip eats a third of it. That trade left them with no
 * overflow affordance at all: a tab one pixel off the right edge looks exactly
 * like the last tab.
 *
 * This writes `--fade-start` and `--fade-end` (0 or 1) onto the node, and the
 * `edge-fade` utility in `app.css` turns them into a mask. Two custom
 * properties rather than a class per side so the CSS stays one declaration, and
 * so a strip that scrolls in both directions fades both ends at once.
 *
 * Not a scroll-driven CSS animation: `animation-timeline: scroll()` would do
 * this with no JS at all and is not in every engine the app is shipped on, and
 * a strip whose only affordance silently does nothing on one host is worse than
 * a listener.
 */

// Below this the strip is at its end for all practical purposes: a sub-pixel
// remainder from a fractional layout is not content to reach.
const EPSILON = 1;

export function edgeFade(node: HTMLElement) {
  let frame = 0;

  function measure() {
    frame = 0;
    const max = node.scrollWidth - node.clientWidth;
    // Nothing to scroll: both ends off, rather than a mask that fades a strip
    // which is entirely on screen.
    const overflows = max > EPSILON;
    const left = overflows && node.scrollLeft > EPSILON;
    const right = overflows && node.scrollLeft < max - EPSILON;
    node.style.setProperty("--fade-start", left ? "1" : "0");
    node.style.setProperty("--fade-end", right ? "1" : "0");
  }

  // A scroll fires per wheel notch and a resize per drag frame, and the read is
  // a forced layout either way, so both land on the next frame instead.
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(measure);
  }

  node.addEventListener("scroll", schedule, { passive: true });

  // Covers both a strip that changed size and a strip that gained or lost an
  // item: a tab opening changes scrollWidth with no scroll and no resize of the
  // strip itself, which is why the children are watched too.
  const resize = new ResizeObserver(schedule);
  resize.observe(node);
  const children = new MutationObserver(schedule);
  children.observe(node, { childList: true, subtree: true });

  measure();

  return {
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      node.removeEventListener("scroll", schedule);
      resize.disconnect();
      children.disconnect();
    },
  };
}
