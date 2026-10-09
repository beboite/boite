import type { Account, Thread } from '@boite/contracts';
import type { FakeContext } from './context';
import { modelsOf } from './provider-catalog';

// The core's `threads/account-fallback.ts`: a thread follows its agent, not
// one login, so a signed-out or removed account hands it to another.

const RANK: Record<Account['status'], number> = { ok: 0, unknown: 1, error: 2, unauthenticated: 3 };

/** The provider's accounts other than `skipped`, best first, the signed-out ones last. */
export function otherAccounts(ctx: FakeContext, providerId: string, skipped: string): Account[] {
  return ctx.accounts
    .filter((account) => account.providerId === providerId && account.id !== skipped)
    .sort((a, b) => RANK[a.status] - RANK[b.status]);
}

/** `preferred` while it can run, else the provider's best other account signed in. */
export function usableAccount(ctx: FakeContext, providerId: string, preferred: string): Account | null {
  const own = ctx.accounts.find((account) => account.id === preferred);
  if (own && own.providerId === providerId && own.status !== 'unauthenticated') return own;
  return otherAccounts(ctx, providerId, preferred).find((account) => account.status !== 'unauthenticated') ?? null;
}

/** The thread on another account of its provider: same model and effort, a fresh native session. */
export function moveToAccount(ctx: FakeContext, thread: Thread, account: Account): void {
  const speeds = modelsOf(ctx, account.providerId, account.id).find((model) => model.id === thread.model)?.speeds ?? [];
  thread.accountId = account.id;
  thread.providerId = account.providerId;
  if (!speeds.some((speed) => speed.id === thread.speed)) thread.speed = null;
  thread.sessionId = null;
  thread.sessionGeneration = (thread.sessionGeneration ?? 0) + 1;
  thread.selectionVersion = (thread.selectionVersion ?? 0) + 1;
  thread.context = null;
  thread.commands = [];
  ctx.emit('thread.commands', { threadId: thread.id, commands: [] });
  ctx.touch(thread);
}
