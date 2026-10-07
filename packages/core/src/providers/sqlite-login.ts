/** A login an agent keeps in a SQLite database of its own (`ProviderAuth.sqlite`), read and never written. */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';

/**
 * True when one of these tables holds a row, false when none does or the file
 * is not there yet, null when the file is there and cannot be read: locked,
 * damaged or not a database. A table the database does not have counts as
 * empty, since an agent may add or drop one between two of its versions; any
 * other failure of a query is the file's, and says nothing about a login.
 */
export function sqliteHasRows(file: string, tables: readonly string[]): boolean | null {
  if (!existsSync(file)) return false;
  let db: Database | null = null;
  try {
    db = new Database(file, { readonly: true });
    for (const table of tables) {
      try {
        if (db.query(`SELECT 1 FROM "${table}" LIMIT 1`).get() !== null) return true;
      } catch (error) {
        if (!/no such table/i.test(error instanceof Error ? error.message : String(error))) return null;
      }
    }
    return false;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
