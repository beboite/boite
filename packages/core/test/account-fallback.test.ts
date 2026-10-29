import { expect, test } from 'bun:test';
import type { Account, ThreadSummary } from '@boite/contracts';
import type { Core } from '../src/core.ts';
import { followAgent } from '../src/threads/account-fallback.ts';

const account = (id: string, status: Account['status']) => ({ id, providerId: 'claude', status }) as Account;

test('a bot whose account signed out moves to the best account granted to it, even when a better one is not', () => {
  const accounts = [account('acc_bot', 'unauthenticated'), account('acc_best', 'ok'), account('acc_granted', 'ok')];
  const updates: unknown[] = [];
  let current = { id: 'thr_bot', providerId: 'claude', accountId: 'acc_bot', agentSessionId: 'agt_session_1', model: 'm', effort: null, speed: null } as unknown as ThreadSummary;
  const core = {
    journal: { getAccount: (id: string) => accounts.find(a => a.id === id) ?? null },
    accounts: { list: () => accounts },
    workforce: { resident: { ownerOf: () => 'agt_profile_1', accountAllowed: (_owner: string, id: string) => id === 'acc_granted' } },
    threads: {
      update: (params: { accountId: string }) => { updates.push(params); current = { ...current, accountId: params.accountId }; },
      require: () => current,
    },
    logs: { warn: () => {} },
  } as unknown as Core;

  const moved = followAgent(core, current);
  expect(moved.accountId).toBe('acc_granted');
  expect(updates).toEqual([expect.objectContaining({ threadId: 'thr_bot', accountId: 'acc_granted' })]);
});
