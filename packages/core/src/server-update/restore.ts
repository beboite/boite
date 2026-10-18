import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { lockDataDir, takeLock, type LockClock } from '../data-lock.ts';

/**
 * Data-directory entries the snapshot leaves out. A release migrates the
 * journal and the small state files beside it; these stores it does not
 * rewrite, and they were most of the bytes: on a server with 1,300 threads,
 * checkpoints and browser profiles made the copy 8.9 GB and kept the service
 * down 2 min 25 s per update. A rollback keeps the live ones in place.
 */
export const UNSAVED_DATA = new Set(['checkpoints', 'browser', 'attachments', 'attachment-uploads', 'artifacts', 'logs', 'speech']);

/** The moves a restore makes; the update worker passes its own so tests can stand for a full or second disk. */
export interface RestoreMoves {
  copy(source: string, target: string, filter?: (source: string) => boolean): void;
  rename(source: string, target: string): void;
}

const realMoves: RestoreMoves = {
  copy: (source, target, filter) => cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true, force: false, filter }),
  rename: renameSync,
};

/**
 * Beside the data directory, outside every directory a restore renames: the
 * restore under way, written before anything moves and removed once the swap
 * is complete, so a later start knows which `<data>.restore-<id>` is current.
 */
export const rollbackRecord = (dataDir: string) => `${dataDir}.rollback.json`;
/** Held by whoever moves the data directory: the update worker, its recovery, a starting core. */
const maintenanceLock = (dataDir: string) => `${dataDir}.maintenance.lock`;

export interface RestoreRecord { id: string; snapshot: string }

/** Runs `work` under the maintenance lock, which a live holder keeps; a dead one's is taken over. */
export function withMaintenance<T>(dataDir: string, work: () => T, clock?: LockClock): T {
  const release = takeLock(maintenanceLock(dataDir), holder => `a server update (pid ${holder}) is restoring ${dataDir}; start the server again once it is done`, clock);
  try { return work(); } finally { release(); }
}

/** Throws while a live core holds the data directory, which must not move under it. */
function ensureNoCore(dataDir: string, lockData: (dataDir: string) => () => void): void {
  if (existsSync(dataDir)) lockData(dataDir)();
}

/**
 * Renames `source` to `target`. Across filesystems, which the update reserved
 * room for, a complete copy takes the target's name; the caller discards the source.
 */
export function moveTree(source: string, target: string, moves: RestoreMoves): void {
  try { moves.rename(source, target); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; }
  const partial = `${target}.partial`;
  rmSync(partial, { recursive: true, force: true });
  moves.copy(source, partial);
  renameSync(partial, target);
}

/** Renames a used tree aside before deleting it, so one cut short never passes for a complete one. */
export function discard(path: string, moves: RestoreMoves = realMoves): void {
  if (existsSync(path)) moves.rename(path, `${path}.consumed`);
  rmSync(`${path}.consumed`, { recursive: true, force: true });
}

/**
 * Puts the complete restored data, `<data>.restore-<id>`, in place of the data
 * directory, the stores left out of the snapshot moving across as they are.
 * Each rename checks what the previous one left, so a swap cut short resumes.
 */
function swapRestored(dataDir: string, id: string): void {
  const restored = `${dataDir}.restore-${id}`;
  if (existsSync(dataDir)) {
    for (const name of UNSAVED_DATA) if (existsSync(join(dataDir, name)) && !existsSync(join(restored, name))) renameSync(join(dataDir, name), join(restored, name));
    renameSync(dataDir, `${dataDir}.failed-${id}`);
  }
  renameSync(restored, dataDir);
}

/** A free name beside the data directory that no start or restore looks for. */
function setAside(dataDir: string, path: string): void {
  if (!existsSync(path)) return;
  const name = basename(path).slice(basename(dataDir).length + 1);
  let target = `${dataDir}.unused-${name}`;
  for (let n = 1; existsSync(target); n++) target = `${dataDir}.unused-${name}-${n}`;
  renameSync(path, target);
}

/** Once a swap is complete, no other restore beside the data may replay over it, whatever its name. */
function settle(dataDir: string): void {
  const prefix = `${basename(dataDir)}.restore-`;
  for (const name of readdirSync(dirname(dataDir))) if (name.startsWith(prefix)) setAside(dataDir, join(dirname(dataDir), name));
  rmSync(rollbackRecord(dataDir), { force: true });
}

/**
 * Restores the snapshot `record` names: moves it beside the data directory,
 * swaps it in and sets every other restore aside. It resumes from what the
 * disk shows, and runs under the maintenance lock once no live core holds the
 * data. The used snapshot is discarded last; a failure there leaves the
 * restore complete.
 */
export function restoreSnapshot(dataDir: string, record: RestoreRecord, moves: RestoreMoves, lockData: (dataDir: string) => () => void = lockDataDir, clock?: LockClock): void {
  const restored = `${dataDir}.restore-${record.id}`;
  withMaintenance(dataDir, () => {
    // The swap renames the data aside before the restored copy in: with neither left to do, it is done.
    const pending = !existsSync(restored) && !existsSync(`${dataDir}.failed-${record.id}`);
    if (pending && !existsSync(record.snapshot)) return;
    // Recorded first: whatever stops this restore, the next start of the server finishes it.
    writeFileSync(rollbackRecord(dataDir), JSON.stringify(record), { mode: 0o600 });
    ensureNoCore(dataDir, lockData);
    if (pending) moveTree(record.snapshot, restored, moves);
    if (existsSync(restored)) swapRestored(dataDir, record.id);
    settle(dataDir);
  }, clock);
  try { discard(record.snapshot, moves); } catch { /* The next update's cleanup deletes what is left of the backup. */ }
}

const writeNote = (dataDir: string, error: string) =>
  writeFileSync(join(dataDir, 'server-update-result.json'), JSON.stringify({ version: null, error, at: Date.now() }), { mode: 0o600 });

/** Puts back what a swap that failed had moved, so the data directory is the one it was. */
function undoSwap(dataDir: string, id: string): void {
  const restored = `${dataDir}.restore-${id}`;
  const failed = `${dataDir}.failed-${id}`;
  if (!existsSync(dataDir) && existsSync(failed)) renameSync(failed, dataDir);
  for (const name of UNSAVED_DATA) if (existsSync(join(restored, name)) && !existsSync(join(dataDir, name))) renameSync(join(restored, name), join(dataDir, name));
}

/**
 * Opens the data directory for a starting core: prepares it and takes its
 * lock, under the maintenance lock so no restore moves it in between. A power
 * cut during a server rollback leaves no worker and no recovery to finish it,
 * and the service then starts at boot on the rejected data or none; the
 * restore its record names is finished first. One that cannot be (a file, a
 * failed rename) is set aside with the reason in the update status, and the
 * core starts on the data as it was rather than failing every restart. A
 * snapshot that cannot be copied back is retried by the next start instead.
 */
export function openDataDir(dataDir: string, prepare: (dataDir: string) => void, lockData: (dataDir: string) => () => void = lockDataDir, clock?: LockClock): () => void {
  return withMaintenance(dataDir, () => {
    const file = rollbackRecord(dataDir);
    if (existsSync(file)) {
      ensureNoCore(dataDir, lockData);
      let record: RestoreRecord | null = null;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<RestoreRecord>;
        if (typeof parsed.id === 'string' && /^[a-f0-9-]{36}$/.test(parsed.id) && typeof parsed.snapshot === 'string') record = { id: parsed.id, snapshot: parsed.snapshot };
      } catch { /* Unreadable: set aside below. */ }
      if (!record) {
        setAside(dataDir, file);
        prepare(dataDir);
        writeNote(dataDir, `Server update rollback record ${file} was unreadable; it was set aside and the server started on its data as it was.`);
      } else {
        const restored = `${dataDir}.restore-${record.id}`;
        // The snapshot is still in the backup when the copy back never completed.
        if (!existsSync(restored) && !existsSync(`${dataDir}.failed-${record.id}`) && existsSync(record.snapshot)) moveTree(record.snapshot, restored, realMoves);
        try {
          if (existsSync(restored)) swapRestored(dataDir, record.id);
          settle(dataDir);
          try { discard(record.snapshot); } catch { /* The next update's cleanup deletes what is left of the backup. */ }
          prepare(dataDir);
          writeNote(dataDir, 'Server update failed and its rollback was cut off; the previous data was put back when the server started.');
        } catch (error) {
          undoSwap(dataDir, record.id);
          setAside(dataDir, restored);
          setAside(dataDir, file);
          prepare(dataDir);
          writeNote(dataDir, `Server update rollback could not put the previous data back (${(error as Error).message}); it was set aside as ${dataDir}.unused-restore-${record.id} and the server started on its data as it was.`);
        }
      }
    } else prepare(dataDir);
    return lockData(dataDir);
  }, clock);
}
