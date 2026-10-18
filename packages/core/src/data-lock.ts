import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { processPlatform } from './platform/index.ts';

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

/**
 * Takes `file` for this process, or throws `busy(holder)` while a live
 * process that wrote it holds it. A lock whose holder is gone is taken over.
 *
 * Gone includes a pid worn by someone else. A core that died without releasing
 * the lock, in a reboot say, leaves its pid to whatever asks next: a browser
 * tab held the pid of a dead core and kept every later core from starting. A
 * holder that started after the lock was written is not the core that wrote it.
 * Nor is any process when the lock predates the last boot: that is the only
 * test macOS can make, since `startedAt` cannot read a start time there.
 * Where the OS names a run with a key (Linux), the key decides alone: the
 * Linux start time and boot time both follow every step of the wall clock,
 * so after an NTP step the live holder would look like a stranger.
 */
export function takeLock(file: string, busy: (holder: number) => string, clock: LockClock = {}): () => void {
  const startedAt = clock.startedAt ?? processPlatform.startedAt;
  const bootedAt = clock.bootedAt ?? (() => Date.now() - uptime() * 1000);
  const startKey = clock.startKey ?? (pid => processPlatform.startKey?.(pid) ?? null);
  const release = (): void => {
    try {
      rmSync(file, { force: true });
    } catch {
      // The directory may be gone already; nothing left to release.
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(file, 'wx');
      const key = startKey(process.pid);
      writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), ...(key === null ? {} : { startKey: key }) }, null, 2)}\n`, 'utf8');
      closeSync(handle);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: number | null = null;
      let lockedAt: number | null = null;
      let lockedKey: string | null = null;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<{ pid: number; startedAt: number; startKey: string }>;
        holder = typeof parsed.pid === 'number' ? parsed.pid : null;
        lockedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : null;
        lockedKey = typeof parsed.startKey === 'string' ? parsed.startKey : null;
      } catch {
        holder = null;
      }
      if (holder !== null && holder !== process.pid && alive(holder) && sameRun(holder, lockedAt, lockedKey, startedAt, bootedAt, startKey)) throw new Error(busy(holder));
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not take the lock ${file}: it keeps coming back`);
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
    holder => `another core is already running on ${dataDir} (pid ${holder}). Close it, or start this one with --data-dir on a directory of its own.`,
    { startedAt, bootedAt, startKey });
}
