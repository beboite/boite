import { Database } from 'bun:sqlite';
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { messageOf } from '../errors.ts';
import { compactionFinished } from './retention.ts';
import { SCHEMA_VERSION } from './schema.ts';

/**
 * Written beside `core.json` while the core does long work before it serves,
 * so the shell waits past its start timeout and the window says why. Holds
 * the pid, what the core is doing and since when, and the OS start key of
 * this run where there is one: a crash leaves the file, and the shell must
 * not take the later process that gets the pid for this core.
 */
export const STARTING_FILE = 'core.starting.json';
/** The VACUUM runs once the free pages are past both: a quarter of the file and 256 MiB. */
export const VACUUM_WHEN = { share: 0.25, bytes: 256 * 1024 * 1024 };
/** Room the volume keeps beside the copy. */
const DISK_MARGIN_BYTES = 512 * 1024 * 1024;
const INCREMENTAL = 2;

export interface VacuumPlan { fileBytes: number; freeBytes: number; liveBytes: number }
export interface Vacuumed extends VacuumPlan { ms: number; afterBytes: number }

/**
 * Whether the journal at `file` gets its one VACUUM: the background passes
 * finished (`compactionFinished`), it is not in incremental auto-vacuum yet,
 * the free pages are past both thresholds of `when`,
 * and the volume holds the copy. Reads a few pragmas and settings; null for no.
 */
export function vacuumPlan(file: string, when = VACUUM_WHEN): VacuumPlan | null {
  if (!existsSync(file)) return null;
  const db = new Database(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const pragma = (name: string) => Number(Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, number>)[0]);
    if (pragma('user_version') !== SCHEMA_VERSION || pragma('auto_vacuum') === INCREMENTAL) return null;
    const setting = db.query('SELECT value FROM settings WHERE key = ?');
    const read = (key: string) => {
      const row = setting.get(key) as { value: string } | null;
      return row === null ? undefined : JSON.parse(row.value) as unknown;
    };
    if (!compactionFinished(read)) return null;
    const page = pragma('page_size');
    const fileBytes = pragma('page_count') * page, freeBytes = pragma('freelist_count') * page;
    if (freeBytes < when.bytes || freeBytes < fileBytes * when.share) return null;
    const liveBytes = fileBytes - freeBytes;
    const volume = statfsSync(dirname(file));
    if (volume.bavail * volume.bsize < liveBytes + DISK_MARGIN_BYTES) return null;
    return { fileBytes, freeBytes, liveBytes };
  } finally {
    db.close();
  }
}

/**
 * Gives the free pages the background passes left back to the disk, once, and
 * turns on incremental auto-vacuum so that later free pages go back in small
 * idle ticks (`retention.ts`) and no VACUUM is needed again. Runs before the
 * journal opens, with the data directory locked: a VACUUM holds the write lock
 * for its whole length, so at runtime every write would wait on it and fail.
 * The live file is copied with `VACUUM INTO` and the copy, checked, takes its
 * place; on any error the original stays as it was. Returns what it did, or
 * null when `vacuumPlan` says no.
 */
export function vacuumAtStart(dataDir: string, onError: (message: string) => void, when = VACUUM_WHEN, startKey: string | null = null): Vacuumed | null {
  const file = join(dataDir, 'journal.db');
  const copy = `${file}.compact`;
  const status = join(dataDir, STARTING_FILE);
  let plan: VacuumPlan | null;
  try {
    // A copy a stopped start left behind.
    rmSync(copy, { force: true });
    rmSync(status, { force: true });
    plan = vacuumPlan(file, when);
  } catch (error) {
    onError(`journal vacuum check: ${messageOf(error)}`);
    return null;
  }
  if (plan === null) return null;
  const started = performance.now();
  try {
    writeFileSync(status, JSON.stringify({ pid: process.pid, phase: 'compacting', startedAt: Date.now(), bytes: plan.liveBytes, ...(startKey === null ? {} : { startKey }) }));
    const db = new Database(file);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      // Everything in the main file, so the WAL removed below holds nothing.
      const { busy } = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
      if (busy !== 0) throw new Error('the WAL could not be checkpointed: another process holds the journal');
      db.exec(`PRAGMA auto_vacuum = ${INCREMENTAL}`);
      db.query('VACUUM INTO ?').run(copy);
    } finally {
      db.close();
    }
    checkCopy(file, copy);
    // On the disk before it takes the journal's name: a power cut must find one whole file or the other.
    const handle = openSync(copy, 'r+');
    try { fsyncSync(handle); } finally { closeSync(handle); }
    for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    renameSync(copy, file);
    return { ...plan, afterBytes: statSync(file).size, ms: performance.now() - started };
  } catch (error) {
    onError(`journal vacuum: ${messageOf(error)}; the journal is left as it was`);
    rmSync(copy, { force: true });
    return null;
  } finally {
    rmSync(status, { force: true });
  }
}

/** The copy has the schema, the mode and the rows of the tables a start reads first. */
function checkCopy(file: string, copy: string): void {
  const source = new Database(file, { readonly: true }), target = new Database(copy, { readonly: true });
  try {
    for (const sql of ['PRAGMA user_version', 'SELECT COUNT(*) FROM threads', 'SELECT COUNT(*) FROM messages', 'SELECT COUNT(*) FROM settings', 'SELECT MAX(id) FROM events']) {
      const [a, b] = [source, target].map(db => Object.values(db.query(sql).get() as Record<string, unknown>)[0]);
      if (a !== b) throw new Error(`the copy differs on ${sql}: ${String(b)} for ${String(a)}`);
    }
    if ((target.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum !== INCREMENTAL) throw new Error('the copy is not in incremental auto-vacuum');
  } finally {
    source.close();
    target.close();
  }
}
