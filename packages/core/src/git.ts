/*
 * What git says about the thread's working directory: the status of the tree
 * and the two sides of one file. Both are reads, and both run git through
 * `core.procs` like every other process the core starts, so they appear in the
 * thread's trace rather than nowhere.
 *
 * The machine-readable formats are the ones that survive a path with a space,
 * a quote or a newline in it: `--porcelain=v1 -z` for the status, `--numstat
 * -z` for the numbers. Paths come back as git prints them, relative to the
 * repository root, which is the thread's working directory in every case but a
 * thread started in a subdirectory of its project.
 */

import { readFile } from 'node:fs/promises';
import { DIFF_MAX_BYTES } from '@boite/contracts';
import type { GitChange, GitChangeStatus, GitDiff, GitStatus, RpcParams, ThreadId } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf, refused } from './errors.ts';
import { hasNul, resolveInside, threadCwd } from './workdir.ts';

/** git answers 128 on anything it will not do here, a directory outside a repository first of all. */
const OUTSIDE_A_REPOSITORY = 128;

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(core: Core, threadId: ThreadId, cwd: string, args: string[]): Promise<GitRun> {
  let spawned;
  try {
    spawned = core.procs.spawn(threadId, 'git', args, { cwd });
  } catch (error) {
    throw refused(`git did not start (${messageOf(error)}): reading the changes needs git on PATH`, { args });
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(spawned.proc.stdout).text(),
    new Response(spawned.proc.stderr).text(),
    spawned.exited,
  ]);
  return { code, stdout, stderr };
}

/** The same, for a blob: `git show` hands back bytes, and whether they are text is the question. */
async function gitBytes(core: Core, threadId: ThreadId, cwd: string, args: string[]): Promise<{ code: number; data: Uint8Array }> {
  let spawned;
  try {
    spawned = core.procs.spawn(threadId, 'git', args, { cwd });
  } catch (error) {
    throw refused(`git did not start (${messageOf(error)}): reading a file at a ref needs git on PATH`, { args });
  }
  // Drained with the rest, so a git that has something to say never blocks on a full pipe.
  const [buffer, , code] = await Promise.all([
    new Response(spawned.proc.stdout).arrayBuffer(),
    new Response(spawned.proc.stderr).text(),
    spawned.exited,
  ]);
  return { code, data: new Uint8Array(buffer) };
}

function notARepository(threadId: ThreadId, stderr: string): never {
  const detail = stderr.trim().split('\n')[0] ?? '';
  throw refused(
    `the working directory of thread ${threadId} is not inside a git repository${detail.length === 0 ? '' : `: ${detail}`}`,
    { threadId },
  );
}

/** `## main...origin/main [ahead 1, behind 2]`, and the three shapes that are not that. */
export function parseBranchHeader(header: string): Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind'> {
  const rest = header.startsWith('## ') ? header.slice(3) : header;
  const tracking = /\s\[(.+)\]$/.exec(rest);
  const names = tracking === null ? rest : rest.slice(0, rest.length - tracking[0].length);
  const ahead = Number(/ahead (\d+)/.exec(tracking?.[1] ?? '')?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(tracking?.[1] ?? '')?.[1] ?? 0);
  // A repository with no commit yet names its branch in a sentence, and a
  // detached HEAD names no branch at all.
  const fresh = /^No commits yet on (.+)$/.exec(names);
  if (fresh !== null) return { branch: fresh[1] ?? null, upstream: null, ahead, behind };
  if (names.startsWith('HEAD (no branch)')) return { branch: null, upstream: null, ahead, behind };
  const [branch, upstream] = names.split('...');
  return { branch: branch === undefined || branch.length === 0 ? null : branch, upstream: upstream ?? null, ahead, behind };
}

function changeStatusOf(index: string, tree: string): GitChangeStatus {
  if (index === '?' && tree === '?') return 'untracked';
  if (index === 'U' || tree === 'U' || (index === 'A' && tree === 'A') || (index === 'D' && tree === 'D')) return 'conflict';
  const code = index !== ' ' && index !== '?' ? index : tree;
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  return 'modified';
}

/**
 * `git status --porcelain=v1 -z --branch`. Every record ends with a NUL, and a
 * rename carries its origin as the record right after it, the new path first:
 * that is what `-z` changes about the format, and why the arrow is gone.
 */
export function parseStatus(raw: string): GitStatus {
  const records = raw.split('\0').filter((record) => record.length > 0);
  const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, changes: [] };
  let at = 0;
  if (records[0]?.startsWith('##') === true) {
    Object.assign(status, parseBranchHeader(records[0]));
    at = 1;
  }
  while (at < records.length) {
    const record = records[at] as string;
    at += 1;
    if (record.length < 4) continue;
    const index = record[0] as string;
    const tree = record[1] as string;
    const path = record.slice(3);
    const renamed = index === 'R' || index === 'C' || tree === 'R' || tree === 'C';
    const oldPath = renamed ? (records[at] ?? null) : null;
    if (renamed) at += 1;
    status.changes.push({
      path,
      status: changeStatusOf(index, tree),
      oldPath,
      staged: index !== ' ' && index !== '?',
      additions: null,
      deletions: null,
    });
  }
  return status;
}

/**
 * `git diff --numstat -z`: `added<TAB>deleted<TAB>path`, and for a rename the
 * path field is empty and the two paths follow as their own records. A binary
 * file counts as `-`, which is the null the contract asks for.
 */
export function parseNumstat(raw: string): Map<string, { additions: number | null; deletions: number | null }> {
  const fields = raw.split('\0');
  const out = new Map<string, { additions: number | null; deletions: number | null }>();
  let at = 0;
  while (at < fields.length) {
    const field = fields[at] as string;
    at += 1;
    if (field.length === 0) continue;
    const parsed = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
    if (parsed === null) continue;
    const additions = parsed[1] === '-' ? null : Number(parsed[1]);
    const deletions = parsed[2] === '-' ? null : Number(parsed[2]);
    let path = parsed[3] ?? '';
    if (path.length === 0) {
      // A rename: the origin, then the destination, each its own record.
      path = fields[at + 1] ?? '';
      at += 2;
    }
    if (path.length > 0) out.set(path, { additions, deletions });
  }
  return out;
}

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

function checkRef(ref: string): string {
  if (typeof ref !== 'string' || ref.length === 0) throw refused('git.diff ref must be a revision', { ref: String(ref) });
  if (ref.startsWith('-') || /[\s\0:]/.test(ref)) throw refused(`git.diff refuses the ref ${ref}`, { ref });
  return ref;
}

function cut(data: Uint8Array): { text: string; truncated: boolean } {
  const truncated = data.length > DIFF_MAX_BYTES;
  return { text: new TextDecoder().decode(truncated ? data.subarray(0, DIFF_MAX_BYTES) : data), truncated };
}

/**
 * One file, the working tree against a ref. A side that does not exist there
 * is null rather than empty, which is how an added and a deleted file tell
 * themselves apart from a file that is genuinely empty.
 */
export async function gitDiff(core: Core, params: RpcParams<'git.diff'>): Promise<GitDiff> {
  const threadId = params.threadId;
  const cwd = threadCwd(core, threadId);
  const found = resolveInside(cwd, params.path, 'git.diff path');
  const ref = checkRef(params.ref === undefined || params.ref.length === 0 ? 'HEAD' : params.ref);

  // The whole status, not the path alone: git pairs a rename with its origin
  // only when it sees both sides, and the origin is the file to read at the ref.
  const status = await git(core, threadId, cwd, ['status', '--porcelain=v1', '-z']);
  if (status.code === OUTSIDE_A_REPOSITORY) notARepository(threadId, status.stderr);
  const change = parseStatus(status.stdout).changes.find((entry) => entry.path === found.relative) ?? null;

  // The status names paths from the repository root, which is what `<ref>:path`
  // takes; `<ref>:./path` is the same file named from the working directory,
  // for a file git has nothing to say about.
  const atRef = change?.oldPath ?? change?.path ?? `./${found.relative}`;
  const shown = await gitBytes(core, threadId, cwd, ['show', `${ref}:${atRef}`]);
  const old = shown.code === 0 ? shown.data : null;

  let current: Uint8Array | null = null;
  try {
    current = await readFile(found.absolute);
  } catch {
    current = null;
  }
  if (old === null && current === null) {
    throw refused(`git.diff has no file to read at ${params.path}, in the working tree or at ${ref}`, { path: params.path, ref });
  }

  const binary = (old !== null && hasNul(old)) || (current !== null && hasNul(current));
  const oldSide = old === null || binary ? null : cut(old);
  const newSide = current === null || binary ? null : cut(current);
  return {
    path: found.relative,
    oldPath: change?.oldPath ?? null,
    status: change?.status ?? (old === null ? 'added' : current === null ? 'deleted' : 'modified'),
    oldText: oldSide?.text ?? null,
    newText: newSide?.text ?? null,
    binary,
    truncated: (oldSide?.truncated ?? false) || (newSide?.truncated ?? false),
  };
}

export function registerGitMethods(core: Core): void {
  core.router.register('git.status', (params) => gitStatus(core, params.threadId));
  core.router.register('git.diff', (params) => gitDiff(core, params));
}
