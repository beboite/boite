import type { Database } from 'bun:sqlite';

/**
 * The `ANALYZE` statements `PRAGMA optimize` would run now, without running
 * them (its debug flag, 0x01), so that each runs in its own tick: in one
 * call it held the event loop 270 ms to 1.6 s after the migration and
 * 225 ms after the compaction passes on a 4.2 GB journal (2026-10-18).
 * `all` adds the tables never analyzed, as after a migration: SQLite 3.46
 * and later list them under 0x10000, an older library (the system one Bun
 * opens on macOS) ignores that bit, so they are also read from
 * `sqlite_stat1` here, the tables with a row and no statistics.
 */
export function staleStatistics(db: Database, all: boolean): string[] {
  const statements = (db.query(`PRAGMA optimize=${all ? '0x10003' : '0x03'}`).all() as Record<string, unknown>[])
    .map(row => String(Object.values(row)[0]))
    .filter(statement => /^ANALYZE /i.test(statement))
    .filter(statement => {
      const table = /^ANALYZE "main"\."(\w+)"$/i.exec(statement)?.[1];
      // SQLite stores no statistics for an empty table and otherwise proposes it again forever.
      return table === undefined || db.query(`SELECT 1 FROM "${table}" LIMIT 1`).get() !== null;
    });
  if (!all) return statements;
  const missing = neverAnalyzed(db).map(table => `ANALYZE "main"."${table}"`).filter(statement => !statements.includes(statement));
  return [...statements, ...missing];
}

/** Tables with at least one row and no `sqlite_stat1` entry, including rowid-only tables. */
function neverAnalyzed(db: Database): string[] {
  const hasStats = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get() !== null;
  const tables = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'${hasStats ? ' AND name NOT IN (SELECT tbl FROM sqlite_stat1)' : ''} ORDER BY name`).all() as { name: string }[];
  return tables.map(row => row.name)
    .filter(name => /^\w+$/.test(name) && db.query(`SELECT 1 FROM "${name}" LIMIT 1`).get() !== null);
}

/** One statement of `staleStatistics`, reading about 400 rows per index (sqlite.org/lang_analyze.html#approx). */
export function analyze(db: Database, statement: string): void {
  if (!/^ANALYZE "?[\w.\-" ]+$/i.test(statement)) throw new Error(`journal analyze: expected an ANALYZE statement from PRAGMA optimize, received ${statement}`);
  db.exec('PRAGMA analysis_limit = 400');
  db.exec(statement);
}
