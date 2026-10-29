/*
 * Removes the worktrees the core created once their work is settled. A
 * worktree goes when every thread standing in it has been archived (or done,
 * or deleted) for an hour, nothing in it is uncommitted, and either its head is
 * on another branch or a merged pull request names that exact head. The
 * removal itself is `WorktreeSweep.removeSettled`: the refusals of a manual
 * removal without force, read again at that moment.
 *
 * Only worktrees under a folder the core places them in are considered: the
 * project's `.boite/worktrees`, or the shared storage folder of that project.
 * A worktree no thread stands in also needs a `boite/` branch (or a detached
 * head), no draft reservation and an hour since git last touched it. Any
 * worktree stays while a live thread links an open pull request whose head is
 * its branch in a repository the project fetches from:
 * a delegated worker often runs from another folder and waits on CI there.
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Project, ThreadId, ThreadSummary, ThreadWorktreeRemoval } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf } from './errors.ts';
import { claimsBranch, openLinkedHeads, type LinkedHead } from './linked-pull-requests.ts';
import { occupiesCheckout } from './threads/occupancy.ts';
import { withLoad } from './threads/records.ts';
import { BRANCH_PREFIX, worktreeRoot } from './worktree.ts';
import { autoRemoveWorktreesKey, worktreeRemovalKey } from './worktree-cleanup-state.ts';
import { inside, realKey, WorktreeSweep, type Listed } from './worktree-sweep.ts';

/** How long every thread in a worktree must have been put away: Undo and second thoughts come first. */
export const SETTLED_GRACE_MS = 60 * 60_000;
const START_DELAY_MS = 5 * 60_000;
const INTERVAL_MS = 10 * 60_000;
/** Removals per pass: a backlog of a hundred worktrees drains over an hour, not in one burst of git. */
const PASS_REMOVALS = 8;
/** Merge proofs per pass: each can cost a GitHub call. */
const PASS_PROOFS = 8;
const PASS_BUDGET_MS = 120_000;
/** A worktree kept for a reason is looked at again after this, unless its head moved. */
const KEPT_FOR_MS = 60 * 60_000;

interface Holder {
  id: ThreadId;
  cwd: string;
  branch: string | null;
  key: string;
  archived: boolean;
  status: ThreadSummary['status'];
  /** When it was archived or deleted, null while it is visible. */
  settledAt: number | null;
  deleted: boolean;
}

/** Whether a branch is claimed, by the heads read at the pass's start or by `current`. */
type Claims = (branch: string, current?: readonly LinkedHead[]) => Promise<boolean>;

export interface WorktreeCleanupOptions {
  graceMs?: number;
  startDelayMs?: number;
  intervalMs?: number;
}

export interface WorktreeCleanupResult {
  projectId: string;
  path: string;
  reason: ThreadWorktreeRemoval['reason'];
  branch: string | null;
  branchDeleted: boolean;
}

export class WorktreeCleanup {
  readonly sweep: WorktreeSweep;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<WorktreeCleanupResult[]> | null = null;
  private closed = false;
  /** `<worktree key>\0<head>` to the time it may be looked at again. */
  private readonly kept = new Map<string, number>();
  private readonly graceMs: number;
  private readonly startDelayMs: number;
  private readonly intervalMs: number;

  constructor(private readonly core: Core, options: WorktreeCleanupOptions = {}) {
    this.sweep = new WorktreeSweep(core);
    this.graceMs = options.graceMs ?? SETTLED_GRACE_MS;
    this.startDelayMs = options.startDelayMs ?? START_DELAY_MS;
    this.intervalMs = options.intervalMs ?? INTERVAL_MS;
  }

  start(): void {
    const schedule = (delay: number): void => {
      if (this.closed) return;
      this.timer = setTimeout(() => {
        void this.run().finally(() => schedule(this.intervalMs));
      }, delay);
      this.timer.unref();
    };
    schedule(this.startDelayMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pending?.catch(() => undefined);
  }

  /** One pass, shared with a pass already under way. */
  run(): Promise<WorktreeCleanupResult[]> {
    if (this.closed || this.core.journal.isClosed()) return Promise.resolve([]);
    this.pending ??= this.pass().catch((error: unknown) => {
      this.core.log('warn', `worktree cleanup pass failed: ${messageOf(error)}`, { source: 'worktree-cleanup', event: 'worktrees.cleanupFailed' });
      return [];
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  private stopped(deadline: number): boolean {
    return this.closed || this.core.stopping || this.core.journal.isClosed() || Date.now() >= deadline;
  }

  private async pass(): Promise<WorktreeCleanupResult[]> {
    const deadline = Date.now() + PASS_BUDGET_MS;
    const budget = { removals: PASS_REMOVALS, proofs: PASS_PROOFS };
    const removed: WorktreeCleanupResult[] = [];
    const now = Date.now();
    for (const [key, until] of this.kept) if (until <= now) this.kept.delete(key);
    let holders: Holder[] | null = null;
    let heads: LinkedHead[] | null = null;
    for (const project of this.core.journal.listProjects()) {
      if (this.stopped(deadline) || budget.removals === 0) break;
      if (this.core.journal.getSetting(autoRemoveWorktreesKey(project.id)) === false) continue;
      // The drafts folder and plain folders have no worktrees; a missing folder has nothing to clean.
      if (!existsSync(join(project.path, '.git'))) continue;
      try {
        holders ??= await this.holders();
        heads ??= openLinkedHeads(this.core.journal);
        removed.push(...await this.project(project, holders, this.claims(project, heads), deadline, budget));
      } catch (error) {
        // A folder gone or a git that fails here says nothing about the other projects.
        this.core.log('info', `worktree cleanup skipped ${project.name}: ${messageOf(error)}`, { source: 'worktree-cleanup', event: 'worktrees.cleanupSkipped' });
      }
    }
    return removed;
  }

  /** The folders this project's worktrees are created in, the current shared one included. */
  private async roots(project: Project): Promise<string[]> {
    const storage = this.core.settings.get().worktreeStorage;
    const roots = [worktreeRoot(project.path)];
    if (storage?.mode === 'shared' && storage.directory) roots.push(worktreeRoot(project.path, storage, project.id));
    return Promise.all(roots.map(realKey));
  }

  /** Every thread, archived and deleted ones included, by the real key of its folder. */
  private async holders(): Promise<Holder[]> {
    return Promise.all(this.rows().map(async (row) => ({ ...row, key: await realKey(row.cwd) })));
  }

  /** The threads' rows as they are now. */
  private rows(): Omit<Holder, 'key'>[] {
    const query = `SELECT t.id, t.cwd, t.branch, t.status, t.archived, t.archived_at, t.updated_at, d.deleted_at
      FROM threads t LEFT JOIN thread_deletions d ON d.thread_id = t.id`;
    type Row = { id: ThreadId; cwd: string; branch: string | null; status: ThreadSummary['status']; archived: number; archived_at: number | null; updated_at: number; deleted_at: number | null };
    const rows = this.core.journal.db.query(query).all() as Row[];
    return rows.map((row) => ({
      id: row.id,
      cwd: row.cwd,
      branch: row.branch,
      archived: row.archived === 1,
      status: row.status,
      deleted: row.deleted_at !== null,
      // An archive written by an older core has no date of its own.
      settledAt: row.deleted_at ?? (row.archived ? row.archived_at ?? row.updated_at : null),
    }));
  }

  /**
   * Whether an open pull request a live conversation linked has this branch
   * of this project as its head: the same name in a repository the project
   * fetches from. The remotes are read once, and only for a name some head has.
   */
  private claims(project: Project, heads: readonly LinkedHead[]): Claims {
    let remotes: Promise<ReadonlySet<string> | null> | null = null;
    return async (branch, current = heads) => {
      if (!current.some((head) => head.branch === branch)) return false;
      remotes ??= this.sweep.fetched(project);
      return claimsBranch(current, branch, await remotes);
    };
  }

  private async project(project: Project, holders: Holder[], claimed: Claims, deadline: number, budget: { removals: number; proofs: number }): Promise<WorktreeCleanupResult[]> {
    const listed = await this.sweep.listed(project);
    const roots = await this.roots(project);
    const own = await realKey(project.path);
    const reserved = await Promise.all(this.core.drafts.reservedPaths().map(realKey));
    const done: WorktreeCleanupResult[] = [];
    for (const worktree of listed) {
      if (this.stopped(deadline) || budget.removals === 0) break;
      if (worktree.main) continue;
      const key = await realKey(worktree.path);
      if (key === own || !roots.some((root) => key !== root && inside(root, key))) continue;
      const memo = `${key}\0${worktree.head ?? ''}`;
      if (this.kept.has(memo)) continue;
      const standing = holders.filter((holder) => inside(key, holder.key));
      if (!(await this.settled(worktree, key, standing, reserved, claimed))) continue;
      const result = await this.settle(project, worktree, standing, claimed, budget);
      if (result === null) {
        this.kept.set(memo, Date.now() + KEPT_FOR_MS);
        continue;
      }
      budget.removals--;
      done.push(result);
    }
    return done;
  }

  /** Nothing live stands in it, and it has been that way long enough. */
  private async settled(worktree: Listed, key: string, standing: Holder[], reserved: string[], claimed: Claims): Promise<boolean> {
    const now = Date.now();
    if (reserved.some((path) => inside(key, path) || inside(path, key))) return false;
    if (worktree.branch !== null && await claimed(worktree.branch)) return false;
    if (standing.length > 0) {
      // Automatic Done may still have a prompt, including a runtime with no tracked process.
      return standing.every((holder) => !occupiesCheckout(this.core, holder) && holder.settledAt !== null && now - holder.settledAt >= this.graceMs);
    }
    // No thread: only a branch the core names, and not one a draft is about to adopt.
    if (worktree.branch !== null && !worktree.branch.startsWith(BRANCH_PREFIX)) return false;
    const touched = await lastTouched(worktree.path);
    return touched !== null && now - touched >= this.graceMs;
  }

  /** The removal when its work is proved safe, else null. */
  private async settle(project: Project, worktree: Listed, standing: Holder[], claimed: Claims, budget: { proofs: number }): Promise<WorktreeCleanupResult | null> {
    // The cheap reads first; `removeSettled` reads everything again before it removes.
    if (await this.sweep.dirty(project, worktree.path)) return null;
    let reason: ThreadWorktreeRemoval['reason'] = 'clean';
    let merged: { sha: string; branch: string | null; number: number; url: string } | null = null;
    if (await this.sweep.unmerged(project, worktree)) {
      if (budget.proofs === 0 || worktree.head === null || worktree.branch === null) return null;
      budget.proofs--;
      const owner = standing.find((holder) => !holder.deleted) ?? standing[0];
      try {
        const proof = await this.core.pullRequests.proveMerged({
          id: owner?.id ?? (`worktrees:${project.id}` as ThreadId),
          cwd: worktree.path,
          branch: owner?.branch ?? worktree.branch,
          projectId: project.id,
        });
        if (proof === null || proof.sha !== worktree.head) return null;
        merged = { sha: proof.sha, branch: proof.branch, number: proof.number, url: proof.url };
        reason = 'pr-merged';
      } catch {
        // No gh, no GitHub remote, a lookup that failed: the worktree waits for a later pass.
        return null;
      }
    }
    // A restore or a thread that arrived during the awaits above is one
    // `removeSettled` refuses: it checks every thread again as git deletes.
    if (worktree.branch !== null && await claimed(worktree.branch, openLinkedHeads(this.core.journal))) return null;
    let removal: { branch: string | null; branchDeleted: boolean };
    try {
      removal = await this.sweep.removeSettled(project, worktree.path, merged);
    } catch (error) {
      this.core.log('info', `kept the worktree ${worktree.path}: ${messageOf(error)}`, { source: 'worktree-cleanup', event: 'worktrees.kept' });
      return null;
    }
    const record: ThreadWorktreeRemoval = {
      path: worktree.path,
      branch: removal.branch,
      branchDeleted: removal.branchDeleted,
      reason,
      ...(merged ? { pullRequest: { number: merged.number, url: merged.url } } : {}),
      removedAt: Date.now(),
    };
    for (const holder of standing) {
      this.core.journal.setSetting(worktreeRemovalKey(holder.id), { ...record, path: holder.cwd });
      const thread: ThreadSummary | null = holder.deleted ? null : this.core.journal.getThread(holder.id);
      if (thread) this.core.bus.emit('thread.updated', withLoad(this.core, thread));
    }
    const why = merged ? `pull request #${merged.number} merged` : 'nothing left that another branch lacks';
    this.core.log('info', `removed the settled worktree ${worktree.path} (${why})${removal.branch ? `, branch ${removal.branch} ${removal.branchDeleted ? 'deleted' : 'kept'}` : ''}`, {
      source: 'worktree-cleanup', event: 'worktrees.removed', data: { projectId: project.id, reason, branchDeleted: removal.branchDeleted },
    });
    return { projectId: project.id, path: worktree.path, reason, branch: removal.branch, branchDeleted: removal.branchDeleted };
  }
}

/**
 * When git last wrote to the worktree: its `.git` file, or the HEAD, index or
 * HEAD log in its admin folder, which a checkout, a commit or a status refresh
 * moves. Null when the `.git` file cannot be read.
 */
async function lastTouched(path: string): Promise<number | null> {
  const marker = join(path, '.git');
  let newest: number;
  let admin: string | null = null;
  try {
    newest = (await stat(marker)).mtimeMs;
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(marker, 'utf8'))?.[1];
    if (gitdir) admin = resolve(path, gitdir);
  } catch {
    return null;
  }
  if (admin === null) return newest;
  for (const file of [join(admin, 'HEAD'), join(admin, 'index'), join(admin, 'logs', 'HEAD')]) {
    try {
      newest = Math.max(newest, (await stat(file)).mtimeMs);
    } catch { /* A worktree with no commit yet has no HEAD log. */ }
  }
  return newest;
}
