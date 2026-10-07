/** A login an agent keeps in a SQLite database of its own (`ProviderAuth.sqlite`), read and never written. */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';

/**
 * True when one of these tables holds a row, false when none does or the file
 * is not there yet, null when the file is there and cannot be read. A table the
 * database does not have counts as empty: an agent may add or drop one between
 * two of its versions.
 */
export function sqliteHasRows(file: string, tables: readonly string[]): boolean | null {
  if (!existsSync(file)) return false;
  let db: Database | null = null;
  try {
    db = new Database(file, { readonly: true });
    for (const table of tables) {
      try {
        if (db.query(`SELECT 1 FROM "${table}" LIMIT 1`).get() !== null) return true;
      } catch {
        // no such table in this version of the agent
      }
    }
    return false;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
