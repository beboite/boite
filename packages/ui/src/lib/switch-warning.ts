import type { ThreadSummary } from '@boite/contracts';

/** Past this many tokens a thread holds far more than a new session is handed. */
export const SWITCH_WARNING_TOKENS = 200_000;

/**
 * Another account means a new native session, which receives bounded excerpts
 * of the conversation (`docs/model-switching.md`), not what the old one held.
 * On a long thread that is most of it, so the user is asked first.
 */
export function switchDropsHistory(thread: Pick<ThreadSummary, 'accountId' | 'context'>, accountId: string): boolean {
  return accountId !== thread.accountId && (thread.context?.tokens ?? 0) > SWITCH_WARNING_TOKENS;
}
