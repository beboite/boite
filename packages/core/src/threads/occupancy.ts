import type { ThreadId, ThreadSummary } from '@boite/contracts';
import { recordHoldsCheckout } from '../checkouts.ts';
import type { Core } from '../core.ts';

/**
 * Whether a thread still uses its checkout, the one rule every worktree
 * removal applies at the moment it deletes. Archive is what the list shows, not
 * whether work runs: automatic Done moves a merged conversation away while its
 * agent finishes the prompt, sometimes in a runtime with no tracked process.
 * So an archived thread frees its checkout only once it is idle and neither it
 * nor its terminals run a process. A turn that ended in `error` rests like an
 * idle one. A deleted thread only needs the latter.
 */
export function occupiesCheckout(core: Core, thread: Pick<ThreadSummary, 'id' | 'archived' | 'status'> & { deleted?: boolean }): boolean {
  if (thread.deleted !== true && recordHoldsCheckout(thread)) return true;
  return core.procs.liveCount(thread.id as ThreadId) > 0 || core.terminals.threadProcesses(thread.id as ThreadId) > 0;
}
