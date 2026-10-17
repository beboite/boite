/**
 * The element `node` scrolls in. The timeline marks itself `data-scroll-root`
 * and is found by a selector, without reading a style; elsewhere the nearest
 * ancestor whose style scrolls. An observer rooted at the page would see the
 * timeline clip the node and ignore the margin: the picture would load only
 * once on screen, not as it nears.
 */
function scroller(node: Element): Element | null {
  const marked = node.closest('[data-scroll-root]');
  if (marked) return marked;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === 'auto' || overflowY === 'scroll') return parent;
  }
  return null;
}

interface Watch {
  observer: IntersectionObserver;
  seen: Map<Element, () => void>;
}

/** One observer per scrolling root and margin, shared by every node in it: a long thread holds hundreds. */
const watches = new Map<Element | null, Map<string, Watch>>();

function watchFor(root: Element | null, margin: string): Watch {
  let byMargin = watches.get(root);
  if (!byMargin) watches.set(root, byMargin = new Map());
  let watch = byMargin.get(margin);
  if (!watch) {
    const seen = new Map<Element, () => void>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) seen.get(entry.target)?.();
    }, { root, rootMargin: margin });
    byMargin.set(margin, watch = { observer, seen });
  }
  return watch;
}

/**
 * Calls `seen` each time `node` comes within `margin` of what its scrolling
 * container shows: what a picture a light page left on the core waits for
 * before it is fetched, and again on the way back to one whose fetch failed.
 * The caller ignores the calls it no longer needs. Without
 * `IntersectionObserver` it is called once, at once.
 */
export function onView(node: Element, seen: () => void, margin = '400px'): { destroy(): void } {
  if (typeof IntersectionObserver === 'undefined') {
    seen();
    return { destroy() {} };
  }
  const root = scroller(node);
  const watch = watchFor(root, margin);
  watch.seen.set(node, () => seen());
  watch.observer.observe(node);
  return {
    destroy: () => {
      watch.observer.unobserve(node);
      watch.seen.delete(node);
      if (watch.seen.size > 0) return;
      watch.observer.disconnect();
      const byMargin = watches.get(root);
      byMargin?.delete(margin);
      if (byMargin?.size === 0) watches.delete(root);
    }
  };
}
