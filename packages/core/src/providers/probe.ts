import type { AccountId, ProviderId, RpcEvents, RpcResult, ThreadId } from '@boite/contracts';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Core } from '../core.ts';
import { forgetProbes, probeModels } from '../drivers/index.ts';
import { invalidParams, refused } from '../errors.ts';

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

  const threadId = probeThreadId(provider.id, account.id);
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
      log: (level, message) => {
        core.log(level, message);
      },
    });
    if (!isCurrent()) throw refused('the provider or account changed during discovery; refresh models');
    core.bus.emit('providers.probed', { providerId: provider.id, accountId: account.id, models, probedAt });
    return { models, probedAt };
  } finally {
    await Promise.all(exits);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export function registerProbeMethods(core: Core): void {
  /** Bumped when the descriptors are re-read, which outdates every probe. */
  let revision = 0;
  /** Bumped per account: another account signing in says nothing about this one's models. */
  const accountRevisions = new Map<AccountId, number>();
  const accountRevision = (accountId: AccountId): number => accountRevisions.get(accountId) ?? 0;
  const bumpAccount = (accountId: AccountId): void => {
    accountRevisions.set(accountId, accountRevision(accountId) + 1);
  };
  const pending = new Map<string, Promise<RpcResult<'providers.probe'>>>();
  /** The last probe of each provider and account, settled or not: the next one waits for it. */
  const lanes = new Map<string, Promise<void>>();
  core.router.register('providers.probe', (params) => {
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
  });

  core.bus.onAny((name, payload) => {
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
}
