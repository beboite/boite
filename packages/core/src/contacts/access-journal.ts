import type { Database } from 'bun:sqlite';
import type { SharedAccessEvent, SharedFileOverride } from '@boite/contracts';

export function createSharedAccess(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS shared_access_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, association_id TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data))
  );
  CREATE INDEX IF NOT EXISTS shared_access_scope ON shared_access_events(association_id,sequence);
  CREATE TABLE IF NOT EXISTS shared_file_overrides (
    id TEXT PRIMARY KEY, association_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
  );
  CREATE INDEX IF NOT EXISTS shared_override_scope ON shared_file_overrides(association_id);`);
}
/** Host-only binding. An override never follows a replaced inode, checkout or changed grant. */
export interface OverrideRecord { value: SharedFileOverride; root: string; identity: string; revision: number }
export class SharedAccessJournal {
  constructor(private readonly db: Database) {}
  put(event: SharedAccessEvent): void {
    this.db.query('INSERT INTO shared_access_events(id,association_id,data) VALUES(?,?,?)').run(event.id, event.sharedProjectId, JSON.stringify(event));
  }
  event(id: string): SharedAccessEvent | null {
    const row = this.db.query('SELECT data FROM shared_access_events WHERE id=?').get(id) as {data: string} | null;
    return row ? JSON.parse(row.data) : null;
  }
  cursor(id: string, eventId: string): number | null {
    const row = this.db.query('SELECT sequence FROM shared_access_events WHERE association_id=? AND id=?').get(id, eventId) as {sequence: number} | null;
    return row?.sequence ?? null;
  }
  page(id: string, after = 0): {events: SharedAccessEvent[]; next: string | null} {
    const rows = this.db.query('SELECT sequence,data FROM shared_access_events WHERE association_id=? AND sequence>? ORDER BY sequence LIMIT 101').all(id, after) as {sequence: number; data: string}[];
    return {events: rows.slice(0, 100).map(r => JSON.parse(r.data)), next: rows.length > 100 ? (JSON.parse(rows[99]!.data) as SharedAccessEvent).id : null};
  }
  overrides(id: string): OverrideRecord[] {
    return (this.db.query('SELECT data FROM shared_file_overrides WHERE association_id=? ORDER BY rowid').all(id) as {data: string}[]).map(r => JSON.parse(r.data));
  }
  putOverride(record: OverrideRecord): void {
    this.db.query('INSERT INTO shared_file_overrides VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.value.id, record.value.sharedProjectId, JSON.stringify(record));
  }
}
