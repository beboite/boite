/**
 * Whether a scroll the app makes itself may glide. The system's reduced motion
 * setting says no, and so does `html[data-motion='reduced']`, which the tests
 * set because jsdom has no media queries.
 */
export function glides(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset['motion'] === 'reduced') return false;
  return typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches;
}
