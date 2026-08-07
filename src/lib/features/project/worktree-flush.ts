import type { WorktreeEntry } from "$lib/backend/types";
import { pathKey } from "./path";

/**
 * Which worktrees the sweep is allowed to take, and how much they weigh.
 *
 * Out here rather than in the panel because it is the answer to "what will this
 * button destroy", and that answer is worth a test that mounts nothing. The
 * panel reaches the backend, the repository and a confirm dialog the moment it
 * is imported.
 */

/**
 * The directories threads are standing in, as keys the entries below can be
 * looked up by.
 *
 * The two sides are spelled by different programs. A thread's path was written
 * by this app, so on Windows it is backslashed; an entry's path was printed by
 * `git worktree list --porcelain`, which answers forward slashes for the same
 * directory. Held as raw strings, the set matched nothing on Windows: the sweep
 * read every thread's checkout as free, and removed one with an agent working
 * in it. What the thread saw was its next launch refused with "this directory
 * is not there", forever, since nothing puts a worktree back.
 */
export function heldKeys(paths: Iterable<string>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const path of paths) keys.add(pathKey(path));
  return keys;
}

/**
 * A worktree removing costs nothing.
 *
 * Three refusals, and each one is a thing that would be lost: the repository's
 * own checkout, a directory holding uncommitted work or commits on no branch,
 * and a directory a thread is standing in. A spare is fair game — it costs the
 * next thread its head start and nothing else — and so is a prunable entry,
 * whose directory is already gone.
 *
 * `held` is what [`heldKeys`] returns, never a set of paths as they were
 * stored.
 */
export function isReclaimable(entry: WorktreeEntry, held: ReadonlySet<string>): boolean {
  if (entry.main) return false;
  if (entry.dirty || entry.orphanCommits) return false;
  return !held.has(pathKey(entry.path));
}

export function reclaimable(
  entries: readonly WorktreeEntry[],
  held: ReadonlySet<string>,
): WorktreeEntry[] {
  return entries.filter((entry) => isReclaimable(entry, held));
}

/** What the sweep would give back, counting only the directories measured. */
export function reclaimableBytes(
  entries: readonly WorktreeEntry[],
  sizes: Readonly<Record<string, number>>,
): number {
  let total = 0;
  for (const entry of entries) total += sizes[entry.path] ?? 0;
  return total;
}

const UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

/**
 * A byte count as something to read on a button. Three significant figures at
 * most: "1.24 GB" on a control is a number being shown off rather than read.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}
