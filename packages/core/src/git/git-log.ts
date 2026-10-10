import type { Core } from '../core.ts';

/** Subcommands whose non-zero exit is an answer ("no such ref"), not a failure. */
const PROBES = new Set(['rev-parse', 'symbolic-ref', 'cat-file', 'show-ref', 'merge-base', 'ls-files', 'check-ignore', 'diff']);
const SLOW_GIT_MS = 5_000;

/** The git subcommand, `worktree add` style for the two-word ones; never the arguments. */
export function gitSubcommand(args: readonly string[]): string {
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) index += args[index] === '-c' || args[index] === '-C' ? 2 : 1;
  const first = args[index] ?? 'unknown';
  const second = args[index + 1];
  return first === 'worktree' || first === 'stash' || first === 'remote' ? `${first} ${second && !second.startsWith('-') ? second : ''}`.trim() : first;
}

/**
 * One git run Boite started: worktree changes always, a failure with its
 * subcommand, exit code and the first line git printed on stderr, a slow
 * read when it took over five seconds. Arguments are never logged.
 */
export function logGit(core: Core, threadId: string | null, args: readonly string[], code: number, ms: number, stderr: string): void {
  const subcommand = gitSubcommand(args);
  const base = { source: 'git', ...(threadId === null || threadId.includes(':') ? {} : { threadId }), durationMs: ms };
  const cause = stderr.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)?.slice(0, 300) ?? null;
  if (code !== 0) {
    // A folder that is no repository is a state the panel shows, asked again on every refresh.
    const level = PROBES.has(subcommand.split(' ')[0]!) || /not a git repository/i.test(cause ?? '') ? 'debug' : 'warn';
    core.logs.record(level, `git ${subcommand} exited with code ${code} after ${Math.round(ms)} ms${cause ? `: ${cause}` : ''}`, { ...base, event: 'git.failed', data: { subcommand, exitCode: code, stderr: cause } });
    return;
  }
  if (subcommand === 'worktree add' || subcommand === 'worktree remove') {
    core.logs.info(`Worktree ${subcommand === 'worktree add' ? 'created' : 'removed'} in ${Math.round(ms)} ms`, { ...base, event: subcommand === 'worktree add' ? 'worktree.created' : 'worktree.removed', data: { subcommand } });
    return;
  }
  if (ms >= SLOW_GIT_MS) core.logs.debug(`git ${subcommand} took ${Math.round(ms / 100) / 10} s`, { ...base, event: 'git.slow', data: { subcommand } });
}
