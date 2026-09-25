import type { AccountId, ModelInfo, Protocol, ProviderDescriptor } from '@boite/contracts';
import { probedModelsOf } from '../drivers/index.ts';
import { refused } from '../errors.ts';

/** The protocols whose models come from the agent, not from the descriptor. */
const PROBED_PROTOCOLS: readonly Protocol[] = ['acp', 'codex-appserver', 'muse', 'pi', 'agy'];

/**
 * What this account may run: the descriptor's models, plus the ones the last
 * probe read from the agent for a provider that owns its own list. Nothing is
 * probed here; a model the agent could list but nobody asked for is not offered
 * yet.
 */
function modelsFor(provider: ProviderDescriptor, accountId: AccountId): ModelInfo[] {
  const probed = probedModelsOf(provider.protocol, provider.id, accountId);
  if (probed === null) return provider.models;
  const known = new Set(probed.map((model) => model.id));
  return [...probed, ...provider.models.filter((model) => !known.has(model.id))];
}

/**
 * Null is always allowed and means the provider's own default. Anything else
 * must be a model the descriptor lists or one the last probe read.
 */
export function checkModel(provider: ProviderDescriptor, accountId: AccountId, model: string | null): string | null {
  if (model === null) return null;
  const models = modelsFor(provider, accountId);
  if (models.some((entry) => entry.id === model)) return model;
  throw refused(
    PROBED_PROTOCOLS.includes(provider.protocol)
      ? 'the agent has not listed this model: open the model picker so Boite reads its models first'
      : 'the provider does not offer this model',
    { providerId: provider.id, accountId, model, expected: models.map((entry) => entry.id) },
  );
}

/**
 * Null is always allowed and means the model's own default. Anything else must
 * be one of the levels that model lists, from the descriptor or from the probe,
 * or the call is refused.
 */
export function checkEffort(
  provider: ProviderDescriptor,
  accountId: AccountId,
  model: string | null,
  effort: string | null,
): string | null {
  if (effort === null) return null;
  const levels = modelsFor(provider, accountId).find((entry) => entry.id === model)?.effort?.levels ?? [];
  if (levels.some((level) => level.id === effort)) return effort;
  throw refused('the model does not offer this reasoning effort', {
    providerId: provider.id,
    model,
    effort,
    expected: levels.length === 0 ? 'null: this model has no effort levels' : levels.map((level) => level.id),
  });
}

/**
 * The effort a thread already carries was checked when it was chosen. A probed
 * scale lives in memory, so after a core restart it may not be read yet: only a
 * scale that is known and lacks the level refuses the turn.
 */
export function checkStoredEffort(
  provider: ProviderDescriptor,
  accountId: AccountId,
  model: string | null,
  effort: string | null,
): void {
  if (effort === null) return;
  const known = modelsFor(provider, accountId).find((entry) => entry.id === model)?.effort;
  if (known === undefined) return;
  checkEffort(provider, accountId, model, effort);
}

export function defaultModel(provider: ProviderDescriptor): string | null {
  const preferred = provider.models.find((model) => model.default === true);
  if (preferred !== undefined) return preferred.id;
  return provider.models[0]?.id ?? null;
}

export function checkSpeed(provider: ProviderDescriptor, accountId: string, model: string | null, speed: string | null): string | null {
  if (speed === null) return null;
  const options = modelsFor(provider, accountId).find(entry => entry.id === model)?.speeds ?? [];
  if (options.some(option => option.id === speed)) return speed;
  throw refused('the model does not offer this speed', { providerId: provider.id, model, speed, expected: options.map(option => option.id) });
}
