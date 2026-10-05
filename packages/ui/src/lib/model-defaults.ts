import type { ModelInfo } from '@boite/contracts';
import { isNamedModel } from './model-order';

export interface ModelDefault { model: string; effort: string | null }
export type ModelDefaults = Record<string, ModelDefault>;
export const MODEL_DEFAULTS_KEY = 'boite.model-defaults:v1';
const level = (id: string, label: string) => ({ id, label });
const LOW_TO_XHIGH = [level('low', 'Low'), level('medium', 'Medium'), level('high', 'High'), level('xhigh', 'Extra high')];

/**
 * The model each provider starts on before the user picks one, with the
 * effort scale its agent reported. The composer shows this scale until the
 * account's catalog is read, so a new thread offers reasoning levels at once;
 * the catalog's own entry replaces it as soon as it arrives.
 */
export const BUILT_IN_MODELS: Readonly<Record<string, ModelInfo>> = {
  claude: { id: 'claude-opus-5-5', name: 'Opus 5.5', effort: { default: 'high', levels: [...LOW_TO_XHIGH, level('max', 'Max'),
    { ...level('ultrathink', 'Ultrathink'), description: 'Extended thinking, asked for in the prompt' }] } },
  codex: { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', effort: { default: 'medium', levels: [...LOW_TO_XHIGH, level('max', 'Max'), level('ultra', 'Ultra')] } },
  grok: { id: 'grok-4.7', name: 'Grok 4.7', effort: { default: 'high', levels: LOW_TO_XHIGH } }
};
export const INITIAL_MODEL_DEFAULTS: ModelDefaults = Object.fromEntries(Object.entries(BUILT_IN_MODELS)
  .map(([providerId, model]) => [providerId, { model: model.id, effort: model.effort?.default ?? null }]));
export const DEFAULT_MODEL_NAMES: Record<string, string> = {
  ...Object.fromEntries(Object.values(BUILT_IN_MODELS).map((model) => [model.id, model.name])),
  // The small models titles are written with by default (`TITLE_MODEL_DEFAULTS`).
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'gpt-6-luna': 'GPT 6 Luna',
  'gpt-5.6-luna': 'GPT 5.6 Luna',
  'gpt-5.4-mini': 'GPT 5.4 mini'
};

export function readModelDefaults(): ModelDefaults {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(MODEL_DEFAULTS_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, value]) =>
      value && typeof value === 'object' && typeof value.model === 'string' &&
      isNamedModel({ id: value.model, name: value.model }) &&
      (value.effort === null || typeof value.effort === 'string')));
  } catch { return {}; }
}

export function writeModelDefaults(defaults: ModelDefaults): void {
  try { localStorage.setItem(MODEL_DEFAULTS_KEY, JSON.stringify(defaults)); }
  catch { /* Keep the preference for this session when storage is unavailable. */ }
}

/** Only choose ids the account's descriptor or probe actually offers. */
export function resolveModelDefault(providerId: string, models: ModelInfo[], defaults: ModelDefaults): ModelDefault | null {
  const preferred = defaults[providerId] ?? INITIAL_MODEL_DEFAULTS[providerId];
  const model = models.find((m) => m.id === preferred?.model) ??
    models.find((m) => m.default) ?? models.find((m) => !m.legacy) ?? models[0];
  if (!model) return null;
  const effort = model.id === preferred?.model ? preferred.effort : model.effort?.default;
  return { model: model.id, effort: model.effort?.levels.some((level) => level.id === effort)
    ? effort ?? null : model.effort?.default ?? null };
}

/**
 * What replaces a built-in default the account's catalog does not list: a
 * later revision of the same model (`claude-opus-5-5` to
 * `claude-opus-5-5-20261101`), else the catalog's own default, its first
 * current model, its first model.
 * A default the user configured is never replaced this way.
 */
export function fallbackModelDefault(providerId: string, models: ModelInfo[]): ModelDefault | null {
  const named = models.filter(isNamedModel);
  const builtIn = INITIAL_MODEL_DEFAULTS[providerId];
  const model = named.find((m) => m.id === builtIn?.model) ??
    named.find((m) => builtIn && m.id.startsWith(`${builtIn.model}-`)) ??
    named.find((m) => m.default) ?? named.find((m) => !m.legacy) ?? named[0];
  if (!model) return null;
  return { model: model.id, effort: model.effort?.levels.some((level) => level.id === builtIn?.effort)
    ? builtIn!.effort : model.effort?.default ?? null };
}
