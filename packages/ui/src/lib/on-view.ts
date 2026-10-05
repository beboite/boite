/**
 * Calls `seen` once, the first time `node` comes within `margin` of the
 * viewport: what a picture or a file a light page left on the core waits for
 * before it is fetched. Without `IntersectionObserver` it is called at once.
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
  }, { rootMargin: margin });
  observer.observe(node);
  return { destroy: () => observer.disconnect() };
}
