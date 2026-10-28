/**
 * `--model`, `--effort` and `--speed` of a thread an agent starts, and another
 * machine's models, as the core's `chooseModel` (`delegation/routes.ts`) and
 * `memberModels` (`threads/group-spawn.ts`) answer them.
 */
import { matchSpeed, providerEnabled, RpcErrorCode, SPEED_NEEDS_MODEL, speedRefusal, type DelegationModelChoice, type SettingMachine, type Thread } from '@boite/contracts';
import { RpcFailure } from '../client';
import { fakeCore } from './coordination';
import { modelsOf, PROBED_PROTOCOLS, probe } from './provider-catalog';
import { fakeMember } from './requests';
import type { FakeContext } from './context';

export interface ModelRequest { model?: string; effort?: string; speed?: string }
export interface ModelPick { providerId: string; accountId: string; model: string; effort: string | null; speed: string | null }

const label = (choice: DelegationModelChoice) => `${choice.providerId}/${choice.model}`;

/** The account a parent's children use on a provider: the parent's own there, else the provider's first. */
export function accountFor(ctx: FakeContext, parent: Pick<Thread, 'accountId'>, providerId: string) {
  return ctx.accounts.find(entry => entry.id === parent.accountId && entry.providerId === providerId) ?? ctx.accounts.find(entry => entry.providerId === providerId);
}

/** What the real core's catalog reads: every available provider's models on its first account, the parent's own first. */
export function modelChoices(ctx: FakeContext, parent: Pick<Thread, 'providerId' | 'accountId' | 'model'>): DelegationModelChoice[] {
  return ctx.providers.filter(provider => provider.available && providerEnabled(provider)).flatMap(provider => {
    const account = accountFor(ctx, parent, provider.id);
    if (!account) return [];
    return modelsOf(ctx, provider.id, account.id).filter(model => !model.legacy).map(model => ({
      providerId: provider.id, providerName: provider.name, accountId: account.id, model: model.id, name: model.name,
      efforts: model.effort?.levels.map(level => level.id) ?? [], defaultEffort: model.effort?.default ?? null,
      speeds: model.speeds?.map(speed => ({ ...speed })) ?? [],
      current: parent.providerId === provider.id && parent.model === model.id,
    }));
  });
}

/** What `--machine` takes for a member, as the core's `machineArg`. */
export function machineArg(ctx: FakeContext, machine: SettingMachine): string {
  const fold = (name: string) => name.trim().replace(/\s+/g, '-').toLowerCase();
  const shared = (ctx.roster?.cores ?? []).some(core => core.coreId !== machine.coreId && fold(core.name) === fold(machine.name));
  return shared ? machine.coreId.slice(0, 8) : machine.name.replace(/\s+/g, '-');
}

/** The core's matching: `provider/model`, a model id (the caller's provider first), then a unique part. */
export function chooseModel(choices: DelegationModelChoice[], caller: Pick<Thread, 'providerId' | 'model' | 'effort' | 'speed'>, request: ModelRequest, list: string): ModelPick {
  const wanted = request.model ?? (caller.model === null ? null : `${caller.providerId}/${caller.model}`);
  if (wanted === null) {
    throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: request.speed === undefined ? 'effort: this thread runs on the provider\'s default model; name a model with --model to choose its reasoning' : SPEED_NEEDS_MODEL, data: { field: 'model' } });
  }
  const query = wanted.trim().toLowerCase();
  let choice = choices.find(c => label(c).toLowerCase() === query);
  if (choice === undefined) {
    const byId = choices.filter(c => c.model.toLowerCase() === query);
    const partial = byId.length ? byId : choices.filter(c => c.model.toLowerCase().includes(query) || c.name.toLowerCase().includes(query) || label(c).toLowerCase().includes(query));
    const own = partial.filter(c => c.providerId === caller.providerId);
    if (partial.length === 1) choice = partial[0]!;
    else if (byId.length && own.length === 1) choice = own[0]!;
    else if (!partial.length) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `model: no installed model matches "${wanted}"; run ${list}`, data: { field: 'model', expected: choices.slice(0, 40).map(label) } });
    else throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `model: "${wanted}" matches ${partial.length} models; name one of ${partial.slice(0, 8).map(label).join(', ')}`, data: { field: 'model', expected: partial.map(label) } });
  }
  const name = label(choice);
  const own = choice.providerId === caller.providerId && choice.model === caller.model;
  let effort = own && choice.efforts.includes(caller.effort ?? '') ? caller.effort : choice.defaultEffort;
  if (request.effort !== undefined) {
    effort = request.effort.trim();
    if (!choice.efforts.includes(effort)) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: choice.efforts.length ? `effort: ${name} has no "${effort}" level; expected ${choice.efforts.join(', ')}` : `effort: ${name} offers no reasoning level; leave --effort out`, data: { field: 'effort', expected: choice.efforts } });
    }
  }
  const speeds = choice.speeds;
  let speed = own && speeds?.some(tier => tier.id === caller.speed) ? caller.speed ?? null : null;
  if (request.speed !== undefined) {
    speed = matchSpeed(speeds, request.speed);
    if (speed === null) throw new RpcFailure({ code: RpcErrorCode.Refused, message: speedRefusal(name, speeds, request.speed), data: speeds === undefined ? { field: 'speed' } : { field: 'speed', expected: speeds.map(tier => tier.id) } });
  }
  return { providerId: choice.providerId, accountId: choice.accountId, model: choice.model, effort, speed };
}

/** This machine's choice, after reading the lists nobody read yet when the named model is not listed. */
export async function chooseHere(ctx: FakeContext, caller: Thread, request: ModelRequest): Promise<ModelPick> {
  const listed = (model: string) => modelChoices(ctx, caller).some(c => label(c) === model || c.model === model);
  if (request.model !== undefined && !listed(request.model)) {
    await Promise.all(ctx.providers.filter(provider => provider.available && providerEnabled(provider) && PROBED_PROTOCOLS.includes(provider.protocol)).map(async provider => {
      const account = ctx.accounts.find(entry => entry.providerId === provider.id);
      if (account && !ctx.modelCatalogs.has(provider.id + '::' + account.id)) await probe(ctx, provider.id, account.id).catch(() => undefined);
    }));
  }
  return chooseModel(modelChoices(ctx, caller), caller, request, 'boite delegate models');
}

/** A member's models for `caller`, read now, while its owner keeps `groupThreads` on; refused as the core refuses. */
export function memberModels(ctx: FakeContext, caller: Thread, query: string, method: string): { machine: SettingMachine; choices: DelegationModelChoice[] } {
  const machine = fakeMember(ctx, query, method);
  const target = fakeCore(machine.coreId);
  if (target === undefined) throw new RpcFailure({ code: RpcErrorCode.Unavailable, message: `${machine.name} did not answer`, data: { field: 'machine' } });
  if (target.settings.groupThreads !== true) {
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${machine.name} does not let the other machines of its group start threads there; propose the switch to the user with boite settings request groupThreads true --machine ${machineArg(ctx, machine)} --why "<what the thread is for>"`, data: { field: 'machine', setting: 'groupThreads' } });
  }
  return { machine, choices: modelChoices(target, caller) };
}
