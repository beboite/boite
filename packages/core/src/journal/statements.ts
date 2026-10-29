import { Database, type Changes, type SQLQueryBindings } from 'bun:sqlite';

/**
 * Bun's statement cache holds 20 by default, and the core runs about a hundred
 * distinct statements: one in nine `query` calls prepared its SQL again. The
 * setting is static and read on every call, so it covers every Database in the
 * process; a cached statement costs about 14 KiB. The journal imports this
 * module before it opens its database.
 */
Database.MAX_QUERY_CACHE_SIZE = 128;

/**
 * SQLite's default 2 MiB of cached pages is less than one thread list on a
 * journal of a few thousand threads, so each list read the file again. Under
 * memory pressure the kernel drops those file pages within seconds and the read
 * waited on the disk with the event loop stopped
 * (`bench/results/2026-10-28-journal-cache.md`). Pages cached here stay in the
 * core's memory across the connection's own writes and the Worker's passive
 * checkpoints; 64 MiB is four times what the core read from a 4 GiB journal in
 * three minutes on a loaded machine. A sort keeps up to that much in memory
 * before it spills to a temporary file, where it spilled past about 2 MiB.
 */
export function cachePages(db: Database): Database {
  db.exec(`PRAGMA cache_size = -${64 * 1024}`);
  return db;
}

/**
 * Over this many characters, a bound value runs on a statement of its own.
 * A statement from `db.query` is cached and keeps the values of its last run
 * alive until it runs again: after binding a 20 MB string and dropping it, RSS
 * stayed 21 MiB higher; prepared and finalized, 1.2 MiB (Bun 1.4.2, 2026-10-15).
 */
export const LARGE_BIND_CHARS = 64 * 1024;

const large = (value: SQLQueryBindings): boolean =>
  (typeof value === 'string' && value.length > LARGE_BIND_CHARS) || (ArrayBuffer.isView(value) && value.byteLength > LARGE_BIND_CHARS);

/**
 * Runs a write that may bind a message's parts or a moved value: on the cached
 * statement when every value is small, else on a statement finalized right
 * after, so the value is freed when the caller drops it.
 */
export function runWrite(db: Database, sql: string, ...params: SQLQueryBindings[]): Changes {
  if (!params.some(large)) return db.query(sql).run(...params);
  const statement = db.prepare(sql);
  try {
    return statement.run(...params);
  } finally {
    statement.finalize();
  }
}
