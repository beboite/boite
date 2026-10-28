/**
 * Which harness, account, model and reasoning level a delegated child runs on.
 * An agent names a model (`codex/gpt-5.5`, `gpt-5.5`, `opus`) and a level;
 * Boite picks the account: the parent's for its own provider, else that
 * provider's usable login. A child runs on a speed tier only when the request
 * names one: it never inherits the parent's.
 */
import { CONVERSATION_PROFILE_ID, matchSpeed, SPEED_NEEDS_MODEL, speedRefusal } from '@boite/contracts';
import type { Account, DelegationConfig, DelegationModelChoice, DelegationModels, DelegationProfile, ProviderId, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused } from '../errors.ts';
import { probedModelsOf } from '../drivers/index.ts';
import { checkEffort, modelsFor, PROBED_PROTOCOLS } from '../threads/selection.ts';
import type { ProviderProbe } from '../providers/probe.ts';

/** A profile, or a conversation's own route, whose model may be the provider's default. */
export type ChildRoute = Omit<DelegationProfile, 'model'> & { model: string | null; speed?: string | null };

export interface RouteRequest {
  profileId?: string | null;
  model?: string;
  effort?: string;
  /** A speed tier of the route's model, by id or label. */
  speed?: string;
}

const PROBE_TIMEOUT_MS = 30_000;

/** What a model list is read for: a thread here, or the agent of another machine asking for one. */
export type Asker = Pick<ThreadSummary, 'providerId' | 'accountId' | 'model'>;

/** On unless the owner turned it off. Older saved configs have no field. */
export const anyModel = (config: DelegationConfig): boolean => config.anyModel !== false;

/** The parent's account on its own provider, else that provider's logged-in default login. */
export function accountFor(core: Core, parent: Asker, providerId: ProviderId): Account | undefined {
  const accounts = core.accounts.list().filter(account => account.providerId === providerId);
  if (parent.providerId === providerId) {
    const own = accounts.find(account => account.id === parent.accountId);
    if (own) return own;
  }
  return loggedInAccount(accounts);
}

/** A provider's logged-in login, the default location first; undefined when none is signed in. */
export function loggedInAccount(accounts: readonly Account[]): Account | undefined {
  const usable = accounts.filter(account => account.status !== 'unauthenticated');
  return usable.find(a => a.isolationDir === null && a.status === 'ok') ?? usable.find(a => a.status === 'ok')
    ?? usable.find(a => a.isolationDir === null) ?? usable[0];
}

/** Every model a child can start on right now, from descriptors and the last probes. Reads no process. */
export function catalog(core: Core, parent: Asker, withLegacy = false): DelegationModels & { legacy: DelegationModelChoice[] } {
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
        speeds: model.speeds?.map(speed => ({ ...speed })) ?? [],
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
 * never thrown. `timeoutMs` bounds each read.
 */
export async function discover(core: Core, probe: ProviderProbe, parent: Asker, only?: ProviderId[], timeoutMs = PROBE_TIMEOUT_MS): Promise<{ providerId: ProviderId; reason: string }[]> {
  const failures: { providerId: ProviderId; reason: string }[] = [];
  await Promise.all(core.providers.available().filter(summary => !only || only.includes(summary.id)).map(async summary => {
    const provider = core.providers.require(summary.id);
    const account = accountFor(core, parent, summary.id);
    if (!account || !PROBED_PROTOCOLS.includes(provider.protocol) || probedModelsOf(provider.protocol, provider.id, account.id) !== null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probe({ providerId: provider.id, accountId: account.id }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out reading its models')), timeoutMs); }),
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

/** Read the lists the named models need, when the catalog does not list them yet. */
export async function readNamed(core: Core, probe: ProviderProbe, parent: Asker, models: string[]): Promise<void> {
  if (!models.length) return;
  const known = catalog(core, parent, true).choices;
  const missing = models.filter(model => !known.some(c => `${c.providerId}/${c.model}` === model || c.model === model));
  if (!missing.length) return;
  const only = missing.map(model => providersNamed(core, model));
  await discover(core, probe, parent, only.some(list => list === undefined) ? undefined : [...new Set(only.flat() as string[])]);
}

const label = (choice: DelegationModelChoice) => `${choice.providerId}/${choice.model}`;

/** `codex/gpt-5.5`, `gpt-5.5`, then a unique part of an id or a name, such as `opus`. `list` is the command that lists them. */
function pick(choices: DelegationModelChoice[], parent: Pick<ThreadSummary, 'providerId'>, wanted: string, list = 'boite delegate models'): DelegationModelChoice {
  const query = wanted.trim().toLowerCase();
  const exact = choices.filter(c => label(c).toLowerCase() === query);
  if (exact.length) return exact[0]!;
  const byId = choices.filter(c => c.model.toLowerCase() === query);
  const partial = byId.length ? byId : choices.filter(c => c.model.toLowerCase().includes(query) || c.name.toLowerCase().includes(query) || label(c).toLowerCase().includes(query));
  const own = partial.filter(c => c.providerId === parent.providerId);
  if (partial.length === 1) return partial[0]!;
  if (byId.length && own.length === 1) return own[0]!;
  if (!partial.length) throw invalidParams(`model: no installed model matches "${wanted}"; run ${list}`, { field: 'model', expected: choices.slice(0, 40).map(label) });
  throw invalidParams(`model: "${wanted}" matches ${partial.length} models; name one of ${partial.slice(0, 8).map(label).join(', ')}`, { field: 'model', expected: partial.map(label) });
}

/** The agent a thread an agent starts runs on. */
export interface ModelPick { providerId: ProviderId; accountId: string; model: string; effort: string | null; speed: string | null }

/**
 * `--model`, `--effort` and `--speed` of a thread an agent starts, matched
 * against a machine's model list as `delegate spawn` matches them, and
 * refused with what that list offers. Without `model` it is the caller's own;
 * on the caller's own model the caller's level and tier stay unless named,
 * on another the model's default level and no tier.
 */
export function chooseModel(choices: DelegationModelChoice[], caller: Pick<ThreadSummary, 'providerId' | 'model' | 'effort' | 'speed'>, request: Omit<RouteRequest, 'profileId'>, list: string): ModelPick {
  const wanted = request.model ?? (caller.model === null ? null : `${caller.providerId}/${caller.model}`);
  if (wanted === null) throw invalidParams(request.speed === undefined ? 'effort: this thread runs on the provider\'s default model; name a model with --model to choose its reasoning' : SPEED_NEEDS_MODEL, { field: 'model' });
  const choice = pick(choices, caller, wanted, list);
  const name = label(choice);
  const own = choice.providerId === caller.providerId && choice.model === caller.model;
  let effort = own && choice.efforts.includes(caller.effort ?? '') ? caller.effort : choice.defaultEffort;
  if (request.effort !== undefined) {
    effort = request.effort.trim();
    if (!choice.efforts.includes(effort)) {
      throw refused(choice.efforts.length ? `effort: ${name} has no "${effort}" level; expected ${choice.efforts.join(', ')}` : `effort: ${name} offers no reasoning level; leave --effort out`, { field: 'effort', expected: choice.efforts });
    }
  }
  const speeds = choice.speeds;
  let speed = own && speeds?.some(tier => tier.id === caller.speed) ? caller.speed ?? null : null;
  if (request.speed !== undefined) {
    speed = matchSpeed(speeds, request.speed);
    if (speed === null) throw refused(speedRefusal(name, speeds, request.speed), speeds === undefined ? { field: 'speed' } : { field: 'speed', expected: speeds.map(tier => tier.id) });
  }
  return { providerId: choice.providerId, accountId: choice.accountId, model: choice.model, effort, speed };
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
  if (request.speed === undefined) return { ...route, speed: null };
  if (route.model === null) throw invalidParams(SPEED_NEEDS_MODEL);
  const provider = core.providers.require(route.providerId);
  const listed = modelsFor(provider, route.accountId).find(entry => entry.id === route.model)?.speeds;
  const speed = matchSpeed(listed, request.speed);
  if (speed !== null) return { ...route, speed };
  // A spawn reads no agent. Tiers are unread only while an agent that owns its list has given none; anything else without tiers offers none.
  const unread = listed === undefined && PROBED_PROTOCOLS.includes(provider.protocol) && probedModelsOf(provider.protocol, provider.id, route.accountId) === null;
  // Unread tiers are unknown, not empty: no `expected` list then.
  throw refused(speedRefusal(`${route.providerId}/${route.model}`, unread ? null : listed ?? [], request.speed), unread ? { field: 'speed' } : { field: 'speed', expected: (listed ?? []).map(option => option.id) });
}
