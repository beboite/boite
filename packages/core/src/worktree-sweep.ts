/*
 * The worktrees a project's repository carries, and their removal. A person
 * reads the list and removes one at a time; `worktree-cleanup.ts` removes the
 * settled ones on its own through `removeSettled`, under the same refusals.
 * The list is what `git worktree list` reports, not what threads remember, so
 * a worktree whose thread was deleted, or one the user added by hand, shows
 * too. A removal refuses what would lose work unless the caller says `force`
 * or a merged pull request names the exact head, and never touches a worktree
 * a live thread stands in.
 */

import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Project, ProjectId, ThreadSummary, WorktreeEntry } from '@boite/contracts';
import type { Core } from './core.ts';
import { folderGone, invalidParams, messageOf, refused } from './errors.ts';
import { GIT_READ_TIMEOUT_MS } from './git/read.ts';

/**
 * How old a vanished worktree's registration must be before `prune` drops it.
 * Never a bare prune: a directory in the middle of a rename would lose its
 * registration under the thread working in it.
 */
const PRUNE_EXPIRE = '1.hour.ago';

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Listed {
  path: string;
  head: string | null;
  branch: string | null;
  main: boolean;
}

/** The trace id the sweep's git runs under: one per project, like `workspace:<id>` for a mission. */
function traceId(projectId: ProjectId): string {
  return `worktrees:${projectId}`;
}

/**
 * A path as it compares: absolute, native separators, no trailing separator,
 * and without case on Windows, where `D:\Dev` and `d:/dev` are one folder.
 */
export function keyOf(path: string): string {
  const full = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/**
 * The real path's key, so an 8.3 alias or a junction matches git's long form.
 * A folder already deleted resolves through its nearest parent that exists:
 * `/var/...` still meets git's `/private/var/...` on macOS.
 */
export async function realKey(path: string): Promise<string> {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return keyOf(join(await realpath(head), ...tail));
    } catch {
      const parent = dirname(head);
      if (parent === head) return keyOf(path);
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

export function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `git worktree list --porcelain -z`: one record per worktree, the main checkout first. */
export function parseWorktreeList(out: string): Listed[] {
  const entries: Listed[] = [];
  for (const block of out.split('\0\0')) {
    const fields = block.split('\0').filter((field) => field.length > 0);
    const location = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
    if (location === undefined) continue;
    const head = fields.find((field) => field.startsWith('HEAD '))?.slice('HEAD '.length) ?? null;
    const ref = fields.find((field) => field.startsWith('branch '))?.slice('branch '.length) ?? null;
    entries.push({
      path: resolve(location),
      head: head !== null && /^0+$/.test(head) ? null : head,
      branch: ref === null ? null : ref.replace(/^refs\/heads\//, ''),
      main: entries.length === 0 || fields.includes('bare'),
    });
  }
  return entries;
}

export class WorktreeSweep {
  constructor(private readonly core: Core) {}

  async list(projectId: ProjectId): Promise<WorktreeEntry[]> {
    const project = this.project(projectId);
    const listed = await this.listed(project);
    const own = await realKey(project.path);
    const holders = await this.holders();
    const entries: WorktreeEntry[] = [];
    for (const worktree of listed) {
      if (worktree.main || (await realKey(worktree.path)) === own) continue;
      entries.push(await this.describe(project, worktree, holders));
    }
    return entries;
  }

  async remove(params: { projectId: ProjectId; path: string; force?: boolean }): Promise<{ ok: true; branchDeleted: boolean }> {
    const { projectId, path, force } = params;
    if (typeof path !== 'string' || path.length === 0) {
      throw invalidParams('worktrees.remove path must be a non-empty string', { field: 'path', expected: 'a worktree of this project' });
    }
    if (force !== undefined && typeof force !== 'boolean') {
      throw invalidParams('worktrees.remove force must be a boolean', { field: 'force', expected: 'true, false or absent' });
    }
    const project = this.project(projectId);
    const listed = await this.listed(project);
    const wanted = await realKey(path);
    let target: Listed | undefined;
    for (const worktree of listed) {
      if ((await realKey(worktree.path)) === wanted) {
        target = worktree;
        break;
      }
    }
    if (target === undefined) {
      throw refused(`${path} is not a worktree git lists for ${project.name}`, {
        projectId, path, field: 'path', expected: 'a worktree of this project',
      });
    }
    if (target.main || wanted === (await realKey(project.path))) {
      throw refused(`${path} is the project's own checkout, not a worktree to remove`, {
        projectId, path, field: 'path', expected: 'a linked worktree, not the main checkout',
      });
    }
    const entry = await this.describe(project, target, await this.holders());
    this.refuseLive(project, path, entry);
    if (force !== true && (entry.dirty || entry.unmerged)) {
      const reasons = [
        ...(entry.dirty ? ['This worktree has uncommitted changes.'] : []),
        ...(entry.unmerged ? ['This worktree has commits on no other branch.'] : []),
      ];
      throw refused(reasons.join(' '), {
        projectId, path, dirty: entry.dirty, unmerged: entry.unmerged,
        field: 'force', expected: 'force: true, or a worktree with nothing to lose',
      });
    }
    const branchDeleted = await this.detach(project, path, target, force === true ? 'force' : 'merged-only');
    return { ok: true, branchDeleted };
  }

  /**
   * The automatic removal of `worktree-cleanup.ts`: `remove` without force,
   * read again at this moment. An unmerged head passes only when `merged`
   * names it, the head of a pull request GitHub says was merged (a squash or
   * rebase merge leaves those commits on no local branch). The branch then
   * goes only if it still points at that head and no other worktree has it.
   */
  async removeSettled(project: Project, path: string, merged: { sha: string; branch: string | null } | null): Promise<{ branch: string | null; branchDeleted: boolean }> {
    const listed = await this.listed(project);
    const wanted = await realKey(path);
    let target: Listed | undefined;
    for (const worktree of listed) if ((await realKey(worktree.path)) === wanted) target = worktree;
    if (target === undefined || target.main || wanted === (await realKey(project.path))) {
      throw refused(`${path} is not a linked worktree of ${project.name}`, { projectId: project.id, path });
    }
    const entry = await this.describe(project, target, await this.holders());
    this.refuseLive(project, path, entry);
    if (entry.missing) throw refused(`${path} is already gone`, { projectId: project.id, path });
    if (entry.dirty) throw refused('This worktree has uncommitted changes.', { projectId: project.id, path, dirty: true });
    const proof = merged !== null && target.head === merged.sha ? merged : null;
    if (entry.unmerged && proof === null) throw refused('This worktree has commits on no other branch.', { projectId: project.id, path, unmerged: true });
    const branchDeleted = await this.detach(project, path, target, proof ?? 'merged-only');
    return { branch: target.branch, branchDeleted };
  }

  private refuseLive(project: Project, path: string, entry: WorktreeEntry): void {
    if (entry.threadId === null || entry.threadArchived) return;
    throw refused(`thread "${entry.threadTitle}" (${entry.threadId}) works in ${path}: archive it first`, {
      projectId: project.id, path, threadId: entry.threadId, threadTitle: entry.threadTitle,
      field: 'path', expected: 'a worktree no live thread uses',
    });
  }

  /**
   * `git worktree remove`, the branch, then a prune. `merged-only` lets git
   * keep a branch it does not see merged (`branch -d`); `force` deletes it
   * (`branch -D`); a proof deletes it only while it still points at the
   * proved head (`update-ref -d` compares first) and no worktree has it.
   */
  private async detach(project: Project, path: string, target: Listed, branchRule: 'force' | 'merged-only' | { sha: string; branch: string | null }): Promise<boolean> {
    // A vanished directory loses its registration to the same unforced
    // `remove` (git 2.55 exits 0 on it); `prune --expire` would keep it for an hour.
    const removal = ['worktree', 'remove', ...(branchRule === 'force' ? ['--force'] : []), target.path];
    const removed = await this.git(project, project.path, removal);
    if (removed.code !== 0) {
      throw refused(`git worktree remove failed for ${path}: ${removed.stderr.trim() || `exit ${removed.code}`}`, { projectId: project.id, path });
    }
    let branchDeleted = false;
    if (target.branch !== null) {
      const deleted = typeof branchRule === 'string'
        ? await this.git(project, project.path, ['branch', branchRule === 'force' ? '-D' : '-d', target.branch])
        : await this.deleteProvedBranch(project, target.branch, branchRule);
      branchDeleted = deleted.code === 0;
      if (!branchDeleted) this.core.log('info', `kept the branch ${target.branch} after removing ${path}: ${deleted.stderr.trim() || `exit ${deleted.code}`}`);
    }
    const pruned = await this.git(project, project.path, ['worktree', 'prune', '--expire', PRUNE_EXPIRE]);
    if (pruned.code !== 0) this.core.log('warn', `git worktree prune failed in ${project.path}: ${pruned.stderr.trim() || `exit ${pruned.code}`}`);
    return branchDeleted;
  }

  private async deleteProvedBranch(project: Project, branch: string, proof: { sha: string; branch: string | null }): Promise<GitRun> {
    if (proof.branch !== branch) return { code: 1, stdout: '', stderr: `the merged pull request proved ${proof.branch ?? 'a detached head'}, not ${branch}` };
    const holder = (await this.listed(project)).find((worktree) => worktree.branch === branch);
    if (holder !== undefined) return { code: 1, stdout: '', stderr: `${branch} is checked out at ${holder.path}` };
    return this.git(project, project.path, ['update-ref', '-d', `refs/heads/${branch}`, proof.sha]);
  }

  private project(projectId: ProjectId): Project {
    if (typeof projectId !== 'string') throw invalidParams('projectId must be a string', { field: 'projectId', expected: 'a project id' });
    return this.core.projects.require(projectId);
  }

  async listed(project: Project): Promise<Listed[]> {
    // A `.git` folder, or the file a linked worktree has: the test `Worktrees.add` refuses on.
    if (!(await present(project.path))) throw folderGone(project.path, { field: 'projectId', projectId: project.id, project: project.name });
    if (!(await present(resolve(project.path, '.git')))) {
      throw refused(`${project.path} is not a git repository: it has no worktrees`, {
        projectId: project.id, path: project.path, field: 'projectId', expected: 'a project that is a git repository',
      });
    }
    const listed = await this.git(project, project.path, ['worktree', 'list', '--porcelain', '-z'], GIT_READ_TIMEOUT_MS);
    if (listed.code !== 0) throw refused(`cannot list worktrees in ${project.path}: ${listed.stderr.trim() || `exit ${listed.code}`}`, { projectId: project.id });
    return parseWorktreeList(listed.stdout);
  }

  /** Every thread by the real key of its folder, archived ones included. */
  async holders(): Promise<{ key: string; thread: ThreadSummary }[]> {
    const threads = this.core.threads.list({ includeArchived: true });
    return Promise.all(threads.map(async (thread) => ({ key: await realKey(thread.cwd), thread })));
  }

  async describe(project: Project, worktree: Listed, holders: { key: string; thread: ThreadSummary }[]): Promise<WorktreeEntry> {
    const missing = !(await exists(worktree.path));
    const key = await realKey(worktree.path);
    const standing = holders.filter((holder) => inside(key, holder.key)).map((holder) => holder.thread);
    const holder = standing.find((thread) => !thread.archived) ?? standing[0] ?? null;
    const [dirty, unmerged] = await Promise.all([
      missing ? Promise.resolve(false) : this.dirty(project, worktree.path),
      this.unmerged(project, worktree),
    ]);
    return {
      path: worktree.path,
      branch: worktree.branch,
      dirty,
      unmerged,
      missing,
      threadId: holder?.id ?? null,
      threadTitle: holder?.title ?? null,
      threadArchived: holder?.archived ?? false,
    };
  }

  async dirty(project: Project, path: string): Promise<boolean> {
    const status = await this.git(project, path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], GIT_READ_TIMEOUT_MS);
    if (status.code !== 0) throw refused(`git status failed in ${path}: ${status.stderr.trim() || `exit ${status.code}`}`, { projectId: project.id, path });
    return status.stdout.length > 0;
  }

  /** HEAD on no ref but the worktree's own branch. A worktree on an unborn branch has nothing to lose. */
  async unmerged(project: Project, worktree: Listed): Promise<boolean> {
    if (worktree.head === null) return false;
    const refs = await this.git(project, project.path, ['for-each-ref', '--format=%(refname)', '--contains', worktree.head, 'refs/heads/', 'refs/remotes/'], GIT_READ_TIMEOUT_MS);
    if (refs.code !== 0) throw refused(`git for-each-ref failed in ${project.path}: ${refs.stderr.trim() || `exit ${refs.code}`}`, { projectId: project.id });
    const own = worktree.branch === null ? null : `refs/heads/${worktree.branch}`;
    return !refs.stdout.split('\n').some((ref) => ref.length > 0 && ref !== own);
  }

  /**
   * Git through the launcher under the project's trace id. The reads carry
   * `GIT_OPTIONAL_LOCKS=0` and a deadline, so a status in a worktree an agent
   * is committing in takes no index lock; a removal has no deadline, since
   * deleting a large tree takes what it takes.
   */
  private async git(project: Project, cwd: string, args: string[], timeoutMs?: number): Promise<GitRun> {
    let spawned;
    try {
      spawned = this.core.procs.spawn(traceId(project.id), 'git', args, { cwd, ...(timeoutMs === undefined ? {} : { env: { GIT_OPTIONAL_LOCKS: '0' } }) });
    } catch (error) {
      throw refused(`git did not start in ${cwd} (${messageOf(error)}): the worktree list needs git on PATH`, { projectId: project.id, cwd });
    }
    const work = Promise.all([new Response(spawned.proc.stdout).text(), new Response(spawned.proc.stderr).text(), spawned.exited]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = timeoutMs === undefined ? null : new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        spawned.proc.kill();
        reject(refused(`git ${args[0] ?? ''} did not answer within ${timeoutMs / 1000} s in ${cwd}`, { projectId: project.id, cwd }));
      }, timeoutMs);
    });
    try {
      const [stdout, stderr, code] = await (late === null ? work : Promise.race([work, late]));
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function registerWorktreeMethods(core: Core, sweep: WorktreeSweep = new WorktreeSweep(core)): void {
  // Owner only, absent from DEVICE_METHODS: both name paths on the host, and a removal deletes a folder.
  core.router.register('worktrees.list', (params) => sweep.list(params.projectId));
  core.router.register('worktrees.remove', (params) => sweep.remove(params));
}
