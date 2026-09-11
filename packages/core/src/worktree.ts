import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Project, ThreadId } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf, refused } from './errors.ts';

/** Every branch the core makes on its own starts with this. */
export const BRANCH_PREFIX = 'boite/';
const SLUG_MAX = 40;
/** How many `-2`, `-3` suffixes are tried before the title is refused as taken. */
const SUFFIX_MAX = 20;

/** The lowercase hyphenated form of a title: what names the branch and its directory. */
export function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : 'thread';
}

/**
 * Where a project's worktrees go: beside the repository, never inside it, so
 * the agent's own walk and the project's tooling never see them, and on the
 * same volume, because `git worktree add` across two disks costs ten times
 * more than beside the repository.
 */
export function worktreeRoot(projectPath: string): string {
  return join(dirname(projectPath), '.boite-worktrees', basename(projectPath));
}

export interface PlacedWorktree {
  branch: string;
  path: string;
}

/**
 * `git worktree add` for a thread that wants a branch of its own. The git
 * processes run under the thread's id, so the trace shows them like any
 * other. The worktree stays on disk when the thread is archived: the branch
 * may carry work nobody merged yet, and deleting it is a decision for a person.
 */
export class Worktrees {
  constructor(private readonly core: Core) {}

  async add(threadId: ThreadId, project: Project, title: string, wanted?: string): Promise<PlacedWorktree> {
    if (!existsSync(join(project.path, '.git'))) {
      throw refused(`${project.path} is not a git repository: a worktree needs one`, {
        projectId: project.id,
        path: project.path,
      });
    }
    if (wanted !== undefined && (wanted.trim().length === 0 || /\s/.test(wanted))) {
      throw refused(`"${wanted}" is not a branch name: no spaces, not empty`, { branch: wanted });
    }

    const root = worktreeRoot(project.path);
    const slug = wanted === undefined ? slugOf(title) : slugOf(wanted.startsWith(BRANCH_PREFIX) ? wanted.slice(BRANCH_PREFIX.length) : wanted);
    const tries = wanted === undefined ? SUFFIX_MAX : 1;
    for (let n = 1; n <= tries; n += 1) {
      const suffix = n === 1 ? '' : `-${n}`;
      const branch = wanted ?? `${BRANCH_PREFIX}${slug}${suffix}`;
      const path = join(root, `${slug}${suffix}`);
      if (await this.branchExists(threadId, project.path, branch)) {
        if (wanted !== undefined) throw refused(`branch ${branch} already exists in ${project.path}`, { branch, path: project.path });
        continue;
      }
      if (existsSync(path)) {
        if (wanted !== undefined) throw refused(`${path} already exists: pick another branch name`, { path, branch });
        continue;
      }
      const added = await this.git(threadId, project.path, ['worktree', 'add', '-b', branch, path]);
      if (added.code !== 0) {
        throw refused(`git worktree add failed in ${project.path}: ${added.stderr.trim() || `exit ${added.code}`}`, {
          path: project.path,
          branch,
          worktree: path,
        });
      }
      return { branch, path };
    }
    throw refused(`${SUFFIX_MAX} worktrees already carry the name ${slug}: rename the thread`, { slug, root });
  }

  private async branchExists(threadId: ThreadId, cwd: string, branch: string): Promise<boolean> {
    const result = await this.git(threadId, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return result.code === 0;
  }

  private async git(threadId: ThreadId, cwd: string, args: string[]): Promise<{ code: number; stderr: string }> {
    let spawned;
    try {
      spawned = this.core.procs.spawn(threadId, 'git', args, { cwd });
    } catch (error) {
      throw refused(`git did not start (${messageOf(error)}): a worktree needs git on PATH`, { cwd, args });
    }
    const [stderr, code] = await Promise.all([new Response(spawned.proc.stderr).text(), spawned.exited]);
    // stdout is piped by the registry; drained so a chatty git never blocks on it.
    await new Response(spawned.proc.stdout).text();
    return { code, stderr };
  }
}
