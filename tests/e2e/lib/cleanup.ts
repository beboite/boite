import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What the e2e harness starts and makes, and how it takes it all down again.
 * Kept apart from `core.ts` so the test preload can sweep without loading the core client.
 */

export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill', '/pid', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * The same kill without blocking the event loop: `spawnSync` held every other
 * close of the file behind it, so pages closed in parallel queued one taskkill
 * after another while their profiles were still locked.
 */
export async function killProcessTreeAsync(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    killProcessTree(pid);
    return;
  }
  await Bun.spawn(['taskkill', '/pid', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true }).exited;
}

/**
 * The watchdog's script. `$1` is the browser's pid, `$2` the profile to remove
 * or empty. Its stdin is a pipe only this test process writes to: the kernel
 * closes it when this process dies, SIGKILL included, and `read` returns.
 * The start time read at spawn guards against a reused pid: a process that is
 * no longer the one captured is never signalled.
 */
const WATCHDOG_SCRIPT = `
started() { ps -o lstart= -p "$1" 2>/dev/null; }
start=$(started "$1")
while read -r _; do :; done
same() { [ -n "$start" ] && [ "$(started "$1")" = "$start" ]; }
if same "$1"; then
  kill -TERM "$1" 2>/dev/null
  i=0
  while [ "$i" -lt 30 ] && same "$1"; do sleep 0.1; i=$((i + 1)); done
  same "$1" && kill -KILL "$1" 2>/dev/null
  sleep 1
fi
if [ -n "$2" ]; then rm -rf -- "$2" 2>/dev/null || { sleep 1; rm -rf -- "$2" 2>/dev/null; }; fi
`;

export interface ParentDeathWatch {
  /** The watchdog's own pid, captured at its spawn. */
  readonly pid: number;
  /** Stops the watchdog without touching the browser: call it once the browser has exited. */
  release(): void;
}

/**
 * Makes a browser this process started die with this process on Linux and
 * macOS. A Chrome outlives a killed parent: a test process killed outright
 * left its browsers running under the user's systemd, with their profiles.
 * The watchdog is a `sh` blocked on a pipe, so it costs no polling, and it
 * signals only the pid captured at spawn. It is unref'd and never keeps the
 * run alive. Windows returns null: the caller keeps its own tree kill there.
 */
export function watchParentDeath(browserPid: number, profileDir: string | null): ParentDeathWatch | null {
  if (process.platform === 'win32') return null;
  const proc = Bun.spawn({
    cmd: ['sh', '-c', WATCHDOG_SCRIPT, 'boite-e2e-watchdog', String(browserPid), profileDir ?? ''],
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  proc.unref();
  // Held here so the pipe cannot be collected and closed while the browser runs.
  const pipe = proc.stdin;
  let released = false;
  return {
    pid: proc.pid,
    release(): void {
      if (released) return;
      released = true;
      // The watchdog's own pid, captured above: no pattern, no other process.
      proc.kill('SIGKILL');
      void pipe;
    },
  };
}

/** How long a removal keeps retrying: a killed Chromium let go of its profile after up to 30 s on a loaded machine. */
const REMOVE_DEADLINE_MS = 15_000;

/**
 * Deletes a directory the run created, retrying with backoff while Windows
 * still holds a file of it. False, and one warning naming the path, when it
 * outlived the deadline: a leak is reported, never silent.
 */
export async function removeDirectory(path: string, deadlineMs = REMOVE_DEADLINE_MS): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  let wait = 50;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (Date.now() + wait > deadline) {
        console.warn(`e2e: left ${path}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      await Bun.sleep(wait);
      wait = Math.min(wait * 2, 1_000);
    }
  }
}

/** What every directory this harness creates under the temp folder starts with. */
export const E2E_DIR_PREFIX = 'boite-e2e-';
/** A directory older than this belongs to no live run: no e2e file runs for an hour. */
const STALE_MS = 60 * 60 * 1000;

/**
 * Removes what an earlier, interrupted run left under the temp folder. Only
 * directories this harness names, only ones untouched for an hour, so a run
 * going on beside this one keeps its profile. Returns how many it removed.
 */
export function sweepStaleDirectories(root = tmpdir(), now = Date.now()): number {
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(E2E_DIR_PREFIX)) continue;
    const path = join(root, entry.name);
    try {
      if (now - statSync(path).mtimeMs < STALE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* in use or already gone: the next run tries again */
    }
  }
  return removed;
}
