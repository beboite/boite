import { Database } from 'bun:sqlite';
import { Journal } from '../../src/journal.ts';
import { compactionSteps, compactOnce } from '../../src/journal/retention.ts';

/**
 * A journal file as a schema 35 core left it: no codec, preview or length on
 * `part_blobs`, no `command_lines`, command lines in the trace rows. Made from
 * a current one by dropping what schema 36 added, so opening it with
 * `Journal` runs the real migration.
 */
export function schema35Journal(file: string): Database {
  new Journal(file).close();
  const db = new Database(file);
  db.exec(`DROP INDEX processes_by_command;
    ALTER TABLE processes DROP COLUMN command_id;
    DROP TABLE command_lines;
    ALTER TABLE part_blobs DROP COLUMN codec;
    ALTER TABLE part_blobs DROP COLUMN preview;
    ALTER TABLE part_blobs DROP COLUMN chars;
    PRAGMA user_version = 35;`);
  return db;
}

/** Runs every background compaction step to its end, as the timer would over many ticks. */
export function compactAll(journal: Journal, now = Date.now()): number {
  const steps = compactionSteps(journal);
  let ticks = 0;
  for (let result = compactOnce(journal, steps, now); result !== 'done'; result = compactOnce(journal, steps, now)) {
    if (result === 'busy') throw new Error('compaction: a message is still open');
    if (++ticks > 10_000) throw new Error('compaction: more than 10,000 ticks');
  }
  return ticks;
}
