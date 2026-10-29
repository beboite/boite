/*
 * The experiments this build carries: work that is not finished and may change
 * or go away, turned on per machine from Settings, Experiments. The enabled ids
 * live in `localStorage` under `boite.experiments` as a JSON array of strings,
 * the way the theme lives under `boite.theme` and the window material under
 * `boite.glass`. These are client preferences, not core settings. A finished
 * experiment graduates to `features.ts`: on by default, switched in its own
 * Settings page.
 *
 * A phone or a browser follows the desktop app of its primary machine: the
 * core says which experiments that app has on (`client.preferences`,
 * `client.desktopExperiments`), and they are this device's until it flips a
 * switch of its own or turns following off.
 *
 * Nothing in this module imports a feature it gates. The dependency runs the
 * other way, `theme.ts` asks here whether `theme-grain` is on and subscribes so
 * a switch flipped on the Experiments page repaints without a reload, and the
 * sidebar, the palette and the store ask `experiments.svelte.ts` whether
 * `session-import` is on before showing or running the import, and the
 * context meter asks the same of `prompt-cache` before drawing its timer. The
 * bottom-left launchers and the store ask `resident-agents` before offering
 * the dedicated Agents interface. The composer asks `goal2` before taking
 * `/goal2` as a reviewed goal.
 */

import { EXPERIMENT_IDS, type ExperimentId } from '@boite/contracts';

/** Declared in contracts: the app reports which are on, and an agent may ask to flip one (`client.preferences`). */
export { EXPERIMENT_IDS, type ExperimentId };

export const EXPERIMENTS_STORAGE_KEY = 'boite.experiments';
/** `off` once this device keeps its own experiments rather than the desktop app's. */
export const FOLLOW_STORAGE_KEY = 'boite.experiments.follow';
/** The desktop app's experiments as last heard, so a reload starts with them before the hello. */
export const DESKTOP_STORAGE_KEY = 'boite.experiments.desktop';


type Listener = (enabled: ExperimentId[]) => void;

const listeners = new Set<Listener>();

function parse(raw: string | null): ExperimentId[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? EXPERIMENT_IDS.filter((id) => parsed.includes(id)) : null;
  } catch {
    return null;
  }
}

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

function tell(enabled = readExperiments()): void {
  for (const listener of listeners) listener(enabled);
}

/**
 * A phone or a browser follows the desktop app of the machine it is paired
 * with; the desktop app is the one it follows, so it keeps its own.
 */
export function canFollowDesktop(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ === undefined;
}

/** Whether the switches are the desktop app's: true until this device flips one of its own. */
export function followsDesktop(): boolean {
  return canFollowDesktop() && stored(FOLLOW_STORAGE_KEY) !== 'off';
}

/** The desktop app's experiments as last heard, with the core that named them. */
function heard(): { core: string | null; experiments: ExperimentId[] } | null {
  try {
    const parsed = JSON.parse(stored(DESKTOP_STORAGE_KEY) ?? 'null') as { core?: unknown; experiments?: unknown } | null;
    const experiments = parse(JSON.stringify(parsed?.experiments ?? null));
    return experiments === null ? null : { core: typeof parsed?.core === 'string' ? parsed.core : null, experiments };
  } catch {
    return null;
  }
}

/** The desktop app's experiments as last heard, null before any core named them. */
export function desktopExperiments(): ExperimentId[] | null {
  return heard()?.experiments ?? null;
}

/**
 * The ids that are on: the desktop app's while this device follows it and
 * has heard them, else its own. An id nobody ships any more is dropped rather
 * than carried, so an old array left in storage cannot turn on something that
 * no longer exists.
 */
export function readExperiments(): ExperimentId[] {
  const desktop = followsDesktop() ? desktopExperiments() : null;
  return desktop ?? parse(stored(EXPERIMENTS_STORAGE_KEY)) ?? [];
}

export function isExperimentEnabled(id: ExperimentId): boolean {
  return readExperiments().includes(id);
}

/** Stores this device's own set and tells whoever is listening, storage refused or not. */
export function writeExperiments(enabled: ExperimentId[]): void {
  const kept = EXPERIMENT_IDS.filter((id) => enabled.includes(id));
  store(EXPERIMENTS_STORAGE_KEY, JSON.stringify(kept));
  // Storage refused, the set still holds for this session's listeners.
  tell(followsDesktop() && desktopExperiments() !== null ? readExperiments() : kept);
}

/**
 * One switch, on or off: what the Experiments page and a card call. A device
 * that followed the desktop app keeps what it showed, with this flip, as its own.
 */
export function setExperiment(id: ExperimentId, on: boolean): void {
  const enabled = new Set<ExperimentId>(readExperiments());
  if (on) enabled.add(id);
  else enabled.delete(id);
  if (followsDesktop()) store(FOLLOW_STORAGE_KEY, 'off');
  writeExperiments([...enabled]);
}

/** Follow the desktop app again, or keep what is shown as this device's own. */
export function setFollowDesktop(follow: boolean): void {
  if (follow === followsDesktop()) return;
  if (follow) {
    store(FOLLOW_STORAGE_KEY, null);
    tell();
  } else {
    const shown = readExperiments();
    store(FOLLOW_STORAGE_KEY, 'off');
    writeExperiments(shown);
  }
}

let leader: object | null = null;

/** The Store whose machine's desktop app this device follows: the primary one, so a second machine's never takes turns with it. */
export function followDesktopOf(owner: object | null): void {
  leader = owner;
}

/**
 * What a core (`core`, its id) said its desktop app has on
 * (`client.preferences`, `client.desktopExperiments`). Null says nothing yet:
 * the same core keeps the set heard last, through reloads and restarts, but
 * a primary that moved to another machine forgets the previous one's.
 */
export function heardDesktop(owner: object, experiments: readonly ExperimentId[] | null, core: string | null = null): void {
  if (owner !== leader || !canFollowDesktop()) return;
  const last = heard();
  if (experiments === null && (last === null || core === null || last.core === null || last.core === core)) return;
  const before = followsDesktop() ? readExperiments() : null;
  store(DESKTOP_STORAGE_KEY, experiments === null ? null : JSON.stringify({ core, experiments: EXPERIMENT_IDS.filter((id) => experiments.includes(id)) }));
  if (before !== null && before.join() !== readExperiments().join()) tell();
}

/** Runs on every change. Returns the function that drops the listener. */
export function subscribeExperiments(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
