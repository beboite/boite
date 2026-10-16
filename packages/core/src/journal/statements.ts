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
