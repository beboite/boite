/** Durable associations, content-bound receipts and a replayable control outbox. */
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { SharedProject, SharedProjectPeerRequest } from '@boite/contracts';
import { invalidParams } from '../errors.ts';

export function createSharedProjects(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS shared_projects (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, project_id TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE INDEX IF NOT EXISTS shared_projects_scope ON shared_projects(project_id, contact_id);
    CREATE TABLE IF NOT EXISTS shared_project_receipts (
      actor TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(actor, request_id)
    );
    CREATE TABLE IF NOT EXISTS shared_project_outbox (
      id INTEGER PRIMARY KEY, contact_id TEXT NOT NULL, association_id TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE TABLE IF NOT EXISTS shared_project_policy (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);`);
}

/** Sorted object keys make request identity independent of JSON field ordering. */
export function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export class SharedProjectJournal {
  constructor(private readonly db: Database) {}

  all(projectId?: string, contactId?: string): SharedProject[] {
    return (this.db.query('SELECT data FROM shared_projects WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR contact_id = ?) ORDER BY rowid')
      .all(projectId ?? null, projectId ?? null, contactId ?? null, contactId ?? null) as { data: string }[]).map(row => JSON.parse(row.data));
  }
  get(id: string): SharedProject | null {
    const row = this.db.query('SELECT data FROM shared_projects WHERE id = ?').get(id) as { data: string } | null;
    return row ? JSON.parse(row.data) as SharedProject : null;
  }
  put(shared: SharedProject, contactId: string, projectId: string): void {
    this.db.query('INSERT INTO shared_projects(id,contact_id,project_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(shared.id, contactId, projectId, JSON.stringify(shared));
  }
  /** Called inside the same synchronous transaction as the write it acknowledges. */
  once<T>(actor: string, requestId: string, input: unknown, apply: () => T): T {
    const hash = fingerprint(input);
    const row = this.db.query('SELECT fingerprint,data FROM shared_project_receipts WHERE actor=? AND request_id=?').get(actor, requestId) as { fingerprint: string; data: string } | null;
    if (row) {
      if (row.fingerprint !== hash) throw invalidParams('requestId: already used with different content');
      return JSON.parse(row.data) as T;
    }
    const result = apply();
    this.db.query('INSERT INTO shared_project_receipts VALUES(?,?,?,?)').run(actor, requestId, hash, JSON.stringify(result));
    return result;
  }
  transaction<T>(write: () => T): T { return this.db.transaction(write)(); }
  enqueue(contactId: string, associationId: string, payload: SharedProjectPeerRequest): void {
    this.db.query('INSERT INTO shared_project_outbox(contact_id,association_id,data) VALUES(?,?,?)').run(contactId, associationId, JSON.stringify(payload));
  }
  queued(contactId: string): { id: number; payload: SharedProjectPeerRequest }[] {
    return (this.db.query('SELECT id,data FROM shared_project_outbox WHERE contact_id=? ORDER BY id').all(contactId) as { id: number; data: string }[])
      .map(row => ({ id: row.id, payload: JSON.parse(row.data) as SharedProjectPeerRequest }));
  }
  ack(id: number): void { this.db.query('DELETE FROM shared_project_outbox WHERE id=?').run(id); }
  policy(id: string): string | null {
    return (this.db.query('SELECT fingerprint FROM shared_project_policy WHERE id=?').get(id) as { fingerprint: string } | null)?.fingerprint ?? null;
  }
  setPolicy(id: string, hash: string): void { this.db.query('INSERT OR REPLACE INTO shared_project_policy VALUES(?,?)').run(id, hash); }
}
