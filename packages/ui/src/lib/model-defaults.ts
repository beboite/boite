import type { ModelInfo } from '@boite/contracts';
import { isNamedModel } from './model-order';

export interface ModelDefault { model: string; effort: string | null }
export type ModelDefaults = Record<string, ModelDefault>;
export const MODEL_DEFAULTS_KEY = 'boite.model-defaults:v1';
export const DEFAULT_MODEL_NAMES: Record<string, string> = {
  'claude-opus-5': 'Opus 5',
  'gpt-5.6-sol': 'GPT 5.6 Sol',
  'grok-4.6': 'Grok 4.6',
  // The names the small title models fall back on before a probe (`TITLE_MODEL_DEFAULTS`).
  'haiku': 'Haiku',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'gpt-6-luna': 'GPT 6 Luna',
  'gpt-5.6-luna': 'GPT 5.6 Luna',
  'gpt-5.4-mini': 'GPT 5.4 mini'
};
export const INITIAL_MODEL_DEFAULTS: ModelDefaults = {
  claude: { model: 'claude-opus-5', effort: 'high' },
  codex: { model: 'gpt-5.6-sol', effort: 'medium' },
  grok: { model: 'grok-4.6', effort: 'high' }
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
