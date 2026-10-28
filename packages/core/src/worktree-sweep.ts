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
import type { Project, ProjectId, ThreadId, ThreadSummary, WorktreeEntry } from '@boite/contracts';
import type { Core } from './core.ts';
import { folderGone, invalidParams, messageOf, refused } from './errors.ts';
import { git as readGit } from './git/read.ts';
import { inside, keyOf } from './checkouts.ts';
import { fetchedRepositories } from './pull-requests.ts';

export { inside, keyOf } from './checkouts.ts';
import { occupiesCheckout } from './threads/occupancy.ts';
import { withRegistration, worktreeRoot } from './worktree.ts';

/**
 * How many worktrees are described at once. Each costs a `git status` walk of
 * its tree and a `for-each-ref --contains`: CPU-bound reads that share the
 * core's git read slots with the panels.
 */
const DESCRIBE_AT_ONCE = 4;

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

/** `work` on every item, at most `limit` at once, the answers in the items' order. */
async function inOrder<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const at = next;
      next += 1;
      out[at] = await work(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
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

/** A thread found in a checkout, and whether it is a draft not sent yet, which only its processes make hold. */
interface Occupant { thread: ThreadSummary; draft: boolean }

export class WorktreeSweep {
  constructor(private readonly core: Core) {}

  async list(projectId: ProjectId): Promise<WorktreeEntry[]> {
    const project = this.project(projectId);
    const listed = await this.listed(project);
    const [own, keys, holders] = await Promise.all([
      realKey(project.path),
      Promise.all(listed.map((worktree) => realKey(worktree.path))),
      this.holders(project, listed),
    ]);
    const linked = listed.flatMap((worktree, at) => (worktree.main || keys[at] === own ? [] : [{ worktree, key: keys[at] as string }]));
    return inOrder(linked, DESCRIBE_AT_ONCE, ({ worktree, key }) => this.describe(project, worktree, key, holders));
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
    const keys = await Promise.all(listed.map((worktree) => realKey(worktree.path)));
    const target = listed.find((_, at) => keys[at] === wanted);
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
    this.refuseOccupied(project, path, await this.occupant(project, target.path));
    const entry = await this.describe(project, target, wanted, await this.holders(project, listed));
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
    this.refuseOccupied(project, path, await this.occupant(project, target.path));
    const entry = await this.describe(project, target, wanted, await this.holders(project, listed));
    if (entry.missing) throw refused(`${path} is already gone`, { projectId: project.id, path });
    if (entry.dirty) throw refused('This worktree has uncommitted changes.', { projectId: project.id, path, dirty: true });
    const proof = merged !== null && target.head === merged.sha ? merged : null;
    if (entry.unmerged && proof === null) throw refused('This worktree has commits on no other branch.', { projectId: project.id, path, unmerged: true });
    const branchDeleted = await this.detach(project, path, target, proof ?? 'merged-only');
    return { branch: target.branch, branchDeleted };
  }

  private refuseOccupied(project: Project, path: string, occupant: Occupant | null): void {
    if (occupant === null) return;
    const holder = occupant.thread;
    const why = occupant.draft ? 'is a draft whose agent still runs there: send it, or discard it and let it stop'
      : holder.archived ? 'is still running there: wait for it to finish' : 'works there: archive it first';
    throw refused(`thread "${holder.title}" (${holder.id}) ${why} (${path})`, {
      projectId: project.id, path, threadId: holder.id, threadTitle: holder.title,
      field: 'path', expected: 'a worktree no live thread uses',
    });
  }

  /**
   * The threads standing in a worktree, their folders resolved, as a check
   * that runs without awaiting: the first thread still using the checkout
   * (`occupiesCheckout`), null when none does, or `moved` when a thread arrived
   * or changed folder after the folders were resolved.
   */
  private async occupancy(project: Project, path: string): Promise<() => Occupant | null | 'moved'> {
    const key = await realKey(path);
    const near = this.near(project, [path]);
    // A draft's thread is in no list until it is sent, yet its agent may already run there.
    // Read again at each call: a draft sent meanwhile is a published thread, its row decides.
    const threads = (): Occupant[] => [
      ...this.core.threads.list({ includeArchived: true }).map((thread) => ({ thread, draft: false })),
      ...this.core.drafts.threads().map((thread) => ({ thread, draft: true })),
    ].filter(({ thread }) => thread.projectId === project.id || near(thread.cwd));
    const keys = new Map<string, string>();
    await Promise.all([...new Set(threads().map(({ thread }) => thread.cwd))].map(async (cwd) => { keys.set(cwd, await realKey(cwd)); }));
    return () => {
      let holder: Occupant | null = null;
      for (const occupant of threads()) {
        const { thread, draft } = occupant;
        const at = keys.get(thread.cwd);
        if (at === undefined) return 'moved';
        const holds = draft ? this.core.procs.liveCount(thread.id) > 0 : occupiesCheckout(this.core, thread);
        if (holder === null && inside(key, at) && holds) holder = occupant;
      }
      return holder;
    };
  }

  private async occupant(project: Project, path: string): Promise<Occupant | null> {
    for (;;) {
      const holder = (await this.occupancy(project, path))();
      if (holder !== 'moved') return holder;
    }
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
    // The one check every removal shares, made again at the moment git deletes:
    // no await between it and the spawn, so a thread restored or started during
    // the reads above keeps its checkout.
    const keys = [await realKey(target.path), await realKey(path)];
    const removed = await this.registered(project, async () => {
      for (;;) {
        const holder = (await this.occupancy(project, target.path))();
        if (holder === 'moved') continue;
        this.refuseOccupied(project, path, holder);
        // Reserved in the same step as the check, until git ends: a restore, a
        // new thread or a shell arriving meanwhile is refused, not deleted under.
        const release = this.core.worktrees.reservations.reserve(target.path, keys);
        try {
          return await this.git(project, project.path, removal);
        } finally { release(); }
      }
    });
    if (removed.code !== 0) {
      throw refused(`git worktree remove failed for ${path}: ${removed.stderr.trim() || `exit ${removed.code}`}`, { projectId: project.id, path });
    }
    let branchDeleted = false;
    if (target.branch !== null) {
      const deleted = typeof branchRule === 'string'
        ? await this.registered(project, () => this.git(project, project.path, ['branch', branchRule === 'force' ? '-D' : '-d', target.branch!]))
        : await this.deleteProvedBranch(project, target.branch, branchRule);
      branchDeleted = deleted.code === 0;
      if (!branchDeleted) this.core.log('info', `kept the branch ${target.branch} after removing ${path}: ${deleted.stderr.trim() || `exit ${deleted.code}`}`);
    }
    const pruned = await this.registered(project, () => this.git(project, project.path, ['worktree', 'prune', '--expire', PRUNE_EXPIRE]));
    if (pruned.code !== 0) this.core.log('warn', `git worktree prune failed in ${project.path}: ${pruned.stderr.trim() || `exit ${pruned.code}`}`);
    return branchDeleted;
  }

  private async deleteProvedBranch(project: Project, branch: string, proof: { sha: string; branch: string | null }): Promise<GitRun> {
    if (proof.branch !== branch) return { code: 1, stdout: '', stderr: `the merged pull request proved ${proof.branch ?? 'a detached head'}, not ${branch}` };
    // One locked section: `update-ref` does not refuse a branch a worktree has, so
    // no registration may take the branch back between the list and the deletion.
    return this.registered(project, async () => {
      const listed = await this.read(project, project.path, ['worktree', 'list', '--porcelain', '-z']);
      if (listed.code !== 0) return { code: listed.code, stdout: '', stderr: `cannot list worktrees: ${listed.stderr.trim() || `exit ${listed.code}`}` };
      const holder = parseWorktreeList(listed.stdout).find((worktree) => worktree.branch === branch);
      if (holder !== undefined) return { code: 1, stdout: '', stderr: `${branch} is checked out at ${holder.path}` };
      return this.git(project, project.path, ['update-ref', '-d', `refs/heads/${branch}`, proof.sha]);
    });
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
    const listed = await this.registered(project, () => this.read(project, project.path, ['worktree', 'list', '--porcelain', '-z']));
    if (listed.code !== 0) throw refused(`cannot list worktrees in ${project.path}: ${listed.stderr.trim() || `exit ${listed.code}`}`, { projectId: project.id });
    return parseWorktreeList(listed.stdout);
  }

  /**
   * The threads that may stand in one of these worktrees, archived ones
   * included, by the real key of their folder. Only those are resolved: the
   * project's own threads, and any whose folder as written lies in the
   * project, its worktree folder or a worktree git lists. Every thread in the
   * database went through `realpath` before, most of them in other projects.
   */
  async holders(project: Project, listed: readonly Listed[]): Promise<{ key: string; thread: ThreadSummary }[]> {
    const near = this.near(project, listed.map((worktree) => worktree.path));
    const threads = this.core.threads.list({ includeArchived: true }).filter((thread) => thread.projectId === project.id || near(thread.cwd));
    return Promise.all(threads.map(async (thread) => ({ key: await realKey(thread.cwd), thread })));
  }

  /** Whether a folder as written lies in the project, its worktree folder or one of `paths`. */
  private near(project: Project, paths: readonly string[]): (cwd: string) => boolean {
    const roots = new Set([project.path, worktreeRoot(project.path, this.core.settings.get().worktreeStorage, project.id), ...paths].map(keyOf));
    return (cwd) => {
      for (let at = keyOf(cwd); ; at = dirname(at)) {
        if (roots.has(at)) return true;
        if (dirname(at) === at) return false;
      }
    };
  }

  async describe(project: Project, worktree: Listed, key: string, holders: { key: string; thread: ThreadSummary }[]): Promise<WorktreeEntry> {
    const missing = !(await exists(worktree.path));
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

  /**
   * The repositories the project fetches from, as `host/owner/name`. Null
   * when git cannot say or names none that a pull request could live in.
   */
  async fetched(project: Project): Promise<ReadonlySet<string> | null> {
    const remotes = await this.read(project, project.path, ['remote', '-v']).catch(() => null);
    if (remotes === null || remotes.code !== 0) return null;
    const repositories = fetchedRepositories(remotes.stdout);
    return repositories.size > 0 ? repositories : null;
  }

  async dirty(project: Project, path: string): Promise<boolean> {
    const status = await this.read(project, path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    if (status.code !== 0) throw refused(`git status failed in ${path}: ${status.stderr.trim() || `exit ${status.code}`}`, { projectId: project.id, path });
    return status.stdout.length > 0;
  }

  /** HEAD on no ref but the worktree's own branch. A worktree on an unborn branch has nothing to lose. */
  async unmerged(project: Project, worktree: Listed): Promise<boolean> {
    if (worktree.head === null) return false;
    const refs = await this.read(project, project.path, ['for-each-ref', '--format=%(refname)', '--contains', worktree.head, 'refs/heads/', 'refs/remotes/']);
    if (refs.code !== 0) throw refused(`git for-each-ref failed in ${project.path}: ${refs.stderr.trim() || `exit ${refs.code}`}`, { projectId: project.id });
    const own = worktree.branch === null ? null : `refs/heads/${worktree.branch}`;
    return !refs.stdout.split('\n').some((ref) => ref.length > 0 && ref !== own);
  }

  /**
   * A read under the project's trace id, through the panels' reader: a
   * deadline, a shared slot, no index lock and no fsmonitor hook, so a status
   * in a worktree an agent is committing in takes no lock.
   */
  private read(project: Project, cwd: string, args: string[]): Promise<GitRun> {
    return readGit(this.core, traceId(project.id) as ThreadId, cwd, args, undefined, 'the worktree list');
  }

  /** A registration command of the project's repository, behind the gate `Worktrees.add` holds. */
  private registered<T>(project: Project, work: () => Promise<T>): Promise<T> {
    return withRegistration(project.path, work);
  }

  /** A change under the project's trace id. No deadline: deleting a large tree takes what it takes. */
  private async git(project: Project, cwd: string, args: string[]): Promise<GitRun> {
    let spawned;
    try {
      spawned = this.core.procs.spawn(traceId(project.id), 'git', args, { cwd });
    } catch (error) {
      throw refused(`git did not start in ${cwd} (${messageOf(error)}): the worktree list needs git on PATH`, { projectId: project.id, cwd });
    }
    const [stdout, stderr, code] = await Promise.all([new Response(spawned.proc.stdout).text(), new Response(spawned.proc.stderr).text(), spawned.exited]);
    return { code, stdout, stderr };
  }
}

export function registerWorktreeMethods(core: Core, sweep: WorktreeSweep = new WorktreeSweep(core)): void {
  // Owner only, absent from DEVICE_METHODS: both name paths on the host, and a removal deletes a folder.
  core.router.register('worktrees.list', (params) => sweep.list(params.projectId));
  core.router.register('worktrees.remove', (params) => sweep.remove(params));
}
