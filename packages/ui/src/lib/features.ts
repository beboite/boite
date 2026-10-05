/*
 * Finished features this device can still switch off: former experiments that
 * graduated. They are on by default and their switches live in the Settings
 * page they belong to, not on the Experiments page. Only explicit choices are
 * stored, in `localStorage` under `boite.features` as a JSON object of ids to
 * booleans, so a feature nobody touched follows its default.
 *
 * Like `experiments.ts`, nothing here reaches the core and nothing here
 * imports a feature it gates. Agent browser control still registers a
 * revocable owner grant with the core while the desktop hosts a conversation;
 * `browser-host.ts` subscribes here to withdraw it when the switch goes off.
 */

export type FeatureId = 'chat-artifacts' | 'agent-browser-control';

export const FEATURES_STORAGE_KEY = 'boite.features';

export const FEATURE_IDS: FeatureId[] = ['chat-artifacts', 'agent-browser-control'];

const DEFAULTS: Record<FeatureId, boolean> = { 'chat-artifacts': true, 'agent-browser-control': true };

type Listener = (features: Record<FeatureId, boolean>) => void;

const listeners = new Set<Listener>();

/** Every feature with its state: the stored choice, or its default. Unknown keys are ignored. */
export function readFeatures(): Record<FeatureId, boolean> {
  const state = { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FEATURES_STORAGE_KEY) ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const id of FEATURE_IDS) {
        const value = (parsed as Record<string, unknown>)[id];
        if (typeof value === 'boolean') state[id] = value;
      }
    }
  } catch {
    /* unreadable storage keeps the defaults */
  }
  return state;
}

export function isFeatureEnabled(id: FeatureId): boolean {
  return readFeatures()[id];
}

/** Stores one choice and tells whoever is listening, storage refused or not. */
export function setFeature(id: FeatureId, on: boolean): void {
  const state = { ...readFeatures(), [id]: on };
  try {
    window.localStorage.setItem(FEATURES_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
  for (const listener of listeners) listener(state);
}

/** Forgets every choice: each feature goes back to its default. */
export function resetFeatures(): void {
  try {
    window.localStorage.removeItem(FEATURES_STORAGE_KEY);
  } catch {
    /* nothing stored to forget */
  }
  const state = readFeatures();
  for (const listener of listeners) listener(state);
}

/** Runs on every change. Returns the function that drops the listener. */
export function subscribeFeatures(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
