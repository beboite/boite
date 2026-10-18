import { existsSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Data-directory entries the snapshot leaves out. A release migrates the
 * journal and the small state files beside it; these stores it does not
 * rewrite, and they were most of the bytes: on a server with 1,300 threads,
 * checkpoints and browser profiles made the copy 8.9 GB and kept the service
 * down 2 min 25 s per update. A rollback keeps the live ones in place.
 */
export const UNSAVED_DATA = new Set(['checkpoints', 'browser', 'attachments', 'attachment-uploads', 'artifacts', 'logs', 'speech']);

/**
 * Puts the complete restored data, `<data>.restore-<id>`, in place of the data
 * directory, the stores left out of the snapshot moving across as they are.
 * Each rename checks what the previous one left, so a swap cut short resumes.
 */
export function swapRestored(dataDir: string, id: string): void {
  const restored = `${dataDir}.restore-${id}`;
  if (existsSync(dataDir)) {
    for (const name of UNSAVED_DATA) if (existsSync(join(dataDir, name)) && !existsSync(join(restored, name))) renameSync(join(dataDir, name), join(restored, name));
    renameSync(dataDir, `${dataDir}.failed-${id}`);
  }
  renameSync(restored, dataDir);
}

/**
 * Run before the core opens its data directory. A power cut during a rollback
 * leaves no worker and no recovery to finish it, and the service then starts
 * at boot on the rejected data or none, with the previous data one directory
 * away. A restored copy only takes its final name once complete, so one found
 * here goes into place. Only the newest is used: a second one would come from
 * an older interrupted rollback.
 */
export function finishInterruptedRestore(dataDir: string): string | null {
  const prefix = `${basename(dataDir)}.restore-`;
  let names: string[];
  try { names = readdirSync(dirname(dataDir)); } catch { return null; }
  const found = names.flatMap(name => {
    const id = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    return /^[a-f0-9-]{36}$/.test(id) ? [{ id, at: statSync(join(dirname(dataDir), name)).mtimeMs }] : [];
  }).sort((a, b) => b.at - a.at)[0];
  if (!found) return null;
  swapRestored(dataDir, found.id);
  writeFileSync(join(dataDir, 'server-update-result.json'), JSON.stringify({ version: null, at: Date.now(),
    error: 'Server update failed and its rollback was cut off; the previous data was put back when the server started.' }), { mode: 0o600 });
  return found.id;
}
