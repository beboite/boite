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
