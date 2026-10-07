/**
 * Whether the page is hidden, heard once for the whole app. A clock that ticks
 * while a call runs reads it instead of listening on the document itself: a
 * long thread mounts hundreds of calls, each of which hung its own listener
 * and ran it at every switch of tab.
 */
export const page = $state({ hidden: typeof document !== 'undefined' && document.hidden });

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { page.hidden = document.hidden; });
}
