/**
 * The nearest ancestor of `node` that scrolls. An observer rooted at the page
 * would see the timeline clip the node and ignore the margin: the picture
 * would load only once on screen, not as it nears.
 */
function scroller(node: Element): Element | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === 'auto' || overflowY === 'scroll') return parent;
  }
  return null;
}

/**
 * Calls `seen` once, the first time `node` comes within `margin` of what its
 * scrolling container shows: what a picture a light page left on the core
 * waits for before it is fetched. Without `IntersectionObserver` it is called
 * at once.
 */
export function onView(node: Element, seen: () => void, margin = '400px'): { destroy(): void } {
  if (typeof IntersectionObserver === 'undefined') {
    seen();
    return { destroy() {} };
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    seen();
  }, { root: scroller(node), rootMargin: margin });
  observer.observe(node);
  return { destroy: () => observer.disconnect() };
}
