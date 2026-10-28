import type { Project, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { removeDir } from '../fs-retry.ts';
import { logMessageOf } from '../log-errors.ts';

const SETTING = 'draftReservationOwnership';
export const DRAFT_CLEANUP_TIMEOUT_MS = 10_000;

/** Private intent written before the first mutation, never a visible conversation. */
export interface DraftOwnership {
  threadId: ThreadId;
  project: Project;
  path: string;
  branch: string | null;
  kind: 'draft' | 'incognito' | 'worktree';
}

export type BeforeDraftMutation = ((ownership: DraftOwnership) => (() => void) | void) & { assertActive?: (threadId: ThreadId) => void };

export class DraftReservationLedger {
  constructor(private readonly core: Core) {}

  list(): DraftOwnership[] {
    return (this.core.journal.getSetting(SETTING) as DraftOwnership[] | undefined) ?? [];
  }

  record(ownership: DraftOwnership): () => void {
    this.core.journal.setSetting(SETTING, [...this.list().filter(item => item.threadId !== ownership.threadId), ownership]);
    return () => this.forget(ownership.threadId);
  }

  forget(threadId: ThreadId): void {
    const remaining = this.list().filter(item => item.threadId !== threadId);
    if (remaining.length) this.core.journal.setSetting(SETTING, remaining);
    else this.core.journal.deleteSetting(SETTING);
  }

  /** Publication wins, including a crash after journal commit but before intent removal. */
  async cleanup(ownership: DraftOwnership): Promise<boolean> {
    try {
      // A stop request can leave the agent alive during its native termination grace.
      // Keep both its folder and durable ownership until its actual exit is recorded.
      await this.core.procs.waitForExit(ownership.threadId);
    } catch (error) {
      this.core.log('warn', `draft cleanup retained for ${ownership.path}: ${logMessageOf(error)}`);
      return false;
    }
    if (this.core.journal.getThread(ownership.threadId)) {
      this.forget(ownership.threadId);
      return true;
    }
    // A failed exclusive mkdir can revoke its intent: the competing folder is not ours.
    if (!this.list().some(item => item.threadId === ownership.threadId && item.path === ownership.path)) return true;
    try {
      const removed = ownership.kind === 'worktree' && ownership.branch
        ? await this.core.worktrees.remove(ownership.threadId, ownership.project, { path: ownership.path, branch: ownership.branch }, DRAFT_CLEANUP_TIMEOUT_MS)
        : await removeDir(ownership.path, message => this.core.log('warn', message));
      if (removed) this.forget(ownership.threadId);
      return removed;
    } catch (error) {
      this.core.log('warn', `draft cleanup retained for ${ownership.path}: ${logMessageOf(error)}`);
      return false;
    }
  }

  async recover(): Promise<void> {
    // Sequential so a crash backlog never starts one git process per stored intent.
    for (const ownership of this.list()) await this.cleanup(ownership);
  }
}
