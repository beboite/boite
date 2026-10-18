import type { Database } from 'bun:sqlite';

/**
 * The `ANALYZE` statements `PRAGMA optimize` would run now, without running
 * them (its debug flag, 0x01), so that each runs in its own tick: in one
 * call it held the event loop 270 ms to 1.6 s after the migration and
 * 225 ms after the compaction passes on a 4.2 GB journal (2026-10-18).
 * `all` adds the tables never analyzed, as after a migration (0x10000).
 */
export function staleStatistics(db: Database, all: boolean): string[] {
  return (db.query(`PRAGMA optimize=${all ? '0x10003' : '0x03'}`).all() as Record<string, unknown>[])
    .map(row => String(Object.values(row)[0]))
    .filter(statement => /^ANALYZE /i.test(statement));
}

/** One statement of `staleStatistics`, reading about 400 rows per index (sqlite.org/lang_analyze.html#approx). */
export function analyze(db: Database, statement: string): void {
  if (!/^ANALYZE "?[\w.\-" ]+$/i.test(statement)) throw new Error(`journal analyze: expected an ANALYZE statement from PRAGMA optimize, received ${statement}`);
  db.exec('PRAGMA analysis_limit = 400');
  db.exec(statement);
}
