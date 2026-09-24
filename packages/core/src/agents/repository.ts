import { createHash } from 'node:crypto';
import type { AgentDraft, AgentEntities, AgentEntityKind } from '@boite/contracts';
import { invalidParams, notFound, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import type { Journal } from '../journal.ts';

type Row = { data: string };

/** Domain records and the journal event that changes them always commit together. */
export class AgentsRepository {
  constructor(readonly journal: Journal) {}

  revision(): number {
    const row = this.journal.db.query("SELECT COALESCE(MAX(id), 0) AS revision FROM events WHERE type IN ('agents.record', 'agents.limits')").get() as { revision: number };
    return row.revision;
  }

  get<K extends AgentEntityKind>(kind: K, id: string): AgentEntities[K] {
    const row = this.journal.db.query('SELECT data FROM agent_entities WHERE kind = ? AND id = ?').get(kind, id) as Row | null;
    if (!row) throw notFound(`unknown ${kind} ${id}`, { kind, id });
    return JSON.parse(row.data) as AgentEntities[K];
  }

  list<K extends AgentEntityKind>(kind: K): AgentEntities[K][] {
    const rows = this.journal.db.query('SELECT data FROM agent_entities WHERE kind = ? ORDER BY created_at, rowid').all(kind) as Row[];
    return rows.map(row => JSON.parse(row.data) as AgentEntities[K]);
  }

  withStatus<K extends 'run' | 'work'>(kind: K, statuses: AgentEntities[K]['status'][]): AgentEntities[K][] {
    if (!statuses.length) return [];
    const rows = this.journal.db.query(`SELECT data FROM agent_entities WHERE kind = ? AND json_extract(data, '$.status') IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at, rowid`).all(kind, ...statuses) as Row[];
    return rows.map(row => JSON.parse(row.data) as AgentEntities[K]);
  }

  episodeRuns(episodeId: string): AgentEntities['run'][] {
    const rows = this.journal.db.query(`SELECT r.data FROM agent_entities r JOIN agent_entities w ON w.kind = 'work' AND w.id = json_extract(r.data, '$.workId') WHERE r.kind = 'run' AND json_extract(w.data, '$.episodeId') = ? ORDER BY r.created_at, r.rowid`).all(episodeId) as Row[];
    return rows.map(row => JSON.parse(row.data) as AgentEntities['run']);
  }

  create<K extends AgentEntityKind>(kind: K, value: AgentDraft<AgentEntities[K]>): AgentEntities[K] {
    const now = Date.now();
    const record = { ...value, id: newId(`agt_${kind}_`), revision: 1, createdAt: now, updatedAt: now } as AgentEntities[K];
    this.journal.append({ type: 'agents.record', threadId: null, version: 1, payload: { kind, record } }, db => {
      db.query('INSERT INTO agent_entities (kind, id, revision, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(kind, record.id, record.revision, now, now, JSON.stringify(record));
    });
    return record;
  }

  update<K extends AgentEntityKind>(kind: K, id: string, expectedRevision: number, value: AgentDraft<AgentEntities[K]>): AgentEntities[K] {
    return this.transaction(() => {
      const previous = this.get(kind, id);
      if (previous.revision !== expectedRevision) throw refused(`${kind} ${id}: expected revision ${previous.revision}, received ${expectedRevision}`, { kind, id, expectedRevision: previous.revision });
      const record = { ...value, id, revision: previous.revision + 1, createdAt: previous.createdAt, updatedAt: Date.now() } as AgentEntities[K];
      this.journal.append({ type: 'agents.record', threadId: null, version: 1, payload: { kind, record } }, db => {
        const updated = db.query('UPDATE agent_entities SET revision = ?, updated_at = ?, data = ? WHERE kind = ? AND id = ? AND revision = ?')
          .run(record.revision, record.updatedAt, JSON.stringify(record), kind, id, expectedRevision);
        if (updated.changes !== 1) throw refused(`${kind} ${id}: revision changed`);
      });
      return record;
    });
  }

  transaction<T>(run: () => T): T {
    // Flush before opening our transaction so unrelated streaming deltas are not rolled back with it.
    this.journal.flushDeltas();
    return this.journal.db.transaction(run)();
  }

  /** Receipt and effects share a transaction, including after a lost RPC response. */
  command<T>(actor: string, requestId: string, payload: unknown, execute: () => T): T {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw invalidParams('requestId: expected 8 to 128 letters, numbers, underscores or hyphens');
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.transaction(() => {
      const held = this.journal.db.query('SELECT fingerprint, result FROM agent_requests WHERE actor = ? AND request_id = ?').get(actor, requestId) as { fingerprint: string; result: string } | null;
      if (held) {
        if (held.fingerprint !== fingerprint) throw refused(`requestId ${requestId} was already used with different input`);
        return JSON.parse(held.result) as T;
      }
      const result = execute();
      if (result instanceof Promise) throw new Error('agent command transactions must be synchronous');
      this.journal.db.query('INSERT INTO agent_requests (actor, request_id, fingerprint, result) VALUES (?, ?, ?, ?)')
        .run(actor, requestId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
}
