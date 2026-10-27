import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DelegationWorktree, Project, ThreadId, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf, refused } from '../errors.ts';
import { BRANCH_PREFIX, worktreeRoot } from '../worktree.ts';

const KEY = 'delegation-worktree:';

/**
 * The git worktrees of delegated children. A child's branch and folder are
 * chosen when it is created, and the worktree itself is made from the
 * parent's HEAD (or the project's for a bot) just before a turn runs in it,
 * so spawning and launching a workflow step stay synchronous. When a turn ends,
 * a worktree with no commit beyond its base and no change goes with its branch; any other is kept for
 * the parent to merge. Records live in the settings table under the child.
 */
export class ChildWorktrees {
  private readonly settling = new Map<ThreadId, Promise<void>>();
  private closed = false;

  constructor(private readonly core: Core, private readonly changed: (threadId: ThreadId) => void) {}

  get(threadId: ThreadId): DelegationWorktree | undefined {
    return this.core.journal.getSetting(`${KEY}${threadId}`) as DelegationWorktree | undefined;
  }

  /** A turn has ended and the worktree is being looked at: a wait for its result goes on. */
  isSettling(threadId: ThreadId): boolean { return this.settling.has(threadId); }

  /** Called after turn and shared-job producers stop, while their journal is still open. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.settling.values()]);
  }

  private save(threadId: ThreadId, worktree: DelegationWorktree): void {
    this.core.journal.setSetting(`${KEY}${threadId}`, worktree);
  }

  /**
   * The branch and folder of a new child; nothing is made on disk yet. Refused
   * by name when the parent's project is not a git repository.
   */
  plan(parent: Pick<ThreadSummary, 'projectId'>, childId: ThreadId): DelegationWorktree {
    if (parent.projectId === null) throw refused('worktree: this conversation has no project; a worktree needs a git repository', { field: 'worktree', expected: 'a conversation in a git project' });
    const project = this.core.projects.require(parent.projectId);
    if (project.kind === 'drafts' || !existsSync(join(project.path, '.git'))) {
      throw refused(`worktree: ${project.path} is not a git repository; spawn without --worktree to share the checkout`, { field: 'worktree', path: project.path, expected: 'a git repository' });
    }
    const slug = `sub-${childId.slice(4, 14)}`;
    return { branch: `${BRANCH_PREFIX}${slug}`, path: join(worktreeRoot(project.path, this.core.settings.get().worktreeStorage, project.id), slug), base: null, state: 'pending' };
  }

  /** Written in the transaction that creates the child. */
  record(threadId: ThreadId, worktree: DelegationWorktree): void { this.save(threadId, worktree); }

  /**
   * Before a turn of a child: its worktree exists and it is marked in use.
   * Null when there is nothing to wait for, so other turns start as before.
   */
  enter(threadId: ThreadId, assertActive: () => void = () => {}): Promise<void> | null {
    const record = this.get(threadId);
    if (!record) return null;
    const settling = this.settling.get(threadId);
    if (!settling && (record.state === 'active' || record.state === 'kept') && existsSync(record.path)) {
      if (record.state === 'kept') this.mark(threadId, { ...record, state: 'active' });
      return null;
    }
    return (async () => {
      if (settling) await settling;
      await this.make(threadId, assertActive);
    })();
  }

  private mark(threadId: ThreadId, worktree: DelegationWorktree): void {
    const { error: _error, ...rest } = worktree;
    this.save(threadId, rest);
    this.changed(threadId);
  }

  private async make(threadId: ThreadId, assertActive: () => void): Promise<void> {
    const record = this.get(threadId);
    if (!record) return;
    const thread = this.core.threads.require(threadId);
    const parent = thread.parentThreadId ? this.core.journal.getThread(thread.parentThreadId) : null;
    if (!parent || thread.projectId === null) throw refused(`the subagent's worktree ${record.path} has no parent conversation to branch from`);
    const project = this.core.projects.require(thread.projectId);
    try {
      if ((record.state === 'active' || record.state === 'kept') && existsSync(record.path)) return this.mark(threadId, { ...record, state: 'active' });
      if (record.state === 'active' || record.state === 'kept') {
        // The folder went but the branch may hold work: check it out again as it is.
        await this.core.worktrees.ensure(threadId, project, record.branch, record.path);
        return this.mark(threadId, { ...record, state: 'active' });
      }
      if (record.state === 'pending' && record.base !== null) {
        await this.core.worktrees.resumePreparation(threadId, project, record.branch, record.path, record.base, assertActive);
        return this.mark(threadId, { ...record, state: 'active' });
      }
      const base = this.core.sharedCompute?.journal.worker(threadId)?.input.baseCommit ?? await this.core.worktrees.head(threadId, parent.projectId === thread.projectId ? parent.cwd : project.path);
      await this.core.worktrees.add(threadId, project, record.branch, record.path, {
        assertActive,
        beforeMutation: () => {
          this.save(threadId, { ...record, base, state: 'pending' });
          return () => this.save(threadId, record);
        },
      }, base);
      assertActive();
      this.mark(threadId, { branch: record.branch, path: record.path, base, state: 'active' });
    } catch (error) {
      this.save(threadId, { ...(this.get(threadId) ?? record), error: messageOf(error) });
      this.changed(threadId);
      throw refused(`could not make the subagent's worktree ${record.path} on ${record.branch}: ${messageOf(error)}`, { path: record.path, branch: record.branch });
    }
  }

  /**
   * After a turn of a child: a worktree with no commit beyond its base and no
   * change is removed with its branch; any other is kept. The same promise
   * serves every caller until it settles.
   */
  settle(threadId: ThreadId): Promise<void> | null {
    const running = this.settling.get(threadId);
    if (running) return running;
    if (this.closed) return null;
    const compute = this.core.sharedCompute?.journal.worker(threadId);
    if (compute?.stopping || compute && ['cancelled', 'revoked'].includes(compute.job.status)) return null;
    const record = this.get(threadId);
    if (!record || record.state !== 'active') return null;
    const job = this.inspect(threadId, record).finally(() => {
      this.settling.delete(threadId);
      this.changed(threadId);
    });
    this.settling.set(threadId, job);
    return job;
  }

  private async inspect(threadId: ThreadId, record: DelegationWorktree): Promise<void> {
    const thread = this.core.journal.getThread(threadId);
    try {
      if (!thread?.projectId || record.base === null) return this.save(threadId, { ...record, state: 'kept', error: 'its base commit is unknown' });
      if (!existsSync(record.path)) return this.save(threadId, { ...record, state: 'kept', error: 'its folder is gone; the branch stays' });
      const project: Project = this.core.projects.require(thread.projectId);
      const { commits, dirty } = await this.core.worktrees.changes(threadId, record.path, record.base);
      if (commits > 0 || dirty || this.core.sharedCompute?.journal.worker(threadId)) return this.save(threadId, { branch: record.branch, path: record.path, base: record.base, state: 'kept', commits, dirty });
      // A warm agent process keeps the folder as its working directory; Windows refuses to delete it then.
      this.core.threads.releaseAgent(threadId);
      const removed = await this.core.worktrees.remove(threadId, project, { branch: record.branch, path: record.path });
      this.save(threadId, removed
        ? { branch: record.branch, path: record.path, base: record.base, state: 'removed', commits: 0, dirty: false }
        : { ...record, state: 'kept', commits: 0, dirty: false, error: 'git could not remove it; the log says why' });
    } catch (error) {
      this.save(threadId, { ...record, state: 'kept', error: messageOf(error) });
    }
  }
}
