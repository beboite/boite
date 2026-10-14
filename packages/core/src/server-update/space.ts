import { lstatSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { lstat, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';

/** Room left after the data copy, so the restarted core can still write its journal. */
export const SPACE_MARGIN = 512 * 1024 * 1024;

/** Bytes a recursive copy of `path` writes: regular files only, symlinks are copied as links. */
export function treeBytes(path: string): number {
  const info = lstatSync(path);
  if (!info.isDirectory()) return info.isFile() ? info.size : 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += treeBytes(child);
    else if (entry.isFile()) total += lstatSync(child).size;
  }
  return total;
}

/** The same count without blocking a running core's event loop. */
export async function treeBytesAsync(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.isFile() ? info.size : 0;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await treeBytesAsync(child);
    else if (entry.isFile()) total += (await lstat(child)).size;
  }
  return total;
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/**
 * The refusal for an update whose data backup cannot fit beside the
 * installation, or null. The backup is a full copy of the data directory
 * written next to the installation; running out of space halfway leaves the
 * core stopped for the whole copy and then rolls back.
 */
export function spaceShortage(dataBytes: number, freeBytes: number, backupParent: string): string | null {
  const needed = dataBytes + SPACE_MARGIN;
  if (freeBytes >= needed) return null;
  return `Not enough disk space for the update backup: it needs ${gb(needed)} free in ${backupParent}, ${gb(freeBytes)} is free. `
    + 'Free space on that disk, then install again.';
}

/** The worker's check, once the core has stopped and nothing else needs the event loop. */
export function assertBackupSpace(dataDir: string, backupParent: string): void {
  const info = statfsSync(backupParent);
  const shortage = spaceShortage(treeBytes(dataDir), Number(info.bavail) * Number(info.bsize), backupParent);
  if (shortage) throw new Error(shortage);
}

/** The core's check before it downloads anything or closes admission. */
export async function checkBackupSpace(dataDir: string, backupParent: string): Promise<void> {
  const info = await statfs(backupParent);
  const shortage = spaceShortage(await treeBytesAsync(dataDir), Number(info.bavail) * Number(info.bsize), backupParent);
  if (shortage) throw new Error(shortage);
}

/**
 * After a healthy update only its own backup is worth keeping: older
 * `.boite-backup-*` folders roll back to versions already replaced twice, and
 * `.boite-update-*` folders older than the current one belong to attempts that
 * ended. Each backup is a full data copy, so keeping them all fills the disk
 * within a few nightlies.
 */
export function pruneUpdateLeftovers(parent: string, currentId: string, startedAt: number): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(parent)) {
    const match = /^\.boite-(backup|update)-([a-f0-9-]{36})$/.exec(name);
    if (!match || match[2] === currentId) continue;
    const path = join(parent, name);
    try {
      // An update folder newer than this one is someone else's attempt in flight.
      if (match[1] === 'update' && statSync(path).mtimeMs >= startedAt) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch { /* A folder that cannot be removed now is retried after the next update. */ }
  }
  return removed;
}
