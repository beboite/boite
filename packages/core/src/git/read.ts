import type { ThreadId } from '@boite/contracts';
import { DIFF_MAX_BYTES } from '@boite/contracts';
import { constants, existsSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, readlink } from 'node:fs/promises';
import type { Core } from '../core.ts';
import { folderGone, messageOf, refused } from '../errors.ts';
import { notARepository, OUTSIDE_A_REPOSITORY } from './errors.ts';
import { gitSubcommand, gitThread, logGit } from './git-log.ts';

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
 * How many short reads (a deadline of `GIT_READ_TIMEOUT_MS` or less) one core
 * runs at once. A diff panel, a worktree list and checkpoint listings can all
 * ask together; past this many, a read waits for a slot before its git starts,
 * and the wait does not count against its deadline.
 */
export const GIT_READ_SLOTS = 8;

interface ReadSlots {
  running: number;
  waiting: (() => void)[];
}

const readSlots = new WeakMap<Core, ReadSlots>();

/** Takes one of the core's read slots; the function it resolves to gives it back, once. */
async function readSlot(core: Core): Promise<() => void> {
  let pool = readSlots.get(core);
  if (pool === undefined) {
    pool = { running: 0, waiting: [] };
    readSlots.set(core, pool);
  }
  const slots = pool;
  if (slots.running < GIT_READ_SLOTS) slots.running += 1;
  // A freed slot passes straight to the next waiter, so `running` never drops under the queue.
  else await new Promise<void>((resolve) => slots.waiting.push(resolve));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = slots.waiting.shift();
    if (next === undefined) slots.running -= 1;
    else next();
  };
}

/** Runs `work` in a read slot when its deadline is a short one; a longer or absent deadline does not queue. */
async function inReadSlot<T>(core: Core, timeoutMs: number, work: () => Promise<T>): Promise<T> {
  if (timeoutMs > GIT_READ_TIMEOUT_MS) return work();
  const release = await readSlot(core);
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * What every read adds to git's environment. `GIT_OPTIONAL_LOCKS=0` keeps
 * `git status` from refreshing the index under `index.lock`, which made an
 * agent's own `git add` or `git commit` in the same checkout fail; it reaches
 * any git that git starts itself, too. English messages whatever the locale
 * (gettext reads LANGUAGE first): the log classifies git's failures by their text.
 */
const READ_ENV = { GIT_OPTIONAL_LOCKS: '0', LANGUAGE: 'en' } as const;
/** `core.fsmonitor=` on the command line wins over the user's gitconfig, so a monitor hook there cannot run during a read. */
const READ_CONFIG = ['-c', 'core.fsmonitor='] as const;

function startFailure(threadId: ThreadId, cwd: string, args: string[], needs: string, error: unknown): never {
  // A spawn in a folder that is gone fails with the same ENOENT as a git that is not installed.
  if (!existsSync(cwd)) throw folderGone(cwd, { threadId, field: 'cwd' });
  throw refused(`git did not start (${messageOf(error)}): ${needs} needs git on PATH`, { args });
}

/** A git that only reads, with `READ_ENV` and `READ_CONFIG`. */
function spawnRead(core: Core, threadId: ThreadId, cwd: string, args: string[], needs: string) {
  try {
    return core.procs.spawn(threadId, 'git', [...READ_CONFIG, ...args], { cwd, env: { ...READ_ENV } });
  } catch (error) {
    return startFailure(threadId, cwd, args, needs, error);
  }
}

/**
 * Waits for `work`, and stops that one git by its own process when it has not
 * answered in time: the thread's other processes are the agent's, never touched.
 * `onLate` runs only when the deadline fired, not for a read or exit failure.
 */
async function bounded<T>(spawned: { proc: { kill(): void } }, cwd: string, args: string[], work: Promise<T>, timeoutMs = GIT_READ_TIMEOUT_MS, onLate: () => void = () => undefined): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      spawned.proc.kill();
      // A log that throws must not keep the timeout from being reported.
      try { onLate(); } catch { /* the rejection below still runs */ }
      reject(refused(`git ${args[0] ?? ''} did not answer within ${timeoutMs / 1000} s in ${cwd}`, { args, cwd }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One git read, its output whole. `needs` names what asked, for the message
 * when git does not start. A deadline over `GIT_READ_TIMEOUT_MS` skips the
 * shared read slots.
 */
export async function git(core: Core, threadId: ThreadId, cwd: string, args: string[], timeoutMs = GIT_READ_TIMEOUT_MS, needs = 'reading the changes'): Promise<GitRun> {
  return inReadSlot(core, timeoutMs, async () => {
    const spawned = spawnRead(core, threadId, cwd, args, needs);
    const at = performance.now();
    const [stdout, stderr, code] = await bounded(spawned, cwd, args, Promise.all([
      new Response(spawned.proc.stdout).text(),
      new Response(spawned.proc.stderr).text(),
      spawned.exited,
    ]), timeoutMs, () => logGitTimeout(core, threadId, args, timeoutMs, at));
    try { logGit(core, threadId, args, code, performance.now() - at, stderr); } catch { /* A diagnostic storage failure must not break reads. */ }
    return { code, stdout, stderr };
  });
}

/** A git read stopped at its deadline, under the same thread rule as `logGit`. */
function logGitTimeout(core: Core, threadId: ThreadId, args: readonly string[], timeoutMs: number, at: number): void {
  core.logs.warn(`git ${gitSubcommand(args)} gave no answer within ${timeoutMs / 1000} s and was stopped`, {
    source: 'git', event: 'git.timeout', ...gitThread(threadId), durationMs: performance.now() - at, data: { subcommand: gitSubcommand(args), timeoutMs },
  });
}

/** The same, for a blob: `git cat-file blob` hands back bytes, and whether they are text is the question. */
async function gitBytes(core: Core, threadId: ThreadId, cwd: string, args: string[]): Promise<{ code: number; data: Uint8Array }> {
  return inReadSlot(core, GIT_READ_TIMEOUT_MS, async () => {
    const spawned = spawnRead(core, threadId, cwd, args, 'reading a file at a ref');
    const at = performance.now();
    // Drained with the rest, so a git that has something to say never blocks on a full pipe.
    const [buffer, stderr, code] = await bounded(spawned, cwd, args, Promise.all([
      new Response(spawned.proc.stdout).arrayBuffer(),
      new Response(spawned.proc.stderr).text(),
      spawned.exited,
    ]), GIT_READ_TIMEOUT_MS, () => logGitTimeout(core, threadId, args, GIT_READ_TIMEOUT_MS, at));
    try { logGit(core, threadId, args, code, performance.now() - at, stderr); } catch { /* A diagnostic storage failure must not break reads. */ }
    return { code, data: new Uint8Array(buffer) };
  });
}

/**
 * One side of a diff at a ref: `<ref>:<path>`. A missing blob is null,
 * distinct from an empty file. A path that is not a git repository is refused
 * by name, as `git.status` refuses it.
 */
export async function readRefSide(core: Core, threadId: ThreadId, cwd: string, ref: string, atRef: string): Promise<DiffSide> {
  const name = `${ref}:${atRef}`;
  if (!batchUnsupported.has(core)) {
    const batched = await catFileBatch(core, threadId, cwd, name);
    if (batched !== 'unsupported') return batched;
    batchUnsupported.add(core);
  }
  return readRefSideInSteps(core, threadId, cwd, name);
}

/** The cores whose git turned `cat-file --batch -z` down, older than 2.36: they read in three steps from then on. */
const batchUnsupported = new WeakSet<Core>();

/** The first line `git cat-file --batch` answers for an object it found. */
const BATCH_HEADER = /^[0-9a-f]{40,64} (\S+) (\d+)$/;

/**
 * The name, its size and its bytes in one git: `cat-file --batch -z` resolves
 * `<ref>:<path>` once and answers `<oid> <type> <size>` before the content, so
 * a branch that moves meanwhile cannot size one object and send another, and a
 * blob over `SIDE_CEILING_BYTES` is refused from its header, its git stopped
 * before the bytes are read.
 */
async function catFileBatch(core: Core, threadId: ThreadId, cwd: string, name: string): Promise<DiffSide | 'unsupported'> {
  const args = ['cat-file', '--batch', '-z'];
  return inReadSlot(core, GIT_READ_TIMEOUT_MS, async () => {
    let spawned;
    try {
      spawned = core.procs.spawnPiped(threadId, 'git', [...READ_CONFIG, ...args], { cwd, env: { ...process.env, ...READ_ENV } });
    } catch (error) {
      return startFailure(threadId, cwd, args, 'reading a file at a ref', error);
    }
    const proc = spawned.proc;
    // A git that refuses `-z` is gone before the name reaches it: the closed pipe is that answer, not a failure.
    try {
      proc.stdin.write(`${name}\0`);
      void Promise.resolve(proc.stdin.end()).catch(() => undefined);
    } catch { /* read below: the exit code and stderr say why */ }
    const at = performance.now();
    let stopped = false;
    const reading = (async (): Promise<DiffSide> => {
      const reader = proc.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      let header: { type: string; size: number; start: number } | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (value !== undefined && value.length > 0) {
          chunks.push(value);
          length += value.length;
        }
        if (header === null) {
          const joined = joinChunks(chunks, length);
          const newline = joined.indexOf(10);
          if (newline >= 0) {
            const line = new TextDecoder().decode(joined.subarray(0, newline));
            const found = BATCH_HEADER.exec(line);
            // `<name> missing`, `<name> ambiguous`: no object, so no side.
            if (found === null) return { data: null, tooBig: false };
            header = { type: found[1] as string, size: Number(found[2]), start: newline + 1 };
            if (header.type === 'blob' && header.size > SIDE_CEILING_BYTES) {
              stopped = true;
              proc.kill();
              await reader.cancel().catch(() => undefined);
              return { data: null, tooBig: true };
            }
          }
        }
        if (header !== null && length >= header.start + header.size) {
          const joined = joinChunks(chunks, length);
          // Drained to the end, not cancelled: a closed pipe would cost git its exit code on the newline after the blob.
          while (!(await reader.read()).done) { /* the newline that ends the answer */ }
          // A tree or a commit at that name is no file to compare.
          if (header.type !== 'blob') return { data: null, tooBig: false };
          return { data: joined.slice(header.start, header.start + header.size), tooBig: false };
        }
        if (done) return { data: null, tooBig: false };
      }
    })();
    const [side, stderr, code] = await bounded(spawned, cwd, args, Promise.all([
      reading,
      new Response(proc.stderr).text(),
      spawned.exited,
    ]), GIT_READ_TIMEOUT_MS, () => logGitTimeout(core, threadId, args, GIT_READ_TIMEOUT_MS, at));
    if (stopped) return side;
    if (code === 129 && /unknown (switch|option)/i.test(stderr)) return 'unsupported';
    try { logGit(core, threadId, args, code, performance.now() - at, stderr); } catch { /* A diagnostic storage failure must not break reads. */ }
    if (code === OUTSIDE_A_REPOSITORY) notARepository(threadId, stderr);
    return code === 0 ? side : { data: null, tooBig: false };
  });
}

/** The chunks read so far as one array, without copying when there is only one. */
function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  chunks.splice(0, chunks.length, joined);
  return joined;
}

/**
 * The same with three gits, for one that does not know `cat-file --batch -z`.
 * The name is resolved to the blob's own id before either read: a branch that
 * moves between them would otherwise size one object and read another.
 */
async function readRefSideInSteps(core: Core, threadId: ThreadId, cwd: string, name: string): Promise<DiffSide> {
  const resolved = await git(core, threadId, cwd, ['rev-parse', '--verify', '--quiet', name]);
  if (resolved.code === OUTSIDE_A_REPOSITORY) notARepository(threadId, resolved.stderr);
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
