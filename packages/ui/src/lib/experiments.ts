/*
 * The experiments this build carries: work that is not finished and may change
 * or go away, turned on per machine from Settings, Experiments. The enabled ids
 * live in `localStorage` under `boite.experiments` as a JSON array of strings,
 * the way the theme lives under `boite.theme` and the window material under
 * `boite.glass`. These are client preferences, not core settings. A finished
 * experiment graduates to `features.ts`: on by default, switched in its own
 * Settings page.
 *
 * Nothing in this module imports a feature it gates. The dependency runs the
 * other way, `theme.ts` asks here whether `theme-grain` is on and subscribes so
 * a switch flipped on the Experiments page repaints without a reload, and the
 * sidebar, the palette and the store ask `experiments.svelte.ts` whether
 * `session-import` is on before showing or running the import, and the
 * context meter asks the same of `prompt-cache` before drawing its timer. The
 * bottom-left launchers and the store ask `resident-agents` before offering
 * the dedicated Agents interface. The composer asks `goal2` before taking
 * `/goal2` as a reviewed goal. `interaction-experiments.ts` starts
 * `edge-scrollbars.ts` and `press-preload.ts` while their switches are on.
 */

import { EXPERIMENT_IDS, type ExperimentId } from '@boite/contracts';

/** Declared in contracts: the app reports which are on, and an agent may ask to flip one (`client.preferences`). */
export { EXPERIMENT_IDS, type ExperimentId };

export const EXPERIMENTS_STORAGE_KEY = 'boite.experiments';


type Listener = (enabled: ExperimentId[]) => void;

const listeners = new Set<Listener>();

/**
 * The ids that are on. An id nobody ships any more is dropped rather than
 * carried, so an old array left in storage cannot turn on something that no
 * longer exists.
 */
export function readExperiments(): ExperimentId[] {
  try {
    const raw = window.localStorage.getItem(EXPERIMENTS_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return EXPERIMENT_IDS.filter((id) => parsed.includes(id));
  } catch {
    return [];
  }
}

export function isExperimentEnabled(id: ExperimentId): boolean {
  return readExperiments().includes(id);
}

/** Stores the set and tells whoever is listening, storage refused or not. */
export function writeExperiments(enabled: ExperimentId[]): void {
  const kept = EXPERIMENT_IDS.filter((id) => enabled.includes(id));
  try {
    window.localStorage.setItem(EXPERIMENTS_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
  for (const listener of listeners) listener(kept);
}

/** One switch, on or off: what the Experiments page calls. */
export function setExperiment(id: ExperimentId, on: boolean): void {
  const enabled = new Set<ExperimentId>(readExperiments());
  if (on) enabled.add(id);
  else enabled.delete(id);
  writeExperiments([...enabled]);
}

/** Runs on every change. Returns the function that drops the listener. */
export function subscribeExperiments(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
