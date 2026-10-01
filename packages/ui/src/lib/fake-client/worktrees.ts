/**
 * A project's worktrees and their removal, after `packages/core/src/worktree-sweep.ts`.
 * No git here: `ctx.worktrees` is what `git worktree list` would report, with
 * what the core would read off each one, and the thread standing in it is
 * found by its `cwd` like the core finds it.
 */
import { RpcErrorCode, type Project, type Thread, type ThreadId, type WorktreeEntry } from '@boite/contracts';
import { RpcFailure } from '../client';
import { pathKey } from './checks';
import { folderGone } from './project-archive';
import { T0 } from './shared';
import type { FakeContext, FakeMethods } from './context';

/** One registration git would list, and what the core would find there. */
export interface FakeWorktree {
  projectId: string;
  path: string;
  branch: string | null;
  dirty: boolean;
  unmerged: boolean;
  missing: boolean;
  /**
   * Whether `git branch -d` would take the branch once the worktree is gone.
   * False for one whose commits sit on another branch that is not merged into
   * HEAD: not unmerged, but git keeps it and `branchDeleted` says so.
   */
  branchMerged: boolean;
}

const BOITE_ROOT = 'C:\\src\\.boite-worktrees\\boite';

/**
 * The seeded registrations: one clean, one dirty, one unmerged, one gone, one
 * the user made by hand outside the core's folder, one a live thread works in
 * and one an archived thread left behind.
 */
export function seedWorktrees(): FakeWorktree[] {
  const base = { dirty: false, unmerged: false, missing: false, branchMerged: true };
  return [
    // `t-scheduler`, waiting on a question: held, whatever `force` says.
    { ...base, projectId: 'p-boite', path: `${BOITE_ROOT}\\port-the-scheduler`, branch: 'boite/port-the-scheduler', dirty: true },
    // `t-parser`, archived: removable, and its commits are nowhere else.
    { ...base, projectId: 'p-boite', path: `${BOITE_ROOT}\\rework-the-parser`, branch: 'boite/rework-the-parser', unmerged: true },
    { ...base, projectId: 'p-boite', path: `${BOITE_ROOT}\\fix-the-login`, branch: 'boite/fix-the-login' },
    { ...base, projectId: 'p-boite', path: `${BOITE_ROOT}\\try-a-bigger-cache`, branch: 'boite/try-a-bigger-cache', dirty: true },
    { ...base, projectId: 'p-boite', path: `${BOITE_ROOT}\\spike-the-tray`, branch: 'boite/spike-the-tray', unmerged: true },
    { ...base, projectId: 'p-boite', path: `${BOITE_ROOT}\\old-bench`, branch: 'boite/old-bench', missing: true },
    { ...base, projectId: 'p-boite', path: 'C:\\src\\boite-release', branch: 'release/2.0', branchMerged: false },
    { ...base, projectId: 'p-notes', path: 'C:\\src\\.boite-worktrees\\notes\\sort-the-journal', branch: 'boite/sort-the-journal' }
  ];
}

/** The archived thread whose worktree `seedWorktrees` keeps: last touched two days before the seed. */
export function seedArchivedThread(): Thread {
  const at = T0 - 2 * 86_400_000;
  return {
    id: 't-parser', projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null,
    permissionMode: 'default', archived: true, pinned: false, title: 'Rework the parser', titleSource: 'prompt',
    cwd: `${BOITE_ROOT}\\rework-the-parser`, branch: 'boite/rework-the-parser', status: 'idle', unread: false,
    sessionId: null, load: null, context: null, createdAt: at, updatedAt: at, messagesBefore: null, commands: [],
    turns: [], messages: []
  };
}

/** What `git worktree add` leaves behind a thread the fake placed in one: a clean registration. */
export function registerFakeWorktree(ctx: FakeContext, projectId: string, placed: { path: string; branch: string }): void {
  ctx.removedWorktrees.delete(pathKey(placed.path));
  if (ctx.worktrees.some((entry) => pathKey(entry.path) === pathKey(placed.path))) return;
  ctx.worktrees.push({ projectId, path: placed.path, branch: placed.branch, dirty: false, unmerged: false, missing: false, branchMerged: true });
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

/**
 * The core's `requireCwd` in `threads/rpc.ts`: a thread whose worktree was
 * removed is refused by its folder on its next turn. A folder the fake never
 * removed is taken to exist.
 */
export function requireFakeCwd(ctx: FakeContext, thread: Thread): void {
  if (thread.archived) return;
  const key = pathKey(thread.cwd);
  if (![...ctx.removedWorktrees, ...ctx.goneFolders].some((removed) => inside(removed, key))) return;
  throw new RpcFailure({
    code: RpcErrorCode.Refused,
    message: `the folder ${thread.cwd} this thread works in does not exist any more: its worktree was removed or the folder moved`,
    data: { threadId: thread.id, cwd: thread.cwd, field: 'cwd', expected: 'an existing folder' }
  });
}

function refused(message: string, data: Record<string, unknown>): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message, data });
}

function repository(ctx: FakeContext, projectId: string): Project {
  const project = ctx.projects.find((p) => p.id === projectId);
  if (!project) throw ctx.notFound('project', projectId);
  if (ctx.goneFolders.has(pathKey(project.path))) throw folderGone(project.path, { field: 'projectId', projectId, project: project.name });
  if (project.repository === false) {
    throw refused(`${project.path} is not a git repository: it has no worktrees`, {
      projectId, path: project.path, field: 'projectId', expected: 'a project that is a git repository'
    });
  }
  return project;
}

function describe(ctx: FakeContext, worktree: FakeWorktree): WorktreeEntry {
  const key = pathKey(worktree.path);
  const standing = [...ctx.threads.values()].filter((thread) => inside(key, pathKey(thread.cwd)));
  const holder = standing.find((thread) => !thread.archived) ?? standing[0] ?? null;
  return {
    path: worktree.path,
    branch: worktree.branch,
    dirty: worktree.missing ? false : worktree.dirty,
    unmerged: worktree.unmerged,
    missing: worktree.missing,
    threadId: (holder?.id ?? null) as ThreadId | null,
    threadTitle: holder?.title ?? null,
    threadArchived: holder?.archived ?? false
  };
}

export function worktreeMethods(ctx: FakeContext) {
  return {
    'worktrees.list': async (params) => {
      const project = repository(ctx, params.projectId);
      return ctx.worktrees
        .filter((entry) => entry.projectId === project.id && pathKey(entry.path) !== pathKey(project.path))
        .map((entry) => describe(ctx, entry));
    },
    'worktrees.remove': async (params) => {
      const { projectId, path, force } = params;
      if (typeof path !== 'string' || path.length === 0) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'worktrees.remove path must be a non-empty string', data: { field: 'path', expected: 'a worktree of this project' } });
      }
      if (force !== undefined && typeof force !== 'boolean') {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'worktrees.remove force must be a boolean', data: { field: 'force', expected: 'true, false or absent' } });
      }
      const project = repository(ctx, projectId);
      if (pathKey(path) === pathKey(project.path)) {
        throw refused(`${path} is the project's own checkout, not a worktree to remove`, {
          projectId, path, field: 'path', expected: 'a linked worktree, not the main checkout'
        });
      }
      const target = ctx.worktrees.find((entry) => entry.projectId === project.id && pathKey(entry.path) === pathKey(path));
      if (!target) {
        throw refused(`${path} is not a worktree git lists for ${project.name}`, {
          projectId, path, field: 'path', expected: 'a worktree of this project'
        });
      }
      const entry = describe(ctx, target);
      if (entry.threadId !== null && !entry.threadArchived) {
        throw refused(`thread "${entry.threadTitle}" (${entry.threadId}) works in ${path}: archive it first`, {
          projectId, path, threadId: entry.threadId, threadTitle: entry.threadTitle,
          field: 'path', expected: 'a worktree no live thread uses'
        });
      }
      if (force !== true && (entry.dirty || entry.unmerged)) {
        const reasons = [
          ...(entry.dirty ? ['This worktree has uncommitted changes.'] : []),
          ...(entry.unmerged ? ['This worktree has commits on no other branch.'] : [])
        ];
        throw refused(reasons.join(' '), {
          projectId, path, dirty: entry.dirty, unmerged: entry.unmerged,
          field: 'force', expected: 'force: true, or a worktree with nothing to lose'
        });
      }
      ctx.worktrees = ctx.worktrees.filter((candidate) => candidate !== target);
      ctx.removedWorktrees.add(pathKey(target.path));
      return { ok: true as const, branchDeleted: target.branch !== null && (force === true || target.branchMerged) };
    }
  } satisfies Partial<FakeMethods>;
}
