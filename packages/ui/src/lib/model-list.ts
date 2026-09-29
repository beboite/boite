import type { ModelInfo } from '@boite/contracts';
import type { FavoriteModel } from './model-order';

/**
 * Rows the model column draws before its show-all row while nothing is typed.
 * An ACP agent can list hundreds (OpenCode answered 534), each row a button, a
 * favorite button and an icon; typing narrows the list, so a query shows all.
 */
export const FIRST_MODELS = 60;

export interface ModelGroup {
  /** The part of the id before the first slash, empty for a model that has none. */
  key: string;
  models: ModelInfo[];
}

/** One label per prefix, the groups in the order the agent first mentioned each. */
export function groupModels(models: ModelInfo[]): ModelGroup[] {
  const byKey = new Map<string, ModelGroup>();
  for (const model of models) {
    const slash = model.id.indexOf('/');
    const key = slash > 0 ? model.id.slice(0, slash) : '';
    const group = byKey.get(key);
    if (group) group.models.push(model);
    else byKey.set(key, { key, models: [model] });
  }
  return [...byKey.values()];
}

/** The first rows of a long list, plus the current model wherever it sits. */
export function firstModels(models: ModelInfo[], current: (model: ModelInfo) => boolean): ModelInfo[] {
  if (models.length <= FIRST_MODELS) return models;
  const first = models.slice(0, FIRST_MODELS);
  const chosen = models.slice(FIRST_MODELS).find(current);
  return chosen ? [...first, chosen] : first;
}

/** The favorite model ids of one provider account, read once per list instead of once per row. */
export function favoriteIds(favorites: FavoriteModel[], providerId: string | undefined, accountId: string | null | undefined): Set<string> {
  return new Set(favorites.filter((f) => f.providerId === providerId && f.accountId === accountId).map((f) => f.model.id));
}
