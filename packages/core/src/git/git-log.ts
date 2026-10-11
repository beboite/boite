import type { Core } from '../core.ts';

/** Subcommands whose non-zero exit is an answer ("no such ref"), not a failure. */
const PROBES = new Set(['rev-parse', 'symbolic-ref', 'show-ref', 'merge-base', 'check-ignore']);
/** These answer only when asked to: `cat-file -e`/`-s`, `diff --quiet`, `ls-files --error-unmatch`; a content read that fails is a failure. */
const PROBE_FLAGS: Record<string, readonly string[]> = { 'cat-file': ['-e', '-s'], diff: ['--quiet', '--exit-code'], 'ls-files': ['--error-unmatch'] };

function probes(subcommand: string, args: readonly string[]): boolean {
  return PROBES.has(subcommand) || (PROBE_FLAGS[subcommand]?.some(flag => args.includes(flag)) ?? false);
}
const SLOW_GIT_MS = 5_000;

/** The git subcommand, `worktree add` style for the two-word ones; never the arguments. */
export function gitSubcommand(args: readonly string[]): string {
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) index += args[index] === '-c' || args[index] === '-C' ? 2 : 1;
  const first = args[index] ?? 'unknown';
  const second = args[index + 1];
  return first === 'worktree' || first === 'stash' || first === 'remote' ? `${first} ${second && !second.startsWith('-') ? second : ''}`.trim() : first;
}

/** Git runs for a scope rather than a conversation (`system:...`, `project:...`) carry a colon: those name no thread. */
export function gitThread(threadId: string | null): { threadId?: string } {
  return threadId === null || threadId.includes(':') ? {} : { threadId };
}

/**
 * One git run Boite started: worktree changes always, a failure with its
 * subcommand, exit code and the first line git printed on stderr, a slow
 * read when it took over five seconds. Arguments are never logged.
 */
export function logGit(core: Core, threadId: string | null, args: readonly string[], code: number, ms: number, stderr: string): void {
  const subcommand = gitSubcommand(args);
  const base = { source: 'git', ...gitThread(threadId), durationMs: ms };
  const cause = stderr.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)?.slice(0, 300) ?? null;
  if (code !== 0) {
    // A folder that is no repository is a state the panel shows, asked again on every refresh.
    const level = probes(subcommand.split(' ')[0]!, args) || /not a git repository/i.test(cause ?? '') ? 'debug' : 'warn';
    core.logs.record(level, `git ${subcommand} exited with code ${code} after ${Math.round(ms)} ms${cause ? `: ${cause}` : ''}`, { ...base, event: 'git.failed', data: { subcommand, exitCode: code, stderr: cause } });
    return;
  }
  if (subcommand === 'worktree add' || subcommand === 'worktree remove') {
    core.logs.info(`Worktree ${subcommand === 'worktree add' ? 'created' : 'removed'} in ${Math.round(ms)} ms`, { ...base, event: subcommand === 'worktree add' ? 'worktree.created' : 'worktree.removed', data: { subcommand } });
    return;
  }
  if (ms >= SLOW_GIT_MS) core.logs.debug(`git ${subcommand} took ${Math.round(ms / 100) / 10} s`, { ...base, event: 'git.slow', data: { subcommand } });
}
