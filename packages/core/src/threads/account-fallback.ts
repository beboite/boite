import type { Account, AccountId, ProviderId, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';

// A conversation runs on its agent, not on one login. When the account it last
// used signed out or was removed, its next turn moves it to another account of
// the same agent instead of refusing until that exact login comes back.

/** Signed in first, then an account nobody could check, then one whose check failed. */
const RANK: Record<Account['status'], number> = { ok: 0, unknown: 1, error: 2, unauthenticated: 3 };

/** The refusal of a conversation whose account `accounts.remove` deleted, when no other account of its agent can take it. */
export function accountRemoved(thread: ThreadSummary): Error {
  return refused('accountId: the account of this conversation was removed; choose another account in it first', {
    threadId: thread.id, accountId: thread.accountId, field: 'accountId', expected: 'an existing account',
  });
}

/**
 * The account a thread of this provider runs on: `preferred` while it exists
 * and is not signed out, else the provider's other account that ranks best.
 * Null when every account of the provider is signed out or gone.
 */
export function usableAccount(core: Core, providerId: ProviderId, preferred: AccountId): Account | null {
  const own = core.journal.getAccount(preferred);
  if (own !== null && own.providerId === providerId && own.status !== 'unauthenticated') return own;
  return core.accounts.list()
    .filter((account) => account.providerId === providerId && account.id !== preferred && account.status !== 'unauthenticated')
    .sort((a, b) => RANK[a.status] - RANK[b.status])[0] ?? null;
}

/**
 * The thread as its next turn should find it: on its own account while that
 * one can run, else moved to the best other account of its provider through
 * `threads.update`, the switch the model picker makes, so the native session
 * of the old login is dropped and the turn starts fresh with the journal's
 * context. The model, effort and speed stay when the new account lists them,
 * else the model alone, else the provider's default model. With nowhere to
 * go, a removed account refuses here and a signed-out one at the turn's
 * runnable check, naming it. A persistent agent keeps its profile's account.
 */
export function followAgent(core: Core, thread: ThreadSummary): ThreadSummary {
  const own = core.journal.getAccount(thread.accountId);
  if (own !== null && own.status !== 'unauthenticated') return thread;
  const other = thread.agentSessionId ? null : usableAccount(core, thread.providerId, thread.accountId);
  if (other === null) {
    if (own === null) throw accountRemoved(thread);
    return thread;
  }
  const kept = [{ model: thread.model, effort: thread.effort, speed: thread.speed ?? null }, { model: thread.model }, {}];
  for (const [index, keep] of kept.entries()) {
    try {
      core.threads.update({ threadId: thread.id, accountId: other.id, ...keep });
      return core.threads.require(thread.id);
    } catch (error) {
      if (index === kept.length - 1) throw error;
    }
  }
  return thread;
}
