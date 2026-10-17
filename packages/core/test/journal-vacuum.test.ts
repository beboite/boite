import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.ts';
import { compactionSteps, compactOnce, ONE_TIME_PASSES, PRUNED_AT } from '../src/journal/retention.ts';
import { STARTING_FILE, vacuumAtStart, vacuumPlan } from '../src/journal/vacuum.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boite-vacuum-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MiB = 1024 * 1024;
const when = { share: 0.25, bytes: 4 * MiB };
const file = () => join(dir, 'journal.db');
const pragma = (journal: Journal, name: string) => Object.values(journal.db.query(`PRAGMA ${name}`).get() as Record<string, number>)[0]!;

/** A journal whose background passes finished, holding `freed` bytes of free pages and a kept message. */
function journalWithFreePages(freed: number, finished = true): void {
  const journal = new Journal(file());
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
    while (await compactOnce(steps, Date.now()) === 'more') ticks++;
    expect(ticks).toBeGreaterThan(1);
    expect(pragma(journal, 'freelist_count') * 4096).toBeLessThanOrEqual(16 * MiB);
  } finally {
    journal.close();
  }
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
