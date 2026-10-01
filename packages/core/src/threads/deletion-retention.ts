import type { Core } from '../core.ts';

/** Catch up at startup and check once a minute while the core stays resident. */
export function scheduleThreadDeletionRetention(core: Core): () => void {
  const pass = () => {
    try { core.threads.purgeDeleted(); }
    catch (error) { core.log('error', `thread deletion retention: ${error instanceof Error ? error.message : String(error)}`); }
  };
  pass();
  const timer = setInterval(pass, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
