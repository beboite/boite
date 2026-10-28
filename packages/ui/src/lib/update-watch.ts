import { appUpdater } from './app-update.svelte';
import type { Store } from './store.svelte';
import { freshenUpdates } from './update-freshness';

/**
 * This window's update checks: the app's updater once the first frame is
 * drawn, so the check never delays it, and every stale reading checked again
 * each time the window is shown or focused, from the tray included.
 * Returns the way to stop.
 */
export function watchUpdates(stores: () => readonly Store[]): () => void {
  let stopAppUpdater: () => void = () => undefined;
  let delay: number | undefined;
  const start = () => { delay = window.setTimeout(() => { stopAppUpdater = appUpdater.start(); }, 0); };
  const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(start) : undefined;
  if (frame === undefined) start();
  const freshen = () => { if (!document.hidden) freshenUpdates(stores(), appUpdater); };
  document.addEventListener('visibilitychange', freshen);
  window.addEventListener('focus', freshen);
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (delay !== undefined) clearTimeout(delay);
    stopAppUpdater();
    document.removeEventListener('visibilitychange', freshen);
    window.removeEventListener('focus', freshen);
  };
}
