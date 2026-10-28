import { closeSync, cpSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { lockDataDir, releaseOwnLock } from '../data-lock.ts';

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
  /** Flushes a directory's entries, or throws; the directory's own flush when absent. */
  sync?(directory: string): void;
}

export const realMoves: RestoreMoves = {
  copy: (source, target, filter) => cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true, force: false, filter }),
  rename: renameSync,
};

/**
 * Takes an exclusive lock on `file` for as long as this process holds it, or
 * throws while another holds it. The operating system releases it when its
 * holder dies, so no lock is ever stale.
 */
export type FileLock = (file: string) => () => void;

/** Restorers publish a PID record before releasing the native handles needed for their directory swap. */
type DataLock = (dataDir: string, record?: 'pid') => () => void;
const lockDirectory: DataLock = (dataDir, record) => lockDataDir(dataDir, undefined, undefined, undefined, record);

/**
 * Beside the data directory, outside every directory a restore renames: the
 * restore a rollback needs, written before the previous version can boot and
 * removed once the swap is complete, so a later start knows which
 * `<data>.restore-<id>` is current. Only a server update writes it; a start
 * that finds none writes nothing outside the data directory.
 */
export const rollbackRecord = (dataDir: string) => `${dataDir}.rollback.json`;
/** Held by whoever restores the data directory: the update worker, its recovery, a core starting on a record. */
const maintenanceLock = (dataDir: string) => `${dataDir}.maintenance.lock`;

export interface RestoreRecord { id: string; snapshot: string }

function withMaintenance<T>(dataDir: string, lock: FileLock, work: () => T): T {
  const release = lock(maintenanceLock(dataDir));
  try { return work(); } finally { release(); }
}

function readRecord(dataDir: string): RestoreRecord | null | 'unreadable' {
  let text: string;
  try { text = readFileSync(rollbackRecord(dataDir), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const parsed = JSON.parse(text) as Partial<RestoreRecord>;
    if (typeof parsed.id === 'string' && /^[a-f0-9-]{36}$/.test(parsed.id) && typeof parsed.snapshot === 'string') return { id: parsed.id, snapshot: parsed.snapshot };
  } catch { /* Unreadable below. */ }
  return 'unreadable';
}

/**
 * Flushes the entries of `directory` so a power cut keeps them in their order.
 * Windows cannot open a directory. `required` throws when a filesystem that
 * syncs directories fails to; one that cannot sync them at all passes.
 */
function syncDirectory(directory: string, required = false): void {
  let handle: number;
  try { handle = openSync(directory, 'r'); }
  catch (error) { if (required && process.platform !== 'win32') throw error; return; }
  try { fsyncSync(handle); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (required && process.platform !== 'win32' && code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  } finally { closeSync(handle); }
}

function writeDurably(file: string, text: string): void {
  const handle = openSync(file, 'w', 0o600);
  try { writeSync(handle, text); fsyncSync(handle); } finally { closeSync(handle); }
}

/** Publishes the record whole or not at all: a valid one in place stays as it is. */
function publishRecord(dataDir: string, record: RestoreRecord): void {
  const current = readRecord(dataDir);
  if (current && current !== 'unreadable' && current.id === record.id && current.snapshot === record.snapshot) return;
  const file = rollbackRecord(dataDir);
  const partial = `${file}.${process.pid}.partial`;
  writeDurably(partial, JSON.stringify(record));
  renameSync(partial, file);
  syncDirectory(dirname(file));
}

/**
 * Written in the restored copy just before it takes the data directory's
 * name, with the operation's id: the one positive sign that a swap is
 * complete. It stays in the data directory; the next rollback overwrites it.
 */
const RESTORED = 'server-update-restored';
const restoredBy = (directory: string): string | null => {
  try { return readFileSync(join(directory, RESTORED), 'utf8'); } catch { return null; }
};

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

/** A free name beside the data directory that no start or restore looks for. */
function setAside(dataDir: string, path: string, moves: RestoreMoves): void {
  if (!existsSync(path)) return;
  const name = path === dataDir ? 'data' : basename(path).slice(basename(dataDir).length + 1);
  let target = `${dataDir}.unused-${name}`;
  for (let n = 1; existsSync(target); n++) target = `${dataDir}.unused-${name}-${n}`;
  moves.rename(path, target);
}

/**
 * Puts the complete restored data, `<data>.restore-<id>`, in place of the data
 * directory, the stores left out of the snapshot moving across as they are.
 * Each rename checks what the previous one left, so a swap cut short resumes.
 */
function swapRestored(dataDir: string, id: string, moves: RestoreMoves): void {
  const restored = `${dataDir}.restore-${id}`;
  const failed = `${dataDir}.failed-${id}`;
  if (existsSync(dataDir)) {
    for (const name of UNSAVED_DATA) if (existsSync(join(dataDir, name)) && !existsSync(join(restored, name))) moves.rename(join(dataDir, name), join(restored, name));
    // The name is taken, by rejected data moved aside earlier or by an older folder: this one goes aside under its own.
    if (existsSync(failed)) {
      setAside(dataDir, dataDir, moves);
    }
    else moves.rename(dataDir, failed);
  }
  moves.rename(restored, dataDir);
  syncDirectory(dirname(dataDir));
}

/**
 * Finishes the restore `record` names: moves the snapshot beside the data
 * directory, swaps it in and sets every other restore aside. It resumes from
 * what the disk shows and throws, record kept, when it cannot finish; the
 * data in place is then the rejected version's and nothing may open it.
 *
 * It takes both directories' core locks with live PID records from the start,
 * then closes their handles without rewriting for the swap, which Windows
 * requires for a directory rename. Both old and current cores honor those
 * records. The maintenance lock excludes other restorers, and the final data lock is taken again.
 * The lock left on the data directory is this process's; the caller keeps it
 * or calls `releaseOwnLock`.
 */
function restoreRecorded(dataDir: string, record: RestoreRecord, moves: RestoreMoves, lockData: DataLock): void {
  const restored = `${dataDir}.restore-${record.id}`;
  const failed = `${dataDir}.failed-${record.id}`;
  try {
    // Throws while a live core holds the data, which must not move under it.
    if (existsSync(dataDir)) lockData(dataDir, 'pid');
    if (restoredBy(dataDir) !== record.id) {
      // A file in its place is no restore: set aside, and the snapshot is moved again.
      if (existsSync(restored) && !statSync(restored).isDirectory()) setAside(dataDir, restored, moves);
      if (!existsSync(restored)) {
        if (!existsSync(record.snapshot)) throw new Error(`the snapshot ${record.snapshot} the rollback needs is missing`);
        moveTree(record.snapshot, restored, moves);
      }
      writeDurably(join(restored, RESTORED), record.id);
      // The mark's entry must be on disk before the swap makes this copy the data: a power cut that kept
      // the swap and lost the mark would leave a finished restore with no snapshot to redo it from.
      (moves.sync ?? ((directory: string) => syncDirectory(directory, true)))(restored);
      lockData(restored, 'pid');
      releaseOwnLock(dataDir, true);
      releaseOwnLock(restored, true);
      swapRestored(dataDir, record.id, moves);
      lockData(dataDir);
    }
  } catch (error) {
    for (const directory of [dataDir, restored, failed]) releaseOwnLock(directory);
    throw error;
  }
  // No other restore beside the data may replay over this one, whatever its name.
  const prefix = `${basename(dataDir)}.restore-`;
  for (const name of readdirSync(dirname(dataDir))) if (name.startsWith(prefix)) setAside(dataDir, join(dirname(dataDir), name), moves);
  rmSync(rollbackRecord(dataDir), { force: true });
  syncDirectory(dirname(dataDir));
}

/**
 * Records the restore a rollback needs. The worker calls it before the
 * previous installation goes back in place: from then on a start at boot
 * finds it, whatever cuts the rollback short.
 */
export function recordRestore(dataDir: string, record: RestoreRecord, lock: FileLock): void {
  withMaintenance(dataDir, lock, () => publishRecord(dataDir, record));
}

/**
 * Restores the snapshot `record` names under the maintenance lock, once no
 * live core holds the data. The used snapshot is discarded last; a failure
 * there leaves the restore complete.
 */
export function restoreSnapshot(dataDir: string, record: RestoreRecord, moves: RestoreMoves, lock: FileLock, lockData: DataLock = lockDirectory): void {
  withMaintenance(dataDir, lock, () => {
    const current = readRecord(dataDir);
    // The record goes only once the swap is complete.
    if (current === null && (restoredBy(dataDir) === record.id || !existsSync(record.snapshot))) return;
    if (current && current !== 'unreadable' && current.id !== record.id) throw new Error(`the rollback of update ${current.id} recorded in ${rollbackRecord(dataDir)} is not finished`);
    publishRecord(dataDir, record);
    restoreRecorded(dataDir, record, moves, lockData);
    releaseOwnLock(dataDir);
  });
  try { discard(record.snapshot, moves); } catch { /* The next update's cleanup deletes what is left of the backup. */ }
}

const writeNote = (dataDir: string, error: string) =>
  writeFileSync(join(dataDir, 'server-update-result.json'), JSON.stringify({ version: null, error, at: Date.now() }), { mode: 0o600 });

/**
 * Opens the data directory for a starting core: prepares it and takes its
 * lock. A power cut during a server rollback leaves no worker and no recovery
 * to finish it, and the service then starts at boot on the data the rejected
 * version ran on; the restore the record names is finished first, under the
 * maintenance lock. A restore that cannot finish, or a record that cannot be
 * read, refuses the start with the record kept, so the next start retries.
 */
export function openDataDir(dataDir: string, prepare: (dataDir: string) => void, lock: FileLock,
  lockData: DataLock = lockDirectory, moves: RestoreMoves = realMoves): () => void {
  const file = rollbackRecord(dataDir);
  for (let attempt = 0; attempt < 3 && !existsSync(file); attempt++) {
    prepare(dataDir);
    const directory = statSync(dataDir, { bigint: true }).ino;
    const release = lockData(dataDir);
    // A rollback records itself before it moves anything, and holds the data lock while it does: one that
    // began meanwhile is finished below. The directory locked must still be the one at the path.
    if (!existsSync(file) && statSync(dataDir, { bigint: true }).ino === directory) return release;
    release();
  }
  return withMaintenance(dataDir, lock, () => {
    const record = readRecord(dataDir);
    if (record === null) {
      prepare(dataDir);
      return lockData(dataDir);
    }
    if (record === 'unreadable') {
      throw new Error(`the server update rollback record ${file} cannot be read, and the data in place may be the rejected version's. Put the previous data at ${dataDir} (a complete ${dataDir}.restore-<id> or the data folder of the .boite-backup-<id> beside the installation), then delete the record`);
    }
    // The data lock the restore leaves is this start's own.
    try { restoreRecorded(dataDir, record, moves, lockData); }
    catch (error) {
      throw new Error(`the server update rollback recorded in ${file} could not put the previous data back (${(error as Error).message}); the server stays stopped and the next start tries again`);
    }
    try { discard(record.snapshot, moves); } catch { /* The next update's cleanup deletes what is left of the backup. */ }
    prepare(dataDir);
    writeNote(dataDir, 'Server update failed and its rollback was cut off; the previous data was put back when the server started.');
    return () => releaseOwnLock(dataDir);
  });
}
