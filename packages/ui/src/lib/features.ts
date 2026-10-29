/*
 * Finished features this device can still switch off: former experiments that
 * graduated. They are on by default and their switches live in the Settings
 * page they belong to, not on the Experiments page. Only explicit choices are
 * stored, in `localStorage` under `boite.features` as a JSON object of ids to
 * booleans, so a feature nobody touched follows its default.
 *
 * Like `experiments.ts`, nothing here reaches the core and nothing here
 * imports a feature it gates.
 *
 * `open-chat-links` is the one that starts off: a click on a file link opens
 * the file's own app instead of Boite's preview, which is a taste, not a fix.
 * A device that turned on its experiment keeps it on: the first read stores
 * that as its choice, since the Experiments page drops ids it no longer lists
 * the next time it saves.
 */

import { EXPERIMENTS_STORAGE_KEY } from './experiments';

export type FeatureId = 'chat-artifacts' | 'preview-comments' | 'open-chat-links' | 'edge-scrollbars';

export const FEATURES_STORAGE_KEY = 'boite.features';

export const FEATURE_IDS: FeatureId[] = ['chat-artifacts', 'preview-comments', 'open-chat-links', 'edge-scrollbars'];

const DEFAULTS: Record<FeatureId, boolean> = { 'chat-artifacts': true, 'preview-comments': true, 'open-chat-links': false, 'edge-scrollbars': true };

/** The experiments this device turned on before they graduated, read from their old array. */
function formerExperiments(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(EXPERIMENTS_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

type Listener = (features: Record<FeatureId, boolean>) => void;

const listeners = new Set<Listener>();

/** Every feature with its state: the stored choice, or its default. Unknown keys are ignored. */
export function readFeatures(): Record<FeatureId, boolean> {
  const state = { ...DEFAULTS };
  const chosen: Partial<Record<FeatureId, boolean>> = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FEATURES_STORAGE_KEY) ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const id of FEATURE_IDS) {
        const value = (parsed as Record<string, unknown>)[id];
        if (typeof value === 'boolean') chosen[id] = value;
      }
    }
  } catch {
    /* unreadable storage keeps the defaults */
  }
  const carried = FEATURE_IDS.filter((id) => !DEFAULTS[id] && chosen[id] === undefined && formerExperiments().includes(id));
  for (const id of carried) chosen[id] = true;
  if (carried.length > 0) {
    try {
      window.localStorage.setItem(FEATURES_STORAGE_KEY, JSON.stringify(chosen));
    } catch {
      /* the old array still says so for this session */
    }
  }
  return { ...state, ...chosen };
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
