import type { ThreadId } from '@boite/contracts';
import { DIFF_MAX_BYTES } from '@boite/contracts';
import { constants, existsSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, readlink } from 'node:fs/promises';
import type { Core } from '../core.ts';
import { folderGone, messageOf, refused } from '../errors.ts';
import { gitSubcommand, logGit } from './git-log.ts';

/**
 * What one side of a diff may weigh before it is refused outright. Well past
 * `DIFF_MAX_BYTES`, which is what the cut side shows: this is the point where
 * holding the bytes at all is the problem, not what the panel can render.
 */
export const SIDE_CEILING_BYTES = 16 * 1024 * 1024;

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** How long a read may take before its git is stopped and the panel told. */
export const GIT_READ_TIMEOUT_MS = 30_000;

/**
 * A git that only reads. `GIT_OPTIONAL_LOCKS=0` keeps `git status` from
 * refreshing the index under `index.lock`, which made an agent's own
 * `git add` or `git commit` in the same checkout fail; it reaches any git
 * that git starts itself, too. `core.fsmonitor=` on the command line wins
 * over the user's gitconfig, so a monitor hook there cannot run during a read.
 */
function spawnRead(core: Core, threadId: ThreadId, cwd: string, args: string[], needs: string) {
  try {
    return core.procs.spawn(threadId, 'git', ['-c', 'core.fsmonitor=', ...args], { cwd, env: { GIT_OPTIONAL_LOCKS: '0' } });
  } catch (error) {
    // A spawn in a folder that is gone fails with the same ENOENT as a git that is not installed.
    if (!existsSync(cwd)) throw folderGone(cwd, { threadId, field: 'cwd' });
    throw refused(`git did not start (${messageOf(error)}): ${needs} needs git on PATH`, { args });
  }
}

/**
 * Waits for `work`, and stops that one git by its own process when it has not
 * answered in time: the thread's other processes are the agent's, never touched.
 */
async function bounded<T>(spawned: { proc: { kill(): void } }, cwd: string, args: string[], work: Promise<T>, timeoutMs = GIT_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      spawned.proc.kill();
      reject(refused(`git ${args[0] ?? ''} did not answer within ${timeoutMs / 1000} s in ${cwd}`, { args, cwd }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function git(core: Core, threadId: ThreadId, cwd: string, args: string[], timeoutMs = GIT_READ_TIMEOUT_MS): Promise<GitRun> {
  const spawned = spawnRead(core, threadId, cwd, args, 'reading the changes');
  const at = performance.now();
  const [stdout, stderr, code] = await bounded(spawned, cwd, args, Promise.all([
    new Response(spawned.proc.stdout).text(),
    new Response(spawned.proc.stderr).text(),
    spawned.exited,
  ]), timeoutMs).catch((error: unknown) => { logGitTimeout(core, threadId, args, timeoutMs, at); throw error; });
  logGit(core, threadId, args, code, performance.now() - at, stderr);
  return { code, stdout, stderr };
}

/** A git read stopped at its deadline, under the same thread rule as `logGit`. */
function logGitTimeout(core: Core, threadId: ThreadId, args: readonly string[], timeoutMs: number, at: number): void {
  core.logs.warn(`git ${gitSubcommand(args)} gave no answer within ${timeoutMs / 1000} s and was stopped`, {
    source: 'git', event: 'git.timeout', ...(threadId.includes(':') ? {} : { threadId }), durationMs: performance.now() - at, data: { subcommand: gitSubcommand(args), timeoutMs },
  });
}

/** The same, for a blob: `git show` hands back bytes, and whether they are text is the question. */
async function gitBytes(core: Core, threadId: ThreadId, cwd: string, args: string[]): Promise<{ code: number; data: Uint8Array }> {
  const spawned = spawnRead(core, threadId, cwd, args, 'reading a file at a ref');
  const at = performance.now();
  // Drained with the rest, so a git that has something to say never blocks on a full pipe.
  const [buffer, stderr, code] = await bounded(spawned, cwd, args, Promise.all([
    new Response(spawned.proc.stdout).arrayBuffer(),
    new Response(spawned.proc.stderr).text(),
    spawned.exited,
  ])).catch((error: unknown) => { logGitTimeout(core, threadId, args, GIT_READ_TIMEOUT_MS, at); throw error; });
  logGit(core, threadId, args, code, performance.now() - at, stderr);
  return { code, data: new Uint8Array(buffer) };
}

/**
 * A missing blob is null, distinct from an empty file. Resolve the revision
 * once so its size and content always refer to the same immutable object.
 */
export async function readRefSide(core: Core, threadId: ThreadId, cwd: string, ref: string, atRef: string): Promise<DiffSide> {
  // `git show` buffers the whole blob before anything is cut, so the size is
  // asked for first and an absurd one is never loaded at all. The name is
  // resolved to the blob's own id before either call: a branch that moves
  // between them would otherwise size one object and read another.
  const resolved = await git(core, threadId, cwd, ['rev-parse', '--verify', '--quiet', `${ref}:${atRef}`]);
  const blob = resolved.code === 0 ? resolved.stdout.trim() : '';
  const sized = blob.length > 0 ? await git(core, threadId, cwd, ['cat-file', '-s', blob]) : null;
  const blobBytes = sized !== null && sized.code === 0 ? Number(sized.stdout.trim()) : null;
  const refSideTooBig = blobBytes !== null && Number.isFinite(blobBytes) && blobBytes > SIDE_CEILING_BYTES;
  const shown =
    blob.length === 0 || refSideTooBig ? null : await gitBytes(core, threadId, cwd, ['cat-file', 'blob', blob]);
  return { data: shown !== null && shown.code === 0 ? shown.data : null, tooBig: refSideTooBig };
}

interface DiffSide {
  data: Uint8Array | null;
  tooBig: boolean;
}

export async function readTreeSide(path: string): Promise<DiffSide> {
  let info;
  try { info = await lstat(path); } catch { return { data: null, tooBig: false }; }
  // A symlink's diff is the link text. Opening it would follow a swap to a
  // file outside the worktree and put those bytes in the panel.
  if (info.isSymbolicLink()) {
    try {
      const link = Buffer.from(await readlink(path));
      return { data: link, tooBig: link.length > SIDE_CEILING_BYTES };
    } catch { return { data: null, tooBig: false }; }
  }
  if (!info.isFile()) return { data: null, tooBig: false };
  let current: Uint8Array | null = null;
  let newSideTooBig = false;
  // Size before read, on the handle rather than the path. A multi-gigabyte
  // working-tree file used to be loaded whole and only cut to DIFF_MAX_BYTES
  // afterwards, so one `git.diff` on a big log could take the core down; and a
  // path replaced between a `stat` and a `readFile` would have escaped the
  // ceiling the stat approved. `O_NOFOLLOW` refuses a name swapped for a
  // symlink after that check. Only what the diff can show is read, from the
  // one file the size was taken from.
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const size = (await handle.stat()).size;
    if (size > SIDE_CEILING_BYTES) {
      newSideTooBig = true;
    } else {
      // One byte past the limit, so `cut` still reports the side as truncated.
      const buffer = new Uint8Array(Math.min(size, DIFF_MAX_BYTES) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      current = buffer.subarray(0, bytesRead);
    }
  } catch {
    current = null;
  } finally {
    await handle?.close();
  }
  return { data: current, tooBig: newSideTooBig };
}
