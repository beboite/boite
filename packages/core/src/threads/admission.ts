import type { ComposerChoice, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';

/**
 * Why a turn on `thread`, run with the selection `choice` an input was queued
 * with, cannot be accepted, or null. `threads.startTurn` and the composer's
 * outbox (`composer.ts`) both ask it, so an input the outbox holds carries the
 * refusal a direct start gives.
 */
export function admissionRefusal(core: Core, thread: ThreadSummary, choice?: ComposerChoice): string | null {
  if (thread.archived) return 'cannot start a turn on an archived thread';
  if (choice === undefined) return null;
  const account = core.accounts.require(choice.accountId);
  if (core.providers.get(choice.providerId) === undefined || account.providerId !== choice.providerId || account.status === 'unauthenticated') {
    return 'the queued account is unavailable; choose an account and enqueue this input again';
  }
  return null;
}
