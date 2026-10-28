import { readFileSync, rmSync, statSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { lockFile as osLockFile, processPlatform } from './platform/index.ts';
import type { FileLocker, HeldFileLock } from './platform/types.ts';

/**
 * How much later than the lock's own time a holder may have started and still
 * be the core that wrote it. The core starts before it writes the lock, so this
 * only absorbs the clocks: procfs gives the boot time in whole seconds.
 */
const LOCK_CLOCK_MARGIN_MS = 2000;

/** Is that process still there? `EPERM` means it is, under another account. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Did the process wearing `pid` start after the lock that names it was written? */
function startedAfter(pid: number, lockedAt: number | null, startedAt: (pid: number) => number | null): boolean {
  if (lockedAt === null) return false;
  const started = startedAt(pid);
  return started !== null && started > lockedAt + LOCK_CLOCK_MARGIN_MS;
}

/** Is the live process wearing `pid` the core that wrote the lock? */
function sameRun(
  pid: number,
  lockedAt: number | null,
  lockedKey: string | null,
  startedAt: (pid: number) => number | null,
  bootedAt: () => number,
  startKey: (pid: number) => string | null,
): boolean {
  const key = lockedKey === null ? null : startKey(pid);
  if (key !== null) return key === lockedKey;
  const beforeBoot = lockedAt !== null && lockedAt < bootedAt() - LOCK_CLOCK_MARGIN_MS;
  return !beforeBoot && !startedAfter(pid, lockedAt, startedAt);
}

/** How a lock tells its holder's process apart from a later one wearing its pid. */
export interface LockClock {
  startedAt?: (pid: number) => number | null;
  bootedAt?: () => number;
  startKey?: (pid: number) => string | null;
}

interface LockRecord { pid: number | null; lockedAt: number | null; lockedKey: string | null; osLock: boolean }

function readRecord(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<{ pid: number; startedAt: number; startKey: string; osLock: boolean }>;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      lockedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null,
      lockedKey: typeof parsed.startKey === 'string' ? parsed.startKey : null,
      osLock: parsed.osLock === true,
    };
  } catch {
    // Missing, empty while its holder writes it, or cut by a power loss.
    return null;
  }
}

/** The locks this process holds, so `releaseOwnLock` finds one wherever its directory moved. */
const held = new Set<{ lock: HeldFileLock; drop(path: string): void }>();

/**
 * Takes `file` for this process, or throws `busy(holder)` while another
 * process holds it. The operating system holds the lock (`platform/`), drops
 * it when its holder dies and never lets two holders in, so a lock is never
 * stale and never read half-written by someone who then takes it. The record
 * in the file names the holder for the message only.
 *
 * A record without `osLock` comes from a core older than this lock, which
 * held nothing but the file: the old judgement still keeps such a core's
 * directory from a second one. A record from a run that is gone is replaced.
 * Gone includes a pid worn by someone else: a holder that started after the
 * lock was written is not the core that wrote it, nor is any process when the
 * lock predates the last boot (macOS cannot read a start time). Where the OS
 * names a run with a key (Linux), the key decides alone: the Linux start and
 * boot times follow every step of the wall clock.
 *
 * Such an older core replaces a record it judged stale by path. This core
 * writes its record through the lock it holds and then checks the path still
 * names that file, so an older core that replaced it first is found and kept.
 * One that judged before the record was written and replaces the file after
 * that check still gets in, as two older cores could race each other.
 */
export function takeLock(file: string, busy: (holder: number | null) => string, clock: LockClock = {}, lockFile: FileLocker = osLockFile): () => void {
  const startedAt = clock.startedAt ?? processPlatform.startedAt;
  const bootedAt = clock.bootedAt ?? (() => Date.now() - uptime() * 1000);
  const startKey = clock.startKey ?? (pid => processPlatform.startKey?.(pid) ?? null);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lock = lockFile(file);
    if (!lock) throw new Error(busy(readRecord(file)?.pid ?? null));
    // The previous holder deleted the file as it let go: this lock is on a file no longer at the path.
    if (!lock.stillAt(file)) {
      lock.release();
      continue;
    }
    const record = readRecord(file);
    const holder = record?.pid ?? null;
    if (record && !record.osLock && holder !== null && holder !== process.pid && alive(holder)
      && sameRun(holder, record.lockedAt, record.lockedKey, startedAt, bootedAt, startKey)) {
      lock.release();
      throw new Error(busy(holder));
    }
    const key = startKey(process.pid);
    // Through the held handle, never by path: a core older than this lock may have replaced the file
    // since it was judged, and a write by path would land in that core's file.
    try {
      lock.write(`${JSON.stringify({ pid: process.pid, startedAt: Date.now(), ...(key === null ? {} : { startKey: key }), osLock: true }, null, 2)}\n`);
    } catch (error) {
      // A full disk, say: still held, the lock would keep this process out of its own directory.
      lock.release();
      throw error;
    }
    // Replaced meanwhile: the next attempt locks that core's file and reads its record.
    if (!lock.stillAt(file)) {
      lock.release();
      continue;
    }
    const entry = {
      lock,
      // Deleted while still held, so the next holder cannot lock a file the path no longer names unnoticed.
      drop(path: string) {
        held.delete(entry);
        if (lock.stillAt(path)) rmSync(path, { force: true });
        lock.release();
      },
    };
    held.add(entry);
    // Only the file this call locked: its directory may have moved away, and another lock taken its path.
    return () => {
      try { entry.drop(file); } catch { /* The directory may be gone already; the lock is released all the same. */ lock.release(); }
    };
  }
  throw new Error(`could not take the lock ${file}: it keeps coming back`);
}

/** Releases the core lock in `directory` if this process holds it, wherever the directory has moved since. */
export function releaseOwnLock(directory: string): void {
  const file = join(directory, 'core.lock');
  try { statSync(file); } catch { return; }
  for (const entry of held) {
    if (!entry.lock.stillAt(file)) continue;
    try { entry.drop(file); } catch { entry.lock.release(); }
    return;
  }
}

/**
 * One core per data directory, taken before the journal is opened.
 *
 * Two cores on one directory is not a rare accident: `bun run dev:core` reads
 * the same default directory as the installed app, and every `Core` ends its
 * constructor with `recoverStuckTurns()`, which rewrites every turn still
 * running as a crash. The second core used to take the first one's live turn,
 * its threads and its `core.json` and the user watched his answer turn into an
 * error.
 */
export function lockDataDir(
  dataDir: string,
  startedAt?: (pid: number) => number | null,
  bootedAt?: () => number,
  startKey?: (pid: number) => string | null,
): () => void {
  return takeLock(join(dataDir, 'core.lock'),
    holder => `another core is already running on ${dataDir} (pid ${holder ?? 'not written yet'}). Close it, or start this one with --data-dir on a directory of its own.`,
    { startedAt, bootedAt, startKey });
}
