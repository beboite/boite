import type { Account, Thread } from '@boite/contracts';
import type { FakeContext } from './context';
import { modelsOf } from './provider-catalog';

// The core's `threads/account-fallback.ts`: a conversation follows its agent,
// not one login, so a signed-out or removed account hands it to another.

const RANK: Record<Account['status'], number> = { ok: 0, unknown: 1, error: 2, unauthenticated: 3 };

/** `preferred` while it exists and can run, else the provider's best other account signed in. */
export function usableAccount(ctx: FakeContext, providerId: string, preferred: string): Account | null {
  const own = ctx.accounts.find((account) => account.id === preferred);
  if (own && own.providerId === providerId && own.status !== 'unauthenticated') return own;
  return ctx.accounts
    .filter((account) => account.providerId === providerId && account.id !== preferred && account.status !== 'unauthenticated')
    .sort((a, b) => RANK[a.status] - RANK[b.status])[0] ?? null;
}

/** The thread on another account of its provider: the model it lists stays, the native session goes. */
export function moveToAccount(ctx: FakeContext, thread: Thread, account: Account): void {
  const listed = modelsOf(ctx, account.providerId, account.id).find((model) => model.id === thread.model);
  if (thread.background?.length) ctx.setBackground(thread, [], 'session-ended');
  thread.accountId = account.id;
  thread.providerId = account.providerId;
  if (!listed?.effort?.levels.some((level) => level.id === thread.effort)) thread.effort = null;
  if (!listed?.speeds?.some((speed) => speed.id === thread.speed)) thread.speed = null;
  thread.sessionId = null;
  thread.sessionGeneration = (thread.sessionGeneration ?? 0) + 1;
  thread.selectionVersion = (thread.selectionVersion ?? 0) + 1;
  thread.context = null;
  thread.commands = [];
  ctx.emit('thread.commands', { threadId: thread.id, commands: [] });
  ctx.touch(thread);
}
