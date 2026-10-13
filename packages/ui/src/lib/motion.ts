/**
 * Whether a scroll the app makes itself may glide. The system's reduced motion
 * setting says no, and so does `html[data-motion='reduced']`, which the tests
 * set because jsdom has no media queries.
 */
export function glides(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset['motion'] === 'reduced') return false;
  return typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Slides an element that a layout change just moved from the top it had
 * before, over `--dur-3`. Nothing moves under reduced motion or for less than
 * a pixel.
 */
export function slideFrom(element: HTMLElement, top: number): void {
  const delta = top - element.getBoundingClientRect().top;
  if (Math.abs(delta) < 1 || !glides() || typeof element.animate !== 'function') return;
  const style = getComputedStyle(element);
  const token = style.getPropertyValue('--dur-3').trim();
  const duration = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000) || 0;
  element.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration, easing: style.getPropertyValue('--ease-out-quint').trim() || 'ease-out' });
}
