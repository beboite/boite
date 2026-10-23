import { createHash } from 'node:crypto';
import type { AgentDraft, AgentEntities, AgentEntityKind, AgentHistoryCursor, AgentScope, AgentReadMark, AgentUnread, RpcParams } from '@boite/contracts';
import { invalidParams, notFound, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import type { Journal } from '../journal.ts';

type Row = { data: string };
/** Every work status but done and cancelled. Unfinished work stays in every snapshot. */
export const OPEN_WORK: AgentEntities['work']['status'][] = ['pending', 'running', 'waiting', 'paused', 'interrupted', 'error'];
export type RecentFilter = { scope?: AgentScope; agentId?: string };

const KINDS: ReadonlySet<string> = new Set<AgentEntityKind>(['routine', 'profile', 'group', 'team', 'mission', 'task', 'session', 'message', 'delivery', 'work', 'run', 'memory', 'resource', 'artifact', 'decision']);
/** SQLite uses a partial index only when the query names the same literal kind, so kinds and paths are inlined, never bound. */
function kindSql(kind: AgentEntityKind): string {
  if (!KINDS.has(kind)) throw new Error(`unknown agent record kind ${kind}`);
  return `kind = '${kind}'`;
}
function pathSql(field: string): string {
  if (!/^[A-Za-z]+$/.test(field)) throw new Error(`unsupported agent record field ${field}`);
  return `json_extract(data, '$.${field}')`;
}
/** A list of values bound as one JSON array: one cached statement whatever its length, and no bound-parameter limit. */
const IN_LIST = 'IN (SELECT value FROM json_each(?))';
/**
 * The expression index behind each targeted read. Without ANALYZE statistics
 * SQLite can prefer the primary key's `kind` prefix and walk the whole kind, so
 * every targeted read names its index: `INDEXED BY` fails the query outright
 * when the index cannot serve it, instead of silently scanning.
 */
const LOOKUP: Record<string, string> = {
  'session.threadId': 'agent_session_thread',
  'message.sourceRunId': 'agent_message_source_run',
  'work.episodeId': 'agent_work_episode',
  'delivery.workId': 'agent_delivery_work',
  'delivery.messageId': 'agent_delivery_recipient',
  'run.workId': 'agent_run_work',
  'decision.workId': 'agent_decision_work'
};
const SCOPED: Record<string, string> = { message: 'agent_message_scope', work: 'agent_work_scope', memory: 'agent_memory_scope' };
function indexFor(table: Record<string, string>, key: string): string {
  const index = table[key];
  if (!index) throw new Error(`no index serves agent records by ${key}`);
  return index;
}

/** Domain records and the journal event that changes them always commit together. */
export class AgentsRepository {
  /**
   * Counts record writes, a rolled-back one included. A poller that found nothing
   * to do sleeps until it moves: only a record write can add work or a run.
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
    const row = this.journal.db.query('SELECT data FROM agent_entities WHERE kind = ? AND id = ?').get(kind, id) as Row | null;
    if (!row) throw notFound(`unknown ${kind} ${id}`, { kind, id });
    return JSON.parse(row.data) as AgentEntities[K];
  }

  /** Every record of a kind. Only for kinds the owner configures; history kinds go through `recent` or `find`. */
  list<K extends AgentEntityKind>(kind: K): AgentEntities[K][] {
    return this.rows<K>('SELECT data FROM agent_entities WHERE kind = ? ORDER BY created_at, rowid', kind);
  }

  withStatus<K extends 'run' | 'work'>(kind: K, statuses: AgentEntities[K]['status'][]): AgentEntities[K][] {
    if (!statuses.length) return [];
    return this.rows<K>(`SELECT data FROM agent_entities INDEXED BY agent_${kind}_status WHERE ${kindSql(kind)} AND json_extract(data, '$.status') ${IN_LIST} ORDER BY created_at, rowid`, JSON.stringify(statuses));
  }

  /** Records whose `field` is one of `values`, through that field's expression index. */
  find<K extends AgentEntityKind>(kind: K, field: keyof AgentEntities[K] & string, values: readonly string[]): AgentEntities[K][] {
    const index = indexFor(LOOKUP, `${kind}.${field}`);
    if (values.length === 0) return [];
    return this.rows<K>(`SELECT data FROM agent_entities INDEXED BY ${index} WHERE ${kindSql(kind)} AND ${pathSql(field)} ${IN_LIST} ORDER BY created_at, rowid`, JSON.stringify(values));
  }

  /** Every run of an episode: its work through `agent_work_episode`, then their runs through `agent_run_work`. */
  episodeRuns(episodeId: string): AgentEntities['run'][] {
    const work = this.find('work', 'episodeId', [episodeId]).map(w => w.id);
    return this.find('run', 'workId', work).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The session of one agent in one context, through the unique index `agent_session_context`. */
  sessionFor(agentId: string, scope: AgentScope): AgentEntities['session'] | null {
    return this.rows<'session'>("SELECT data FROM agent_entities INDEXED BY agent_session_context WHERE kind = 'session' AND json_extract(data, '$.agentId') = ? AND json_extract(data, '$.scope.kind') = ? AND json_extract(data, '$.scope.id') = ?", agentId, scope.kind, scope.id)[0] ?? null;
  }

  /** Runs of a thread that finished successfully after `after`, oldest first. */
  completedRuns(threadId: string, after: number): string[] {
    const rows = this.journal.db.query("SELECT id FROM agent_entities INDEXED BY agent_run_thread WHERE kind = 'run' AND json_extract(data, '$.threadId') = ? AND json_extract(data, '$.finishedAt') > ? AND json_extract(data, '$.status') = 'done' ORDER BY json_extract(data, '$.finishedAt')").all(threadId, after) as { id: string }[];
    return rows.map(row => row.id);
  }

  /**
   * Newest first by last change, strictly before `before`. Reads one row past
   * `limit` to tell whether more remain. The row-value cursor lets SQLite start
   * the index walk at the cursor instead of skipping every newer row.
   */
  recent<K extends AgentEntityKind>(kind: K, filter: RecentFilter, before: AgentHistoryCursor | null, limit: number): { items: AgentEntities[K][]; more: boolean } {
    // A scope narrows further than an agent: with both, the scope index serves and agentId filters its rows.
    const index = filter.scope ? indexFor(SCOPED, kind) : filter.agentId ? indexFor({ work: 'agent_work_agent' }, kind) : 'agent_recent';
    const clauses = [kindSql(kind)];
    const params: (string | number)[] = [];
    if (filter.scope) { clauses.push("json_extract(data, '$.scope.kind') = ? AND json_extract(data, '$.scope.id') = ?"); params.push(filter.scope.kind, filter.scope.id); }
    if (filter.agentId) { clauses.push("json_extract(data, '$.agentId') = ?"); params.push(filter.agentId); }
    if (before) { clauses.push('(updated_at, id) < (?, ?)'); params.push(before.updatedAt, before.id); }
    const items = this.rows<K>(`SELECT data FROM agent_entities INDEXED BY ${index} WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`, ...params, limit + 1);
    return { items: items.slice(0, limit), more: items.length > limit };
  }

  /** Seek through creation order, independent of later attachment updates. */
  messages(params: RpcParams<'agents.messages'>, limit: number) {
    const { scope, before, after, readAt } = params;
    const sql = "FROM agent_entities INDEXED BY agent_message_reading WHERE kind = 'message' AND json_extract(data, '$.scope.kind') = ? AND json_extract(data, '$.scope.id') = ?";
    const pivot = readAt === undefined ? null : this.rows<'message'>(`SELECT data ${sql} AND created_at > ? AND json_extract(data, '$.senderId') IS NOT NULL ORDER BY created_at, id LIMIT 1`, scope.kind, scope.id, readAt)[0];
    const cursor = before ?? after ?? pivot;
    const ascending = !!after || !!pivot;
    const bound = cursor ? ` AND (created_at, id) ${before ? '<' : pivot ? '>=' : '>'} (?, ?)` : '';
    const items = this.rows<'message'>(`SELECT data ${sql}${bound} ORDER BY created_at ${ascending ? 'ASC' : 'DESC'}, id ${ascending ? 'ASC' : 'DESC'} LIMIT ?`, scope.kind, scope.id, ...(cursor ? [cursor.createdAt, cursor.id] : []), limit);
    if (!ascending) items.reverse();
    // Short unread tails keep their preceding prompt within the same page budget.
    if (pivot && items.length < limit) items.unshift(...this.rows<'message'>(`SELECT data ${sql} AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`, scope.kind, scope.id, pivot.createdAt, pivot.id, limit - items.length).reverse());
    const exists = (side: '<' | '>', item: AgentEntities['message'] | undefined) => !!item && !!this.journal.db.query(`SELECT 1 ${sql} AND (created_at, id) ${side} (?, ?) LIMIT 1`).get(scope.kind, scope.id, item.createdAt, item.id);
    return { messages: items, older: exists('<', items[0]), newer: exists('>', items.at(-1)) };
  }

  /** Count retained incoming messages without sending their bodies to the client. */
  unread(marks: AgentReadMark[], target?: AgentScope): AgentUnread[] {
    const positions = Object.fromEntries(marks.map(m => [`${m.scope.kind}:${m.scope.id}`, m.at]));
    const rows = this.journal.db.query(`
      WITH positions AS MATERIALIZED (SELECT key, value FROM json_each(?))
      SELECT json_extract(e.data, '$.scope.kind') AS scopeKind,
        json_extract(e.data, '$.scope.id') AS scopeId,
        coalesce(mark.value, 0) AS at, count(*) AS count
      FROM agent_entities e INDEXED BY agent_recent
      LEFT JOIN positions mark ON mark.key = json_extract(e.data, '$.scope.kind') || ':' || json_extract(e.data, '$.scope.id')
      WHERE e.kind = 'message' AND json_extract(e.data, '$.senderId') IS NOT NULL
        AND json_extract(e.data, '$.scope.kind') IN ('agent', 'group')
        AND e.created_at > coalesce(mark.value, 0)
        ${target ? "AND json_extract(e.data, '$.scope.kind') = ? AND json_extract(e.data, '$.scope.id') = ?" : ''}
      GROUP BY scopeKind, scopeId, at
    `).all(JSON.stringify(positions), ...(target ? [target.kind, target.id] : [])) as { scopeKind: 'agent' | 'group'; scopeId: string; at: number; count: number }[];
    return rows.map(r => ({ scope: { kind: r.scopeKind, id: r.scopeId }, at: r.at, count: r.count }));
  }

  create<K extends AgentEntityKind>(kind: K, value: AgentDraft<AgentEntities[K]>): AgentEntities[K] {
    const now = Date.now();
    const record = { ...value, id: newId(`agt_${kind}_`), revision: 1, createdAt: now, updatedAt: now } as AgentEntities[K];
    this.writes += 1;
    this.journal.append({ type: 'agents.record', threadId: null, version: 1, payload: recordEvent(kind, record) }, db => {
      db.query('INSERT INTO agent_entities (kind, id, revision, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(kind, record.id, record.revision, now, now, JSON.stringify(record));
    });
    this.prune(now);
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
      this.prune(record.updatedAt);
      return record;
    });
  }

  transaction<T>(run: () => T): T {
    // Flush before opening our transaction so unrelated streaming deltas are not rolled back with it.
    this.journal.flushDeltas();
    return this.journal.db.transaction(run)();
  }

  /** When the last pass dropped receipts and record events past `REQUEST_RETENTION_MS`. */
  private pruned = 0;

  /**
   * Once an hour, from whichever write comes first: every routine run adds
   * receipts and record events, and neither is read back after a month.
   */
  private prune(now: number): void {
    if (now - this.pruned <= HOUR) return;
    this.pruned = now;
    const cutoff = now - REQUEST_RETENTION_MS;
    this.journal.db.query('DELETE FROM agent_requests WHERE created_at < ?').run(cutoff);
    this.journal.db.query(PRUNE_RECORD_EVENTS).run(cutoff);
  }

  /**
   * Receipt and effects share a transaction, including after a lost RPC response.
   * A result that is one record is kept as a reference and read again on a
   * replay, so a routine's 16,000-character prompt is not copied per run.
   */
  command<T>(actor: string, requestId: string, payload: unknown, execute: () => T): T {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw invalidParams('requestId: expected 8 to 128 letters, numbers, underscores or hyphens');
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.transaction(() => {
      const held = this.journal.db.query('SELECT fingerprint, result FROM agent_requests WHERE actor = ? AND request_id = ?').get(actor, requestId) as { fingerprint: string; result: string } | null;
      if (held) {
        if (held.fingerprint !== fingerprint) throw refused(`requestId ${requestId} was already used with different input`);
        const kept = JSON.parse(held.result) as unknown;
        const ref = (kept as { ref?: { kind?: unknown; id?: unknown } } | null)?.ref;
        if (typeof ref?.kind === 'string' && KINDS.has(ref.kind) && typeof ref.id === 'string' && Object.keys(kept as object).length === 1) {
          return this.get(ref.kind as AgentEntityKind, ref.id) as T;
        }
        return kept as T;
      }
      const result = execute();
      if (result instanceof Promise) throw new Error('agent command transactions must be synchronous');
      const now = Date.now();
      this.journal.db.query('INSERT INTO agent_requests (actor, request_id, fingerprint, result, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(actor, requestId, fingerprint, JSON.stringify(receipt(result)), now);
      this.prune(now);
      return result;
    });
  }
}

const HOUR = 60 * 60 * 1000;
/**
 * How long a request id is remembered. A client retries a lost answer within
 * seconds, and a routine's ids carry its revision, so none comes back later.
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

/** A record `create` made (`agt_<kind>_...`) is kept as its reference, anything else as is. */
function receipt(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  const { id, revision } = result as { id?: unknown; revision?: unknown };
  const kind = typeof id === 'string' ? /^agt_([a-z]+)_/.exec(id)?.[1] : undefined;
  if (kind === undefined || !KINDS.has(kind) || typeof revision !== 'number') return result;
  return { ref: { kind, id } };
}
