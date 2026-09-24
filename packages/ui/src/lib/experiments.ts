/*
 * The experiments this build carries: work that is not finished and may change
 * or go away, turned on per machine from Settings, Experiments. The enabled ids
 * live in `localStorage` under `boite.experiments` as a JSON array of strings,
 * the way the theme lives under `boite.theme` and the window material under
 * `boite.glass`. Nothing here reaches the core, so nothing here belongs in
 * `prefs.ts`: an experiment is a switch on this machine, not a setting the core
 * knows about.
 *
 * Nothing in this module imports a feature it gates. The dependency runs the
 * other way, `theme.ts` asks here whether `theme-grain` is on and subscribes so
 * a switch flipped on the Experiments page repaints without a reload, and the
 * sidebar, the palette and the store ask `experiments.svelte.ts` whether
 * `session-import` is on before showing or running the import, and the
 * context meter asks the same of `prompt-cache` before drawing its timer.
 */

export type ExperimentId = 'theme-grain' | 'session-import' | 'prompt-cache' | 'chat-artifacts' | 'preview-comments';

export const EXPERIMENTS_STORAGE_KEY = 'boite.experiments';

/** Every experiment this build ships, in the order the page lists them. */
export const EXPERIMENT_IDS: ExperimentId[] = ['theme-grain', 'session-import', 'prompt-cache', 'chat-artifacts', 'preview-comments'];

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
