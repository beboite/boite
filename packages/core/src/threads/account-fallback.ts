import type { Account, AccountId, ProviderId, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { checkSpeed, checkStoredEffort } from './selection.ts';

// A thread runs on its agent, not on one login. When the account it last used
// is signed out or removed, the next turn moves it to another account of the
// same agent instead of refusing until that exact login comes back.

/** Signed in first, then an account nobody could check, then one whose check failed. */
const RANK: Record<Account['status'], number> = { ok: 0, unknown: 1, error: 2, unauthenticated: 3 };

/**
 * The account a thread of this provider runs on: `preferred` while it exists
 * and is not signed out, else the provider's other account that ranks best.
 * Null when every account of the provider is signed out.
 */
export function usableAccount(core: Core, providerId: ProviderId, preferred: AccountId): Account | null {
  const own = core.journal.getAccount(preferred);
  if (own !== null && own.providerId === providerId && own.status !== 'unauthenticated') return own;
  return otherAccounts(core, providerId, preferred).find((account) => account.status !== 'unauthenticated') ?? null;
}

/** The provider's accounts other than `skipped`, best first, the signed-out ones last. */
export function otherAccounts(core: Core, providerId: ProviderId, skipped: AccountId): Account[] {
  return core.accounts.list()
    .filter((account) => account.providerId === providerId && account.id !== skipped)
    .sort((a, b) => RANK[a.status] - RANK[b.status]);
}

/**
 * The thread as it reads on `account`, another of its provider. The model,
 * effort and permissions stay; a speed the account does not list, or an effort
 * its known scale lacks, goes back to the model's default. The native session belongs to the old
 * login, so it is dropped and the next turn starts fresh with the journal's
 * context, as a switch from the model picker does.
 */
export function movedToAccount(core: Core, thread: ThreadSummary, account: Account): ThreadSummary {
  const provider = core.providers.require(account.providerId);
  const keep = <T>(check: () => T, fallback: T): T => { try { return check(); } catch { return fallback; } };
  return {
    ...thread,
    providerId: provider.id,
    accountId: account.id,
    effort: keep(() => { checkStoredEffort(provider, account.id, thread.model, thread.effort); return thread.effort; }, null),
    speed: keep(() => checkSpeed(provider, account.id, thread.model, thread.speed ?? null), null),
    sessionId: null,
    sessionResumeAt: null,
    sessionGeneration: (thread.sessionGeneration ?? 0) + 1,
    selectionVersion: (thread.selectionVersion ?? 0) + 1,
    context: null,
  };
}
