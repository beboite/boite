import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.ts';
import { compactionSteps, compactOnce, ONE_TIME_PASSES, PRUNED_AT } from '../src/journal/retention.ts';
import { STARTING_FILE, VACUUM_FAILED_FILE, VACUUM_RETRY, vacuumAtStart, vacuumPlan } from '../src/journal/vacuum.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boite-vacuum-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MiB = 1024 * 1024;
const when = { share: 0.25, bytes: 4 * MiB };
const file = () => join(dir, 'journal.db');
const pragma = (journal: Journal, name: string) => Object.values(journal.db.query(`PRAGMA ${name}`).get() as Record<string, number>)[0]!;

/** A journal file made before new journals started in incremental auto-vacuum: its first page is written without it. */
function legacyJournalFile(): void {
  const db = new Database(file(), { create: true });
  db.exec('CREATE TABLE legacy (x); DROP TABLE legacy;');
  db.close();
}

/** An older journal whose background passes finished, holding `freed` bytes of free pages and a kept message. */
function journalWithFreePages(freed: number, finished = true): void {
  legacyJournalFile();
  const journal = new Journal(file());
  expect(pragma(journal, 'auto_vacuum')).toBe(0);
  journal.putMessage({ id: 'msg_kept', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts: [{ type: 'text', text: 'kept' }], state: 'complete', createdAt: 1 });
  const insert = journal.db.query("INSERT INTO events (thread_id, ts, type, version, payload) VALUES ('thr_b', 1, 'turn.finished', 1, ?)");
  journal.db.transaction(() => { for (let n = 0; n < freed / 4096; n++) insert.run('x'.repeat(4000)); })();
  journal.deleteThreads(['thr_b']);
  if (finished) {
    for (const key of ONE_TIME_PASSES) journal.setSetting(key, Number.MAX_SAFE_INTEGER);
    journal.setSetting(PRUNED_AT, 1);
  }
  journal.close();
}

test('once the passes are done, a start gives the free pages back and turns on incremental auto-vacuum, which idle ticks then use', async () => {
  journalWithFreePages(12 * MiB);
  const before = statSync(file()).size;
  expect(vacuumPlan(file(), when)).toMatchObject({ fileBytes: before });
  const errors: string[] = [];
  const done = vacuumAtStart(dir, message => errors.push(message), when)!;
  expect(errors).toEqual([]);
  expect(done.afterBytes).toBeLessThan(before / 4);
  expect(statSync(file()).size).toBe(done.afterBytes);
  expect(existsSync(join(dir, STARTING_FILE))).toBe(false);
  expect(existsSync(`${file()}.compact`)).toBe(false);

  const journal = new Journal(file());
  try {
    expect(journal.getMessage('msg_kept')?.parts).toEqual([{ type: 'text', text: 'kept' }]);
    expect(pragma(journal, 'auto_vacuum')).toBe(2);
    expect(journal.db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    // Never again: the next start finds incremental auto-vacuum.
    expect(vacuumPlan(file(), when)).toBeNull();

    // Pages freed later go back to the disk in paced ticks, down to what the writes to come reuse.
    const insert = journal.db.query("INSERT INTO events (thread_id, ts, type, version, payload) VALUES ('thr_c', 1, 'turn.finished', 1, ?)");
    journal.db.transaction(() => { for (let n = 0; n < (40 * MiB) / 4096; n++) insert.run('x'.repeat(4000)); })();
    journal.deleteThreads(['thr_c']);
    expect(pragma(journal, 'freelist_count') * 4096).toBeGreaterThan(30 * MiB);
    const steps = compactionSteps(journal);
    let ticks = 0;
    while (await compactOnce(steps, Date.now()) === 'more') {
      ticks++;
      // No timer turns in this loop: the checkpoint the Worker would run catches the WAL up here.
      if (journal.checkpoints?.behind === true) journal.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    expect(ticks).toBeGreaterThan(1);
    expect(pragma(journal, 'freelist_count') * 4096).toBeLessThanOrEqual(16 * MiB);
  } finally {
    journal.close();
  }
});

test('a new journal starts in incremental auto-vacuum and never needs the VACUUM', () => {
  const journal = new Journal(file());
  try {
    expect(pragma(journal, 'auto_vacuum')).toBe(2);
    expect(journal.db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    for (const key of ONE_TIME_PASSES) journal.setSetting(key, Number.MAX_SAFE_INTEGER);
    journal.setSetting(PRUNED_AT, 1);
  } finally {
    journal.close();
  }
  expect(vacuumPlan(file(), { share: 0, bytes: 0 })).toBeNull();
});

test('no VACUUM before the passes finished or under the thresholds, and the journal is left as it was', () => {
  journalWithFreePages(12 * MiB, false);
  expect(vacuumPlan(file(), when)).toBeNull();
  rmSync(file());
  journalWithFreePages(2 * MiB);
  const before = statSync(file()).size;
  expect(vacuumAtStart(dir, () => {}, when)).toBeNull();
  expect(statSync(file()).size).toBe(before);
});

test('a VACUUM that failed is tried again a day later, three times in all, not at every start', () => {
  journalWithFreePages(12 * MiB);
  const before = statSync(file()).size;
  const errors: string[] = [];
  const copy = `${file()}.compact`;
  const remove = fs.rmSync;
  let holding = false;
  // The new file is held when it would take the journal's name, as an antivirus can hold it on Windows,
  // and the same handle keeps that start from removing it.
  const held = spyOn(fs, 'renameSync').mockImplementation(() => { holding = true; throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); });
  const stuck = spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (holding && path === copy) { holding = false; throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' }); }
    remove(path, options);
  });
  try {
    const start = 1_000_000;
    expect(vacuumAtStart(dir, message => errors.push(message), when, null, start)).toBeNull();
    expect(errors).toEqual([expect.stringContaining('EPERM')]);
    expect(statSync(file()).size).toBe(before);
    expect(existsSync(copy)).toBe(true);
    // The next start, an hour later, removes the copy that start left and copies nothing.
    expect(vacuumAtStart(dir, message => errors.push(message), when, null, start + 60 * 60 * 1000)).toBeNull();
    expect(existsSync(copy)).toBe(false);
    expect(errors).toHaveLength(1);
    for (let day = 1; day < VACUUM_RETRY.attempts; day++) vacuumAtStart(dir, message => errors.push(message), when, null, start + day * VACUUM_RETRY.afterMs);
    expect(errors).toHaveLength(VACUUM_RETRY.attempts);
    expect(errors.at(-1)).toContain('not tried again');
    expect(vacuumAtStart(dir, message => errors.push(message), when, null, start + 30 * VACUUM_RETRY.afterMs)).toBeNull();
    expect(errors).toHaveLength(VACUUM_RETRY.attempts);
  } finally {
    held.mockRestore();
    stuck.mockRestore();
  }
  // Once the file is let go, removing the record lets a start compact again, and a success leaves none.
  rmSync(join(dir, VACUUM_FAILED_FILE));
  expect(vacuumAtStart(dir, message => errors.push(message), when)).not.toBeNull();
  expect(existsSync(join(dir, VACUUM_FAILED_FILE))).toBe(false);
});

test('a record cut short counts from when it was written, and one dated ahead of a clock set back counts from now', () => {
  const record = join(dir, VACUUM_FAILED_FILE);
  journalWithFreePages(12 * MiB);
  // A start died while writing it.
  fs.writeFileSync(record, '{"attempts":1,');
  const written = statSync(record).mtimeMs;
  expect(vacuumAtStart(dir, () => {}, when, null, written + 60 * 60 * 1000)).toBeNull();
  expect(vacuumAtStart(dir, () => {}, when, null, written + VACUUM_RETRY.afterMs + 1)).not.toBeNull();

  rmSync(file());
  journalWithFreePages(12 * MiB);
  const now = 5_000_000_000;
  // Written while the clock ran ten years ahead.
  fs.writeFileSync(record, JSON.stringify({ attempts: 1, at: now + 3650 * VACUUM_RETRY.afterMs }));
  expect(vacuumAtStart(dir, () => {}, when, null, now)).toBeNull();
  expect(vacuumAtStart(dir, () => {}, when, null, now + VACUUM_RETRY.afterMs / 2)).toBeNull();
  expect(vacuumAtStart(dir, () => {}, when, null, now + VACUUM_RETRY.afterMs)).not.toBeNull();
});
