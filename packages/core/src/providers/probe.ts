import type { AccountId, ModelInfo, ProviderId, RpcEvents, RpcParams, RpcResult, ThreadId } from '@boite/contracts';
import { mkdtempSync } from 'node:fs';
import { removeDir } from '../fs-retry.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Core } from '../core.ts';
import { forgetProbes, probeModels, rememberExternalModels } from '../drivers/index.ts';
import { mergeProxyModels, readSubscriptionProxyModels } from '../subscription-proxy.ts';
import { invalidParams, refused } from '../errors.ts';
import { logMessageOf } from '../log-errors.ts';

/** After owned processes stop, a missing pipe-close event must not hold the account's probe lane. */
const PROBE_CLOSE_GRACE_MS = 1000;

/** The synthetic thread a probe process runs under, so the trace shows it like a login. */
export function probeThreadId(providerId: ProviderId, accountId: AccountId): ThreadId {
  return `probe:${providerId}:${accountId}`;
}

/**
 * Claude, ACP, Codex and pi list models through one temporary process.
 * Echo uses its descriptor. The probe's empty working directory
 * keeps project instructions and the core's journal outside that session.
 */
async function probeProvider(
  core: Core,
  providerId: ProviderId,
  accountId: AccountId,
  isCurrent: () => boolean,
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

  const proxyModels = await readSubscriptionProxyModels(core, provider);
  if (proxyModels !== null) {
    // The agent's own discovery, run through the gateway, describes each model
    // as a subscription would: effort scale, speed tiers, names. The gateway
    // only adds the models it routes beyond that list.
    let native: ModelInfo[] = [];
    try { native = (await probeNative(core, provider, account.id, model)).models; }
    catch (error) { core.logs.record('warn', logMessageOf(error), { source: provider.id, event: 'provider.probeFailed', threadId: probeThreadId(provider.id, account.id) }); }
    if (!isCurrent()) throw refused('the subscription proxy changed during discovery; refresh models');
    const models = mergeProxyModels(native, proxyModels);
    const probedAt = Date.now();
    rememberExternalModels(provider.protocol, provider.id, account.id, models);
    core.bus.emit('providers.probed', { providerId: provider.id, accountId: account.id, models, probedAt });
    return { models, probedAt };
  }
  try {
    const { models, probedAt } = await probeNative(core, provider, account.id, model);
    core.accounts.require(account.id);
    if (!isCurrent()) throw refused('the provider or account changed during discovery; refresh models');
    core.bus.emit('providers.probed', { providerId: provider.id, accountId: account.id, models, probedAt });
    return { models, probedAt };
  } catch (error) {
    core.logs.record('warn', logMessageOf(error), { source: provider.id, event: 'provider.probeFailed', threadId: probeThreadId(provider.id, account.id) });
    throw error;
  }
}

/** One temporary agent process lists its models; every path stops it and removes its directory. */
async function probeNative(
  core: Core,
  provider: ReturnType<Core['providers']['require']>,
  accountId: AccountId,
  model?: string,
): Promise<{ models: ModelInfo[]; probedAt: number }> {
  const account = core.accounts.require(accountId);
  const threadId = probeThreadId(provider.id, account.id);
  const cleanupContext = { source: provider.id, event: 'provider.probeCleanup', threadId };
  const directory = mkdtempSync(join(tmpdir(), 'boite-probe-'));
  const exits: Promise<void>[] = [];
  try {
    const { models, probedAt } = await probeModels(provider.protocol, {
      provider,
      accountId: account.id,
      accountEnv: core.accounts.accountEnv(account, provider),
      cwd: directory,
      ...(model === undefined ? {} : { model }),
      // A probe runs the same executable a turn would, so it holds the same lease:
      // removing a managed install under a probe would be the same crash.
      spawnChild: (cmd, args, opts) => {
        core.accounts.require(account.id);
        const child = core.procs.spawnChild(threadId, cmd, args, opts);
        exits.push(new Promise<void>((resolve) => {
          child.once('close', () => resolve());
          child.once('error', () => resolve());
        }));
        const installs = core.providers.installs;
        installs.acquire(provider.id);
        let released = false;
        const drop = (): void => {
          if (released) return;
          released = true;
          installs.release(provider.id);
        };
        child.once('exit', drop);
        child.once('error', drop);
        return child;
      },
      killTree: () => {
        core.procs.killTree(threadId);
      },
      log: (level, message, context) => {
        core.log(level, message, { ...context, source: provider.id, event: 'provider.probe', threadId });
      },
    });
    return { models, probedAt };
  } finally {
    // A descendant can hold the directory after the direct child closed. Neither
    // waiting for it nor removing the directory may replace the models just read.
    await core.procs.stopAndWait(threadId).catch((error: unknown) => core.log('warn', `probing ${provider.id}: ${error instanceof Error ? error.message : String(error)}`, cleanupContext));
    if (exits.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(exits),
          new Promise<void>(resolve => {
            timer = setTimeout(() => {
              core.log('warn', `probing ${provider.id}: process pipes did not close within ${PROBE_CLOSE_GRACE_MS} ms`, cleanupContext);
              resolve();
            }, PROBE_CLOSE_GRACE_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    await removeDir(directory, (message) => core.log('warn', `probing ${provider.id}: ${message}`, cleanupContext));
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
  /** The last probe of each provider and account, settled or not: the next one waits for it. */
  const lanes = new Map<string, Promise<void>>();
  const probe: ProviderProbe = (params) => {
    if (params.model !== undefined && (typeof params.model !== 'string' || params.model.length === 0)) {
      throw invalidParams('model must be a non-empty string when given', { field: 'model', expected: 'a non-empty string' });
    }
    const key = JSON.stringify([params.providerId, params.accountId, params.model ?? null]);
    const existing = pending.get(key);
    if (existing) return existing;
    // One probe at a time per account: they share a synthetic thread, so the
    // `killTree` that ends one would take a second one's process with it, and a
    // refresh would drop the cache entry the other is still filling.
    const lane = JSON.stringify([params.providerId, params.accountId]);
    const before = lanes.get(lane) ?? Promise.resolve();
    const request = before.then(() => {
      if (params.refresh) forgetProbes({ providerId: params.providerId, accountId: params.accountId });
      const startedAtRevision = revision;
      const startedAtAccount = accountRevision(params.accountId);
      const isCurrent = () => revision === startedAtRevision && accountRevision(params.accountId) === startedAtAccount;
      return probeProvider(core, params.providerId, params.accountId, isCurrent, params.model);
    }).finally(() => pending.delete(key));
    pending.set(key, request);
    const settled = request.then(() => undefined, () => undefined);
    lanes.set(lane, settled);
    void settled.then(() => {
      if (lanes.get(lane) === settled) lanes.delete(lane);
    });
    return request;
  };
  core.router.register('providers.probe', probe);

  core.bus.onAny((name, payload) => {
    if (name === 'settings.updated') {
      const nextProxy = JSON.stringify((payload as RpcEvents['settings.updated']).subscriptionProxy);
      if (nextProxy === proxyConfig) return;
      proxyConfig = nextProxy;
      revision++;
      forgetProbes();
      return;
    }
    // The descriptors were re-read, so what an agent listed under the old ones
    // says nothing about the new ones.
    if (name === 'providers.updated') {
      revision++;
      forgetProbes();
      return;
    }
    // An account whose login or isolation changed may list other models.
    if (name === 'accounts.updated') {
      const account = payload as RpcEvents['accounts.updated'];
      bumpAccount(account.id);
      forgetProbes({ providerId: account.providerId, accountId: account.id });
      return;
    }
    if (name === 'accounts.removed') {
      const { accountId } = payload as RpcEvents['accounts.removed'];
      bumpAccount(accountId);
      forgetProbes({ accountId });
    }
  });
  return probe;
}
