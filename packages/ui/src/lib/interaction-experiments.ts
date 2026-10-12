/*
 * The two interaction experiments, started by main.ts beside the app window:
 * `edge-scrollbars` and `press-preload` each load their module while their
 * switch is on (experiments.ts) and run its stop when the switch goes off.
 * Nothing here is imported until the app has mounted, and neither module
 * loads while its switch is off.
 */

import { readExperiments, subscribeExperiments, type ExperimentId } from './experiments';
import { workspace } from './workspace.svelte';

const modules = {
  'edge-scrollbars': async () => (await import('./edge-scrollbars')).startEdgeScrollbars(),
  'press-preload': async () => (await import('./press-preload')).startPressPreload(workspace)
} satisfies Partial<Record<ExperimentId, () => Promise<() => void>>>;

type Interaction = keyof typeof modules;

export function startInteractionExperiments(): () => void {
  const running = new Map<Interaction, { stop?: () => void; left: boolean }>();
  const sync = (enabled: ExperimentId[]) => {
    for (const id of Object.keys(modules) as Interaction[]) {
      const run = running.get(id);
      if (enabled.includes(id) && !run) {
        const started: { stop?: () => void; left: boolean } = { left: false };
        running.set(id, started);
        void modules[id]()
          .then((stop) => { if (started.left) stop(); else started.stop = stop; })
          .catch((error: unknown) => { workspace.active.error = error instanceof Error ? error.message : String(error); });
      } else if (!enabled.includes(id) && run) {
        run.left = true;
        run.stop?.();
        running.delete(id);
      }
    }
  };
  sync(readExperiments());
  const unsubscribe = subscribeExperiments(sync);
  return () => {
    unsubscribe();
    sync([]);
  };
}
