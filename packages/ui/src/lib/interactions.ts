/*
 * The two pointer interactions, started by main.ts beside the app window.
 * `press-preload` always runs; `edge-scrollbars` loads its module while its
 * switch is on (features.ts) and runs its stop when the switch goes off.
 * Nothing here is imported until the app has mounted, and the scrollbars'
 * module does not load while its switch is off.
 */

import { readFeatures, subscribeFeatures, type FeatureId } from './features';
import { workspace } from './workspace.svelte';

const switched = {
  'edge-scrollbars': async () => (await import('./edge-scrollbars')).startEdgeScrollbars()
} satisfies Partial<Record<FeatureId, () => Promise<() => void>>>;

type Interaction = keyof typeof switched;

function report(error: unknown): void {
  workspace.active.error = error instanceof Error ? error.message : String(error);
}

export function startInteractions(): () => void {
  const running = new Map<Interaction, { stop?: () => void; left: boolean }>();
  const sync = (features: Partial<Record<FeatureId, boolean>>) => {
    for (const id of Object.keys(switched) as Interaction[]) {
      const run = running.get(id);
      if (features[id] && !run) {
        const started: { stop?: () => void; left: boolean } = { left: false };
        running.set(id, started);
        void switched[id]()
          .then((stop) => { if (started.left) stop(); else started.stop = stop; })
          .catch((error: unknown) => {
            // A chunk that failed to load is tried again the next time the switch
            // turns on; a failure the switch already left behind says nothing.
            if (running.get(id) !== started) return;
            running.delete(id);
            report(error);
          });
      } else if (!features[id] && run) {
        run.left = true;
        run.stop?.();
        running.delete(id);
      }
    }
  };
  let left = false;
  let stopPreload: (() => void) | undefined;
  void import('./press-preload')
    .then(({ startPressPreload }) => { const stop = startPressPreload(workspace); if (left) stop(); else stopPreload = stop; })
    .catch(report);
  sync(readFeatures());
  const unsubscribe = subscribeFeatures(sync);
  return () => {
    left = true;
    stopPreload?.();
    unsubscribe();
    sync({});
  };
}
