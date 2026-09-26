/**
 * The idle prefetch of the chunks the first screen does not draw (App.svelte).
 * Each chunk still loads the moment it is asked for; this only decides what is
 * fetched ahead, and when.
 */

interface Link {
  saveData?: boolean;
  effectiveType?: string;
}

/** A data saver or a slow link keeps its bytes for what the user opens. */
export function prefetchAllowed(link = (globalThis.navigator as (Navigator & { connection?: Link }) | undefined)?.connection): boolean {
  if (!link) return true;
  if (link.saveData) return false;
  return !['slow-2g', '2g', '3g'].includes(link.effectiveType ?? '');
}

/**
 * What is worth fetching ahead: the tour only for a device that has not seen
 * it, the terminal only for the owner, since a paired device cannot open one.
 */
export function prefetchNames<Name extends string>(names: Name[], device: { tourSeen: boolean; owner: boolean }): Name[] {
  return names.filter((name) => !(name === 'Onboarding' && device.tourSeen) && !(name === 'TerminalDrawer' && !device.owner));
}

/** Runs `task` once the page is idle, after the first paint. Safari has no requestIdleCallback. Returns the cancel. */
export function whenIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(task, { timeout: 1500 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(task, 300);
  return () => clearTimeout(id);
}
