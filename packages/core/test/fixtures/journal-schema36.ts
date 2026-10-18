import { Database } from 'bun:sqlite';
import { Journal } from '../../src/journal.ts';
import { compactionSteps, compactOnce } from '../../src/journal/retention.ts';

/**
 * A journal file as a schema 36 core left it: no codec, preview or length on
 * `part_blobs`, no `command_lines`, command lines in the trace rows. Made from
 * a current one by dropping what schema 37 added, so opening it with
 * `Journal` runs the real migration.
 */
export function schema36Journal(file: string): Database {
  new Journal(file).close();
  const db = new Database(file);
  db.exec(`ALTER TABLE processes DROP COLUMN command_id;
    DROP TABLE command_lines;
    ALTER TABLE part_blobs DROP COLUMN codec;
    ALTER TABLE part_blobs DROP COLUMN preview;
    ALTER TABLE part_blobs DROP COLUMN chars;
    PRAGMA user_version = 36;`);
  return db;
}

/** Runs every background compaction step to its end, as the timer would over many ticks. */
export async function compactAll(journal: Journal, now = Date.now()): Promise<number> {
  const steps = compactionSteps(journal);
  let ticks = 0;
  for (let result = await compactOnce(steps, now); result !== 'done'; result = await compactOnce(steps, now)) {
    if (result === 'busy') throw new Error('compaction: a message is still open');
    if (++ticks > 10_000) throw new Error('compaction: more than 10,000 ticks');
  }
  return ticks;
}
