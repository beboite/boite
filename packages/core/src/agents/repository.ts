import { createHash } from 'node:crypto';
import type { AgentDraft, AgentProfile, AgentRoutine, AgentSession } from '@boite/contracts';
import { invalidParams, notFound, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import type { Journal } from '../journal.ts';

type Row = { data: string };
/**
 * The records an agent is made of. Older cores also wrote groups, teams,
 * missions, tasks, messages, deliveries, work, runs, memories, resources,
 * artifacts and decisions to the same table: those rows stay where they are,
 * and nothing reads them.
 */
export interface AgentEntities {
  routine: AgentRoutine;
  profile: AgentProfile;
  session: AgentSession;
}
export type AgentEntityKind = keyof AgentEntities;

const KINDS: ReadonlySet<string> = new Set<AgentEntityKind>(['routine', 'profile', 'session']);
function checkKind(kind: string): void {
  if (!KINDS.has(kind)) throw new Error(`unknown agent record kind ${kind}`);
}

/** Domain records and the journal event that changes them always commit together. */
export class AgentsRepository {
  /**
   * Counts record writes, a rolled-back one included. A poller that found nothing
   * to do sleeps until it moves.
   */
  writes = 0;
  constructor(readonly journal: Journal) {}

  private rows<K extends AgentEntityKind>(sql: string, ...params: (string | number)[]): AgentEntities[K][] {
    return (this.journal.db.query(sql).all(...params) as Row[]).map(row => JSON.parse(row.data) as AgentEntities[K]);
  }

  /** Uses the partial index `events_agents`; its WHERE clause must stay textually identical. */
  revision(): number {
    const row = this.journal.db.query("SELECT COALESCE(MAX(id), 0) AS revision FROM events WHERE type IN ('agents.record', 'agents.limits')").get() as { revision: number };
    return row.revision;
  }

  get<K extends AgentEntityKind>(kind: K, id: string): AgentEntities[K] {
    checkKind(kind);
    const row = this.journal.db.query('SELECT data FROM agent_entities WHERE kind = ? AND id = ?').get(kind, id) as Row | null;
    if (!row) throw notFound(`unknown ${kind} ${id}`, { kind, id });
    return JSON.parse(row.data) as AgentEntities[K];
  }

  /** The record, or null when there is none; a bad kind, a database failure or corrupt JSON still throws. */
  find<K extends AgentEntityKind>(kind: K, id: string): AgentEntities[K] | null {
    checkKind(kind);
    const row = this.journal.db.query('SELECT data FROM agent_entities WHERE kind = ? AND id = ?').get(kind, id) as Row | null;
    return row ? JSON.parse(row.data) as AgentEntities[K] : null;
  }

  /** Every record of a kind: a few profiles, their sessions and routines. */
  list<K extends AgentEntityKind>(kind: K): AgentEntities[K][] {
    checkKind(kind);
    return this.rows<K>('SELECT data FROM agent_entities WHERE kind = ? ORDER BY created_at, rowid', kind);
  }

  /** The session whose thread this is, through `agent_session_thread`. */
  sessionOfThread(threadId: string): AgentSession | null {
    return this.rows<'session'>("SELECT data FROM agent_entities INDEXED BY agent_session_thread WHERE kind = 'session' AND json_extract(data, '$.threadId') = ?", threadId)[0] ?? null;
  }

  create<K extends AgentEntityKind>(kind: K, value: AgentDraft<AgentEntities[K]>): AgentEntities[K] {
    checkKind(kind);
    const now = Date.now();
    const record = { ...value, id: newId(`agt_${kind}_`), revision: 1, createdAt: now, updatedAt: now } as AgentEntities[K];
    this.writes += 1;
    this.journal.append({ type: 'agents.record', threadId: null, version: 1, payload: recordEvent(kind, record) }, db => {
      db.query('INSERT INTO agent_entities (kind, id, revision, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(kind, record.id, record.revision, now, now, JSON.stringify(record));
    });
    this.#prune(now);
    return record;
  }

  update<K extends AgentEntityKind>(kind: K, id: string, expectedRevision: number, value: AgentDraft<AgentEntities[K]>): AgentEntities[K] {
    return this.transaction(() => {
      const previous = this.get(kind, id);
      if (previous.revision !== expectedRevision) throw refused(`${kind} ${id}: expected revision ${previous.revision}, received ${expectedRevision}`, { kind, id, expectedRevision: previous.revision });
      const record = { ...value, id, revision: previous.revision + 1, createdAt: previous.createdAt, updatedAt: Date.now() } as AgentEntities[K];
      this.writes += 1;
      this.journal.append({ type: 'agents.record', threadId: null, version: 1, payload: recordEvent(kind, record) }, db => {
        const updated = db.query('UPDATE agent_entities SET revision = ?, updated_at = ?, data = ? WHERE kind = ? AND id = ? AND revision = ?')
          .run(record.revision, record.updatedAt, JSON.stringify(record), kind, id, expectedRevision);
        if (updated.changes !== 1) throw refused(`${kind} ${id}: revision changed`);
      });
      this.#prune(record.updatedAt);
      return record;
    });
  }

  /** Deletes one record; its event names it, as a write does. */
  remove(kind: AgentEntityKind, id: string): void {
    this.transaction(() => {
      const previous = this.get(kind, id);
      this.writes += 1;
      this.journal.append({ type: 'agents.record', threadId: null, version: 1, payload: { ...recordEvent(kind, previous), removed: true } }, db => {
        db.query('DELETE FROM agent_entities WHERE kind = ? AND id = ?').run(kind, id);
      });
    });
  }

  transaction<T>(run: () => T): T {
    // Flush before opening our transaction so unrelated streaming deltas are not rolled back with it.
    this.journal.flushDeltas();
    return this.journal.db.transaction(run)();
  }

  /** When the last pass dropped receipts and record events past `REQUEST_RETENTION_MS`. */
  #pruned = 0;

  /**
   * Once an hour, from whichever write comes first: every routine run adds
   * receipts and record events, and neither is read back after a month.
   */
  #prune(now: number): void {
    if (now - this.#pruned <= HOUR) return;
    this.#pruned = now;
    const cutoff = now - REQUEST_RETENTION_MS;
    this.journal.db.query('DELETE FROM agent_requests WHERE created_at < ?').run(cutoff);
    this.journal.db.query(PRUNE_RECORD_EVENTS).run(cutoff);
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
      const now = Date.now();
      this.journal.db.query('INSERT INTO agent_requests (actor, request_id, fingerprint, result, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(actor, requestId, fingerprint, JSON.stringify(result), now);
      this.#prune(now);
      return result;
    });
  }
}

const HOUR = 60 * 60 * 1000;
/**
 * How long a request id is remembered. A client retries a lost answer within
 * seconds, and a routine's ids carry its occurrence, so none comes back later.
 */
export const REQUEST_RETENTION_MS = 30 * 24 * HOUR;

/**
 * Drops `agents.record` events older than the cutoff. Nothing reads their
 * payload: `revision()` takes the newest id, and that event always stays, so
 * the revision never goes back. The inner query names the partial index
 * `events_agents` with its WHERE clause written the same way.
 */
export const PRUNE_RECORD_EVENTS = "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE type IN ('agents.record', 'agents.limits') AND type = 'agents.record' AND ts < ? AND id < (SELECT MAX(id) FROM events WHERE type IN ('agents.record', 'agents.limits')))";

/** What an `agents.record` event says: which record changed, not the record again. */
function recordEvent(kind: AgentEntityKind, record: { id: string; revision: number }): { kind: AgentEntityKind; id: string; revision: number } {
  return { kind, id: record.id, revision: record.revision };
}
