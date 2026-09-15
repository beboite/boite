import type { ModelInfo } from '@boite/contracts';

export interface ModelDefault { model: string; effort: string | null }
export type ModelDefaults = Record<string, ModelDefault>;
export const MODEL_DEFAULTS_KEY = 'boite.model-defaults:v1';
export const DEFAULT_MODEL_NAMES: Record<string, string> = {
  'claude-opus-5': 'Claude Opus 5',
  'gpt-5.6-sol': 'GPT 5.6 Sol',
  'grok-4.6': 'Grok 4.6'
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
