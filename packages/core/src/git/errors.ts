import type { ThreadId } from '@boite/contracts';
import { refused } from '../errors.ts';
import { gitSubcommand } from './git-log.ts';

/**
 * What git prints when the folder is in no repository. Its exit code, 128, is
 * also every other fatal error (a damaged index, a dubious owner, a lost
 * object), so only these words say the repository is what is missing.
 */
const OUTSIDE_A_REPOSITORY = /not a git repository/i;

function firstLine(stderr: string): string {
  return stderr.trim().split('\n')[0] ?? '';
}

export function notARepository(threadId: ThreadId, stderr: string): never {
  const detail = firstLine(stderr);
  throw refused(
    `the working directory of thread ${threadId} is not inside a git repository${detail.length === 0 ? '' : `: ${detail}`}`,
    { threadId },
  );
}

/** A git read that did not answer: outside a repository by name, anything else in git's own words. */
export function gitFailed(threadId: ThreadId, args: readonly string[], run: { code: number; stderr: string }): never {
  if (OUTSIDE_A_REPOSITORY.test(run.stderr)) notARepository(threadId, run.stderr);
  const subcommand = gitSubcommand(args);
  throw refused(`git ${subcommand} failed on thread ${threadId}: ${firstLine(run.stderr) || `exit ${run.code}`}`, { threadId, subcommand, code: run.code });
}
