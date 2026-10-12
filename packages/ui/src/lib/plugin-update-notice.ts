import type { PluginState } from '@boite/contracts';

/**
 * The plugin updates the owner already answered, kept per machine and plugin:
 * `machineId:pluginId` → the version offered. Either answer counts, so a
 * notice shows once per version and "Later" holds until a newer one.
 */
export const PLUGIN_UPDATE_ANSWERS_KEY = 'boite.plugin-update-dismissed';

/** Plenty for every plugin of every machine; an older answer beyond it is forgotten first. */
const KEPT = 50;

export type PluginUpdateAnswers = Record<string, string>;

export function readPluginUpdateAnswers(): PluginUpdateAnswers {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(PLUGIN_UPDATE_ANSWERS_KEY) ?? '{}');
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

/** Records the answer and returns the answers with it; storage that fails keeps it for this session. */
export function answerPluginUpdate(answers: PluginUpdateAnswers, key: string, version: string): PluginUpdateAnswers {
  const rest = Object.entries(answers).filter(([other]) => other !== key);
  const next = Object.fromEntries([...rest.slice(-(KEPT - 1)), [key, version]]);
  try { window.localStorage.setItem(PLUGIN_UPDATE_ANSWERS_KEY, JSON.stringify(next)); }
  catch { /* Kept in memory until the next launch. */ }
  return next;
}

/** The version to offer for an installed plugin, null when there is none or the owner answered it. */
export function pluginUpdateOffer(plugin: PluginState, answers: PluginUpdateAnswers, key: string): string | null {
  const version = plugin.status === 'installed' ? plugin.updates?.available?.version : undefined;
  return version !== undefined && answers[key] !== version ? version : null;
}
