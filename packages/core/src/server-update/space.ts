import { lstatSync, readFileSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { lstat, readdir, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  const dataBytes = treeBytes(dataDir);
  // A rollback swaps folders by rename on one disk; across disks it copies the snapshot back beside the data.
  const folders = statSync(backupParent).dev === statSync(dirname(dataDir)).dev ? [backupParent] : [backupParent, dirname(dataDir)];
  for (const folder of folders) {
    const info = statfsSync(folder);
    const shortage = spaceShortage(dataBytes, Number(info.bavail) * Number(info.bsize), folder);
    if (shortage) throw new Error(shortage);
  }
}

/** The core's check before it downloads anything or closes admission. */
export async function checkBackupSpace(dataDir: string, backupParent: string): Promise<void> {
  const dataBytes = await treeBytesAsync(dataDir);
  const folders = (await stat(backupParent)).dev === (await stat(dirname(dataDir))).dev ? [backupParent] : [backupParent, dirname(dataDir)];
  for (const folder of folders) {
    const info = await statfs(folder);
    const shortage = spaceShortage(dataBytes, Number(info.bavail) * Number(info.bsize), folder);
    if (shortage) throw new Error(shortage);
  }
}

/** The file inside a backup that names the installation it belongs to. */
export const BACKUP_OWNER = 'installation-path';

function ownerOf(path: string, kind: string): string | null {
  try {
    if (kind === 'backup') return readFileSync(join(path, BACKUP_OWNER), 'utf8');
    const plan = JSON.parse(readFileSync(join(path, 'plan.json'), 'utf8')) as { installation?: { directory?: unknown } };
    return typeof plan.installation?.directory === 'string' ? plan.installation.directory : null;
  } catch { return null; }
}

/**
 * After a healthy update only its own backup is worth keeping: older
 * `.boite-backup-*` folders roll back to versions already replaced twice, and
 * `.boite-update-*` folders older than the current one belong to attempts that
 * ended. Each backup is a full data copy, so keeping them all fills the disk
 * within a few nightlies. Only folders that name this installation go; one
 * without a marker or plan, or naming a sibling installation, stays.
 */
export function pruneUpdateLeftovers(parent: string, installation: string, currentId: string, startedAt: number): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(parent)) {
    const match = /^\.boite-(backup|update)-([a-f0-9-]{36})$/.exec(name);
    if (!match || match[2] === currentId) continue;
    const path = join(parent, name);
    try {
      if (ownerOf(path, match[1]!) !== installation) continue;
      // An update folder newer than this one is someone else's attempt in flight.
      if (match[1] === 'update' && statSync(path).mtimeMs >= startedAt) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch { /* A folder that cannot be removed now is retried after the next update. */ }
  }
  return removed;
}
