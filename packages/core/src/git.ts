import type { GitStatus, ThreadId } from '@boite/contracts';
import type { Core } from './core.ts';
import { refused } from './errors.ts';
import { gitDiff } from './git/diff.ts';
import { notARepository, OUTSIDE_A_REPOSITORY } from './git/errors.ts';
import { parseNumstat, parseStatus } from './git/porcelain.ts';
import { git } from './git/read.ts';
import { threadCwd } from './workdir.ts';
export { gitDiff } from './git/diff.ts';
export { parseBranchHeader, parseNumstat, parseStatus } from './git/porcelain.ts';

export async function gitStatus(core: Core, threadId: ThreadId): Promise<GitStatus> {
  const cwd = threadCwd(core, threadId);
  const status = await git(core, threadId, cwd, ['status', '--porcelain=v1', '-z', '--branch']);
  if (status.code === OUTSIDE_A_REPOSITORY) notARepository(threadId, status.stderr);
  if (status.code !== 0) {
    throw refused(`git status failed on thread ${threadId}: ${status.stderr.trim() || `exit ${status.code}`}`, { threadId });
  }
  const parsed = parseStatus(status.stdout);
  // A repository with no commit has no HEAD to compare to: the paths are still
  // reported, without numbers, rather than failing the whole read.
  const numstat = await git(core, threadId, cwd, ['diff', '--numstat', '-z', 'HEAD']);
  const numbers = numstat.code === 0 ? parseNumstat(numstat.stdout) : new Map<string, { additions: number | null; deletions: number | null }>();
  for (const change of parsed.changes) {
    const counted = numbers.get(change.path);
    if (counted === undefined) continue;
    change.additions = counted.additions;
    change.deletions = counted.deletions;
  }
  return parsed;
}

export function registerGitMethods(core: Core): void {
  core.router.register('git.status', (params) => gitStatus(core, params.threadId));
  core.router.register('git.diff', (params) => gitDiff(core, params));
}
