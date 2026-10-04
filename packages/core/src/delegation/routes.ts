/**
 * Which harness, account, model and reasoning level a delegated child runs on.
 * An agent names a model (`codex/gpt-5.5`, `gpt-5.5`, `opus`) and a level;
 * Boite picks the account: the parent's for its own provider, else that
 * provider's usable login. A child never gets a fast service tier.
 */
import { CONVERSATION_PROFILE_ID } from '@boite/contracts';
import type { Account, DelegationConfig, DelegationModelChoice, DelegationModels, DelegationProfile, ProviderId, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused } from '../errors.ts';
import { probedModelsOf } from '../drivers/index.ts';
import { checkEffort, modelsFor, PROBED_PROTOCOLS } from '../threads/selection.ts';
import type { ProviderProbe } from '../providers/probe.ts';

/** A profile, or a conversation's own route, whose model may be the provider's default. */
export type ChildRoute = Omit<DelegationProfile, 'model'> & { model: string | null };

export interface RouteRequest {
  profileId?: string | null;
  model?: string;
  effort?: string;
}

const PROBE_TIMEOUT_MS = 30_000;

/** On unless the owner turned it off. Older saved configs have no field. */
export const anyModel = (config: DelegationConfig): boolean => config.anyModel !== false;

/** The parent's account on its own provider, else that provider's logged-in default login. */
export function accountFor(core: Core, parent: ThreadSummary, providerId: ProviderId): Account | undefined {
  const accounts = core.accounts.list().filter(account => account.providerId === providerId);
  if (parent.providerId === providerId) {
    const own = accounts.find(account => account.id === parent.accountId);
    if (own) return own;
  }
  const usable = accounts.filter(account => account.status !== 'unauthenticated');
  return usable.find(a => a.isolationDir === null && a.status === 'ok') ?? usable.find(a => a.status === 'ok')
    ?? usable.find(a => a.isolationDir === null) ?? usable[0];
}

/** Every model a child can start on right now, from descriptors and the last probes. Reads no process. */
export function catalog(core: Core, parent: ThreadSummary, withLegacy = false): DelegationModels & { legacy: DelegationModelChoice[] } {
  const choices: DelegationModelChoice[] = [], legacy: DelegationModelChoice[] = [];
  const unavailable: DelegationModels['unavailable'] = [];
  for (const summary of core.providers.available()) {
    const account = accountFor(core, parent, summary.id);
    if (!account) { unavailable.push({ providerId: summary.id, reason: 'no logged-in account' }); continue; }
    const provider = core.providers.require(summary.id);
    const models = modelsFor(provider, account.id);
    if (!models.length && PROBED_PROTOCOLS.includes(provider.protocol)) unavailable.push({ providerId: summary.id, reason: 'models not read yet' });
    for (const model of models) {
      const choice: DelegationModelChoice = {
        providerId: summary.id, providerName: summary.name, accountId: account.id, model: model.id, name: model.name,
        efforts: model.effort?.levels.map(level => level.id) ?? [], defaultEffort: model.effort?.default ?? null,
        current: parent.providerId === summary.id && parent.model === model.id,
      };
      (model.legacy ? legacy : choices).push(choice);
    }
  }
  return { anyModel: true, choices: withLegacy ? [...choices, ...legacy] : choices, legacy, unavailable };
}

/**
 * Read the model lists an agent process owns and nobody asked for yet. Only the
 * providers named, or every installed one; a slow or failing probe is reported,
 * never thrown.
 */
export async function discover(core: Core, probe: ProviderProbe, parent: ThreadSummary, only?: ProviderId[]): Promise<{ providerId: ProviderId; reason: string }[]> {
  const failures: { providerId: ProviderId; reason: string }[] = [];
  await Promise.all(core.providers.available().filter(summary => !only || only.includes(summary.id)).map(async summary => {
    const provider = core.providers.require(summary.id);
    const account = accountFor(core, parent, summary.id);
    if (!account || !PROBED_PROTOCOLS.includes(provider.protocol) || probedModelsOf(provider.protocol, provider.id, account.id) !== null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probe({ providerId: provider.id, accountId: account.id }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out reading its models')), PROBE_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      failures.push({ providerId: provider.id, reason: messageOf(error) });
    } finally { clearTimeout(timer); }
  }));
  return failures;
}

/** The providers a model name could belong to, so a spawn probes only those. */
export function providersNamed(core: Core, model: string): ProviderId[] | undefined {
  const slash = model.indexOf('/');
  const head = slash > 0 ? model.slice(0, slash) : '';
  return core.providers.get(head) ? [head] : undefined;
}

const label = (choice: DelegationModelChoice) => `${choice.providerId}/${choice.model}`;

/** `codex/gpt-5.5`, `gpt-5.5`, then a unique part of an id or a name, such as `opus`. */
function pick(choices: DelegationModelChoice[], parent: ThreadSummary, wanted: string): DelegationModelChoice {
  const query = wanted.trim().toLowerCase();
  const exact = choices.filter(c => label(c).toLowerCase() === query);
  if (exact.length) return exact[0]!;
  const byId = choices.filter(c => c.model.toLowerCase() === query);
  const partial = byId.length ? byId : choices.filter(c => c.model.toLowerCase().includes(query) || c.name.toLowerCase().includes(query) || label(c).toLowerCase().includes(query));
  const own = partial.filter(c => c.providerId === parent.providerId);
  if (partial.length === 1) return partial[0]!;
  if (byId.length && own.length === 1) return own[0]!;
  if (!partial.length) throw invalidParams(`model: no installed model matches "${wanted}"; run boite delegate models`, { field: 'model', expected: choices.slice(0, 40).map(label) });
  throw invalidParams(`model: "${wanted}" matches ${partial.length} models; name one of ${partial.slice(0, 8).map(label).join(', ')}`, { field: 'model', expected: partial.map(label) });
}

/** The parent's own route, under the built-in id. A profile an owner named `conversation` keeps its route. */
export function conversationRoute(parent: ThreadSummary): ChildRoute {
  return { id: CONVERSATION_PROFILE_ID, name: parent.model ?? parent.providerId, providerId: parent.providerId, accountId: parent.accountId, model: parent.model, effort: parent.effort ?? null };
}

/** The route a request names, checked against what is installed and what the owner allows. */
export function resolveRoute(core: Core, parent: ThreadSummary, config: DelegationConfig, request: RouteRequest): ChildRoute {
  const profiles = config.profiles;
  const named = (id: string) => profiles.find(p => p.id === id) ?? (id === CONVERSATION_PROFILE_ID ? conversationRoute(parent) : undefined);
  let route: ChildRoute;
  if (request.model !== undefined) {
    const choice = pick(catalog(core, parent, true).choices, parent, request.model);
    const allowed = [conversationRoute(parent), ...profiles];
    if (!anyModel(config) && !allowed.some(r => r.providerId === choice.providerId && r.model === choice.model)) {
      throw refused(`the owner limited subagents to this conversation's model and the profiles (${allowed.map(r => r.id).join(', ')}); leave --model out or name one of them`);
    }
    const sameAsParent = choice.providerId === parent.providerId && choice.model === parent.model;
    route = {
      id: label(choice), name: choice.name, providerId: choice.providerId, accountId: choice.accountId, model: choice.model,
      effort: sameAsParent && choice.efforts.includes(parent.effort ?? '') ? parent.effort ?? null : choice.defaultEffort,
    };
  } else {
    const id = request.profileId ?? CONVERSATION_PROFILE_ID;
    const found = named(id);
    if (!found) throw invalidParams(`profileId: expected ${[...new Set([CONVERSATION_PROFILE_ID, ...profiles.map(p => p.id)])].join(', ')}`);
    route = found;
  }
  if (request.effort !== undefined) {
    const provider = core.providers.require(route.providerId);
    if (route.model === null) throw invalidParams('effort: this route runs on the provider\'s default model; name a model with --model to choose its reasoning');
    route = { ...route, effort: checkEffort(provider, route.accountId, route.model, request.effort) };
  }
  return route;
}
