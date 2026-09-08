import type { AccountId, ProviderId, RpcEvents, RpcResult, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { forgetProbes, probeModels } from '../drivers/index.ts';
import { refused } from '../errors.ts';

/** The synthetic thread a probe process runs under, so the trace shows it like a login. */
export function probeThreadId(providerId: ProviderId, accountId: AccountId): ThreadId {
  return `probe:${providerId}:${accountId}`;
}

/**
 * What this account can actually run. An ACP agent is asked: one process,
 * `initialize` then `session/new`, its `configOptions` read, the process killed
 * through the registry that traced it. Every other protocol answers with the
 * descriptor, which is where its models are written down.
 */
async function probeProvider(
  core: Core,
  providerId: ProviderId,
  accountId: AccountId,
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
  const { models, probedAt } = await probeModels(provider.protocol, {
    provider,
    accountId: account.id,
    accountEnv: core.accounts.accountEnv(account, provider),
    cwd: core.dataDir,
    spawnChild: (cmd, args, opts) => core.procs.spawnChild(threadId, cmd, args, opts),
    killTree: () => {
      core.procs.killTree(threadId);
    },
    log: (level, message) => {
      core.log(level, message);
    },
  });
  core.bus.emit('providers.probed', { providerId: provider.id, accountId: account.id, models, probedAt });
  return { models, probedAt };
}

export function registerProbeMethods(core: Core): void {
  core.router.register('providers.probe', (params) => probeProvider(core, params.providerId, params.accountId));

  core.bus.onAny((name, payload) => {
    // The descriptors were re-read, so what an agent listed under the old ones
    // says nothing about the new ones.
    if (name === 'providers.updated') {
      forgetProbes();
      return;
    }
    // An account whose login or isolation changed may list other models.
    if (name === 'accounts.updated') {
      const account = payload as RpcEvents['accounts.updated'];
      forgetProbes({ providerId: account.providerId, accountId: account.id });
      return;
    }
    if (name === 'accounts.removed') {
      forgetProbes({ accountId: (payload as RpcEvents['accounts.removed']).accountId });
    }
  });
}
