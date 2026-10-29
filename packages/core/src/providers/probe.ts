import type { AccountId, ModelInfo, ProviderId, RpcEvents, RpcParams, RpcResult, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { forgetProbes, holdModels, probedModelsOf, probeModels, readModelsOf, refreshProbes, rememberExternalModels, settleRefresh } from '../drivers/index.ts';
import { launchTemp, type LaunchTemp } from '../drivers/launch-temp.ts';
import { mergeProxyModels, readSubscriptionProxyModels } from '../subscription-proxy.ts';
import { invalidParams, refused, unavailable } from '../errors.ts';
import { logMessageOf } from '../log-errors.ts';
import { forgetSavedCatalog, readSavedCatalog, saveCatalog } from './saved-catalogs.ts';

/** The synthetic thread a probe process runs under, so the trace shows it like a login. */
export function probeThreadId(providerId: ProviderId, accountId: AccountId): ThreadId {
  return `probe:${providerId}:${accountId}`;
}

/**
 * Claude, ACP, Codex and pi list models through one temporary process.
 * Echo uses its descriptor. The probe's empty working directory
 * keeps project instructions and the core's journal outside that session.
 *
 * The caller is answered as soon as the models are read. Stopping the process
 * and removing its directory, up to a second more for Claude, land in
 * `cleanups`: the account's next probe waits for them, the picker does not.
 */
async function probeProvider(
  core: Core,
  providerId: ProviderId,
  accountId: AccountId,
  isCurrent: () => boolean,
  cleanups: Promise<void>[],
  model?: string,
): Promise<RpcResult<'providers.probe'>> {
  const provider = core.providers.require(providerId);
  const account = core.accounts.require(accountId);
  if (account.providerId !== provider.id) {
    throw refused('the account belongs to another provider', {
      accountId,
      accountProviderId: account.providerId,
      providerId: provider.id,
    });
  }
  // The probe starts the agent: a provider turned off lists nothing.
  if (!core.providers.enabled(provider.id)) {
    throw unavailable(`${provider.name} is turned off on this machine. Turn it on in Settings > Providers to use it`, {
      providerId: provider.id,
      disabled: true,
    });
  }

  const proxyModels = await readSubscriptionProxyModels(core, provider);
  if (proxyModels !== null) {
    // The agent's own discovery, run through the gateway, describes each model
    // as a subscription would: effort scale, speed tiers, names. The gateway
    // only adds the models it routes beyond that list.
    let native: ModelInfo[] = [];
    try { native = (await probeNative(core, provider, account.id, cleanups, model)).models; }
    catch (error) { core.logs.record('warn', logMessageOf(error), { source: provider.id, event: 'provider.probeFailed', threadId: probeThreadId(provider.id, account.id) }); }
    if (!isCurrent()) throw refused('the subscription proxy changed during discovery; refresh models');
    const models = mergeProxyModels(native, proxyModels);
    const probedAt = Date.now();
    rememberExternalModels(provider.protocol, provider.id, account.id, models);
    core.bus.emit('providers.probed', { providerId: provider.id, accountId: account.id, models, probedAt });
    return { models, probedAt };
  }
  try {
    const { models, probedAt } = await probeNative(core, provider, account.id, cleanups, model);
    core.accounts.require(account.id);
    if (!isCurrent()) throw refused('the provider or account changed during discovery; refresh models');
    core.bus.emit('providers.probed', { providerId: provider.id, accountId: account.id, models, probedAt });
    return { models, probedAt };
  } catch (error) {
    core.logs.record('warn', logMessageOf(error), { source: provider.id, event: 'provider.probeFailed', threadId: probeThreadId(provider.id, account.id) });
    throw error;
  }
}

/**
 * One temporary agent process lists its models; every path stops it and
 * removes its directory, in a cleanup pushed to `cleanups` rather than awaited.
 */
async function probeNative(
  core: Core,
  provider: ReturnType<Core['providers']['require']>,
  accountId: AccountId,
  cleanups: Promise<void>[],
  model?: string,
): Promise<{ models: ModelInfo[]; probedAt: number }> {
  const account = core.accounts.require(accountId);
  const threadId = probeThreadId(provider.id, account.id);
  const cleanupContext = { source: provider.id, event: 'provider.probeCleanup', threadId };
  const log = (message: string): void => core.log('warn', `probing ${provider.id}: ${message}`, cleanupContext);
  // The account owns the probe: removing it stops this process and waits for it.
  // A probe runs the same executable a turn would, so its children hold the same lease.
  const operation = core.accounts.operations.open(account.id, provider.id, threadId, log);
  let temp: LaunchTemp | null = null;
  try {
    temp = launchTemp(provider, account.isolationDir);
    const accountEnv = core.accounts.accountEnv(account, provider);
    const { models, probedAt } = await probeModels(provider.protocol, {
      provider,
      accountId: account.id,
      accountEnv: temp === null ? accountEnv : { ...accountEnv, ...temp.env },
      cwd: operation.scratch('boite-probe-'),
      catalogThread: core.drafts.catalogThread(provider.id, account.id)
        ?? core.threads.list({}).find(thread => thread.providerId === provider.id && thread.accountId === account.id && core.threads.focus.viewed(thread.id)),
      ...(model === undefined ? {} : { model }),
      spawnChild: operation.spawnChild,
      killTree: operation.killTree,
      log: (level, message, context) => {
        core.log(level, message, { ...context, source: provider.id, event: 'provider.probe', threadId });
      },
    });
    return { models, probedAt };
  } finally {
    // A descendant can hold the directory after the direct child closed. Neither
    // waiting for it nor removing the directory may replace the models just read.
    cleanups.push(operation.close().then(() => temp?.dispose(log)));
  }
}

export type ProviderProbe = (params: RpcParams<'providers.probe'>) => Promise<RpcResult<'providers.probe'>>;

export function registerProbeMethods(core: Core): ProviderProbe {
  /** Bumped when the descriptors are re-read, which outdates every probe. */
  let revision = 0;
  let proxyConfig = JSON.stringify(core.settings.get().subscriptionProxy);
  /** Bumped per account: another account signing in says nothing about this one's models. */
  const accountRevisions = new Map<AccountId, number>();
  const accountRevision = (accountId: AccountId): number => accountRevisions.get(accountId) ?? 0;
  const bumpAccount = (accountId: AccountId): void => {
    accountRevisions.set(accountId, accountRevision(accountId) + 1);
  };
  const pending = new Map<string, Promise<RpcResult<'providers.probe'>>>();
  /** When each account's list was last read, for an answer served from the cache. Dropped with the catalog. */
  const answered = new Map<string, number>();
  const forgetAnswered = (accountId?: AccountId): void => {
    for (const lane of answered.keys()) if (accountId === undefined || (JSON.parse(lane) as string[])[1] === accountId) answered.delete(lane);
  };
  /** The last probe of each provider and account, settled or not: the next one waits for it. */
  const lanes = new Map<string, Promise<void>>();
  const probe: ProviderProbe = (params) => {
    if (params.model !== undefined && (typeof params.model !== 'string' || params.model.length === 0)) {
      throw invalidParams('model must be a non-empty string when given', { field: 'model', expected: 'a non-empty string' });
    }
    // A list already read starts no process, so it waits neither for a probe
    // of this account that is still exiting nor for a refresh still reading:
    // the list a refresh keeps is the one model checks accept meanwhile.
    const lane = JSON.stringify([params.providerId, params.accountId]);
    const known = answered.get(lane);
    if (!params.refresh && params.model === undefined && known !== undefined) {
      const models = probedModelsOf(core.providers.require(params.providerId).protocol, params.providerId, params.accountId);
      if (models !== null) return Promise.resolve({ models, probedAt: known });
    }
    const key = JSON.stringify([params.providerId, params.accountId, params.model ?? null]);
    // Nothing read since this core started, or since a change that dropped the
    // list: the one saved under the same descriptor, program, gateway and
    // login answers now, and a fresh read replaces it once the agent answers.
    // A list a driver already holds, from a sign-in's own session or a turn, is
    // fresher and starts no process: the plain path below answers it. A list
    // only held for a refresh, the saved one included, does not count.
    if (!params.refresh && params.model === undefined && known === undefined && core.providers.enabled(params.providerId)
      && readModelsOf(core.providers.require(params.providerId).protocol, params.providerId, params.accountId) === null) {
      const saved = readSavedCatalog(core, params.providerId, params.accountId);
      if (saved !== null) {
        // Model checks accept the list on screen until the fresh read settles,
        // whether this call starts that read or a refresh already runs.
        holdModels(params.providerId, params.accountId, saved.models);
        if (!pending.has(key)) void probe({ providerId: params.providerId, accountId: params.accountId, refresh: true }).catch(() => undefined);
        return Promise.resolve(saved);
      }
    }
    const existing = pending.get(key);
    if (existing) return existing;
    // One probe at a time per account: they share a synthetic thread, so the
    // `killTree` that ends one would take a second one's process with it, and a
    // refresh would drop the cache entry the other is still filling. The lane
    // holds until the process has exited; the caller is answered before that.
    const before = lanes.get(lane) ?? Promise.resolve();
    const cleanups: Promise<void>[] = [];
    const request = before.then(async () => {
      // Meta discovery can connect Muse and invalidate its old account catalog.
      // Settle that change before recording the revision this probe belongs to.
      if (params.providerId === 'muse') await core.quotas.gateway.read();
      const protocol = core.providers.require(params.providerId).protocol;
      if (params.refresh) refreshProbes(protocol, params.providerId, params.accountId);
      const startedAtRevision = revision;
      const startedAtAccount = accountRevision(params.accountId);
      const isCurrent = () => revision === startedAtRevision && accountRevision(params.accountId) === startedAtAccount;
      const answer = probeProvider(core, params.providerId, params.accountId, isCurrent, cleanups, params.model);
      if (params.refresh) void answer.then(() => settleRefresh(params.providerId, params.accountId), () => undefined);
      if (params.model === undefined) void answer.then((result) => { if (isCurrent()) answered.set(lane, result.probedAt); }, () => undefined);
      return answer;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
    const settled = request.then(() => undefined, () => undefined).then(() => Promise.all(cleanups)).then(() => undefined, () => undefined);
    lanes.set(lane, settled);
    void settled.then(() => {
      if (lanes.get(lane) === settled) lanes.delete(lane);
    });
    return request;
  };
  core.router.register('providers.probe', probe);

  core.bus.onAny((name, payload) => {
    if (name === 'providers.probed') {
      const { providerId, accountId, models, probedAt } = payload as RpcEvents['providers.probed'];
      // A failed write costs the next start its instant list, never this answer.
      try { saveCatalog(core, providerId, accountId, { models, probedAt }); }
      catch (error) { core.log('warn', `saving the ${providerId} model list: ${logMessageOf(error)}`); }
      return;
    }
    if (name === 'settings.updated') {
      const nextProxy = JSON.stringify((payload as RpcEvents['settings.updated']).subscriptionProxy);
      if (nextProxy === proxyConfig) return;
      proxyConfig = nextProxy;
      revision++;
      forgetProbes();
      forgetAnswered();
      return;
    }
    // The descriptors were re-read, so what an agent listed under the old ones
    // says nothing about the new ones.
    if (name === 'providers.updated') {
      revision++;
      forgetProbes();
      forgetAnswered();
      return;
    }
    // An account whose login or isolation changed may list other models.
    if (name === 'accounts.updated') {
      const account = payload as RpcEvents['accounts.updated'];
      bumpAccount(account.id);
      forgetProbes({ providerId: account.providerId, accountId: account.id });
      forgetAnswered(account.id);
      // A sign-in can reach another account under the same identity, or none
      // the core can read: only a list read after it stands for the next start.
      forgetSavedCatalog(core, account.id);
      return;
    }
    if (name === 'accounts.removed') {
      const { accountId } = payload as RpcEvents['accounts.removed'];
      bumpAccount(accountId);
      forgetProbes({ accountId });
      forgetAnswered(accountId);
      forgetSavedCatalog(core, accountId);
    }
  });
  return probe;
}
