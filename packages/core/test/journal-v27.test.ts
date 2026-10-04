import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '../src/journal/schema.ts';
import { Journal } from '../src/journal.ts';
let dir: string, file: string;
const fixture = readFileSync(new URL('./fixtures/journal-v27.sql', import.meta.url), 'utf8');
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-schema27-')); file = join(dir, 'journal.db');
  const db = new Database(file); db.transaction(() => db.exec(fixture))(); db.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test('immutable schema27 produced by original migration preserves its data through 28 and reopen', () => {
  expect(createHash('sha256').update(fixture).digest('hex')).toBe('c20998fa8320eb8b370bd11857aaa344d5660a5234b70efb88b0f4eb34ef2227');
  const raw = new Database(file);
  expect(raw.query('PRAGMA user_version').get()).toEqual({ user_version: 27 });
  expect(raw.query("SELECT name FROM pragma_table_info('turns') WHERE name='queue_hold'").get()).toBeNull();
  expect(raw.query("SELECT name FROM pragma_table_info('threads') WHERE name='fork_origin'").get()).toBeNull();
  const receipts = raw.query('SELECT * FROM turn_requests ORDER BY rowid').all();
  const letters = raw.query('SELECT * FROM coordination_letters ORDER BY rowid').all();
  raw.close();
  for (let pass = 0; pass < 2; pass++) {
    const journal = new Journal(file);
    try {
      expect(journal.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(journal.db.query('SELECT * FROM turn_requests ORDER BY rowid').all()).toEqual(receipts);
      expect(journal.db.query('SELECT * FROM coordination_letters ORDER BY rowid').all()).toEqual(letters);
      expect(journal.listTurns('thr_fixture').map(turn => [turn.id, turn.status, turn.queueHold ?? null])).toEqual([['turn_done','done',null],['turn_queued','queued',null],['turn_running','running',null]]);
      expect(journal.getThread('thr_fixture')?.forkOrigin).toBeUndefined();
      expect(journal.getSetting('coordination:thr_fixture')).toMatchObject({ paused: true });
      expect(journal.db.query('SELECT * FROM thread_deletions').all()).toEqual([{ thread_id: 'thr_deleted', root_id: 'thr_deleted', archived: 0, deleted_at: 190 }]);
      expect(journal.db.query('SELECT COUNT(*) AS count FROM background_observations').get()).toEqual({ count: 0 });
      expect(journal.listMessages('thr_fixture')).toHaveLength(5);
    } finally { journal.close(); }
  }
});
test('failure after adding migration28 projections rolls back real schema27 and retries cleanly', () => {
  const original = Database.prototype.exec;
  const mock = spyOn(Database.prototype, 'exec').mockImplementation(function(this: Database, sql: string) {
    if (sql.includes('ALTER TABLE turns ADD COLUMN queue_hold')) throw new Error('Synthetic migration failure');
    return original.call(this, sql);
  });
  try { expect(() => new Journal(file)).toThrow('Synthetic migration failure'); } finally { mock.mockRestore(); }
  const raw = new Database(file);
  expect(raw.query('PRAGMA user_version').get()).toEqual({ user_version: 27 });
  expect(raw.query("SELECT name FROM sqlite_master WHERE name='background_observations'").get()).toBeNull();
  expect(raw.query("SELECT name FROM pragma_table_info('threads') WHERE name='fork_origin'").get()).toBeNull();
  expect(raw.query('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 5 }); raw.close();
  const retried = new Journal(file);
  try { expect(retried.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION }); expect(retried.listMessages('thr_fixture')).toHaveLength(5); }
  finally { retried.close(); }
});
