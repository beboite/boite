import type { ModelInfo } from '@boite/contracts';

export interface FavoriteModel { providerId: string; accountId: string; model: ModelInfo }
export const FAVORITES_KEY = 'boite.model-favorites.v1';
export function isNamedModel(model: ModelInfo): boolean {
  return !/^(default|auto)(?:\b|[\[(/])/i.test(model.id) && !/\b(default|auto)(?:\b|$)/i.test(model.name);
}
/** Quality tiers, then numeric generation. Unknown families retain provider order. */
export function orderedModels(models: ModelInfo[]): ModelInfo[] {
  const tier = (m: ModelInfo) => /mini|nano|lite|flash|haiku/i.test(m.name) ? 0 : /astra|fable/i.test(m.name) ? 4
    : /opus|ultra|\bpro\b/i.test(m.name) ? 3 : /grok|gpt/i.test(m.name) ? 2 : 1;
  const version = (m: ModelInfo) => { const n = m.name.match(/\d+/g) ?? []; return Number(n[0] ?? 0) * 100 + Number(n[1] ?? 0); };
  return models.filter(isNamedModel).map((model, index) => ({ model, index })).sort((a, b) =>
    Number(!!a.model.legacy) - Number(!!b.model.legacy) || tier(b.model) - tier(a.model) ||
    version(b.model) - version(a.model) || a.index - b.index
  ).map(({ model }) => model);
}
export function readFavorites(): FavoriteModel[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is FavoriteModel => typeof v?.providerId === 'string' &&
      typeof v?.accountId === 'string' && typeof v?.model?.id === 'string' &&
      typeof v?.model?.name === 'string' && isNamedModel(v.model));
  } catch { return []; }
}
