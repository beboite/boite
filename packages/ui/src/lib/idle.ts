/**
 * The idle scheduling every lazy module shares. It imports nothing, so a module
 * the first screen holds can wait for idle without reaching the feature chunks
 * `prefetch.ts` fetches ahead.
 */

/**
 * Runs `task` once the page is idle, after the first paint, or after `timeout`
 * ms at the latest. Safari has no requestIdleCallback: it waits `fallback` ms
 * instead. Returns the cancel.
 */
export function whenIdle(task: () => void, { timeout = 1500, fallback = 300 } = {}): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(task, { timeout });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(task, fallback);
  return () => clearTimeout(id);
}
