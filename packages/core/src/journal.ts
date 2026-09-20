import { Database } from 'bun:sqlite';
import type {
  Account,
  Message,
  MessagePart,
  MessageRole,
  PairingRole,
  Project,
  ProcessRecord,
  ThreadSummary,
  Timestamp,
  Turn,
  Usage,
} from '@boite/contracts';

export const SCHEMA_VERSION = 12;
const DELTA_WINDOW_MS = 16;

/** What `listMessagePage` hands back: the page itself and the cursor for what is behind it. */
export interface MessagePage {
  messages: Message[];
  before: string | null;
}

export interface JournalEvent {
  type: string;
  threadId: string | null;
  version: number;
  payload: unknown;
  ts?: Timestamp;
}

interface PendingDelta {
  threadId: string;
  messageId: string;
  partIndex: number;
  text: string;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

interface ThreadRow {
  last_user_message_at?: number | null;
  id: string;
  project_id: string;
  title: string;
  title_source: string;
  provider_id: string;
  account_id: string;
  model: string | null;
  effort: string | null;
  speed: string | null;
  cwd: string;
  branch: string | null;
  permission_mode: string;
  status: string;
  unread: number;
  archived: number;
  pinned: number;
  session_id: string | null;
  session_generation: number;
  selection_version: number;
  context: string | null;
  created_at: number;
  updated_at: number;
}

interface TurnRow {
  id: string;
  thread_id: string;
  status: string;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  usage: string | null;
  error: string | null;
  execution: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  turn_id: string;
  role: string;
  parts: string;
  state: string;
  created_at: number;
}

interface ProcessRow {
  pid: number;
  thread_id: string;
  parent_pid: number | null;
  exe: string;
  command_line: string | null;
  started_at: number;
  exited_at: number | null;
  exit_code: number | null;
  cpu_ms: number | null;
  peak_memory_bytes: number | null;
  io_bytes: number | null;
}

interface AccountRow {
  id: string;
  provider_id: string;
  label: string;
  isolation_dir: string | null;
  status: string;
  identity: string | null;
  created_at: number;
}

/** A paired client. The token is stored hashed: the journal never holds a credential. */
export interface SessionRow {
  id: string;
  token_hash: string;
  client_name: string;
  client_version: string;
  /** What the pairing link granted: `owner` says hello as the owner. */
  role: PairingRole;
  created_at: number;
  last_seen_at: number;
}

/** What `usageByBucket` and `usageByThread` sum over a group of finished turns. */
export interface UsageSums {
  turns: number;
  reported: number;
  priced: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Null when no turn of the group carried a price. */
  cost: number | null;
}

export interface UsageSumRow extends UsageSums {
  bucket: number;
  provider_id: string;
  model: string | null;
}

export interface UsageThreadRow extends UsageSums {
  thread_id: string;
  /** The provider the turns of this row ran on; a thread that switched has one row per provider. */
  provider_id: string;
  title: string;
  project_id: string;
  thread_provider_id: string;
  archived: number;
}

/** The sums over `x`, a set of turns with their `usage` JSON. */
const USAGE_SUMS = `COUNT(*) AS turns, COUNT(x.usage) AS reported,
  COUNT(json_extract(x.usage, '$.costUsdEquivalent')) AS priced,
  COALESCE(SUM(json_extract(x.usage, '$.inputTokens')), 0) AS input_tokens,
  COALESCE(SUM(json_extract(x.usage, '$.outputTokens')), 0) AS output_tokens,
  COALESCE(SUM(json_extract(x.usage, '$.cacheReadTokens')), 0) AS cache_read_tokens,
  COALESCE(SUM(json_extract(x.usage, '$.cacheWriteTokens')), 0) AS cache_write_tokens,
  SUM(json_extract(x.usage, '$.costUsdEquivalent')) AS cost`;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  thread_id TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_thread ON events (thread_id, id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  model TEXT,
  cwd TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  unread INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  usage TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS turns_by_thread ON turns (thread_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (thread_id);
CREATE INDEX IF NOT EXISTS messages_user_time ON messages (thread_id, created_at DESC) WHERE role = 'user';

CREATE TABLE IF NOT EXISTS processes (
  thread_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  parent_pid INTEGER,
  exe TEXT NOT NULL,
  command_line TEXT,
  started_at INTEGER NOT NULL,
  exited_at INTEGER,
  exit_code INTEGER,
  cpu_ms INTEGER,
  peak_memory_bytes INTEGER,
  io_bytes INTEGER,
  PRIMARY KEY (thread_id, pid, started_at)
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  isolation_dir TEXT,
  status TEXT NOT NULL,
  identity TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Reasoning effort per thread. NULL is the model's own default. */
const SCHEMA_V2 = `
ALTER TABLE threads ADD COLUMN effort TEXT;
`;

/** A pinned thread sits above the others of its project. */
const SCHEMA_V3 = `
ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
`;

/** Paired clients, one row per session token the core minted. */
const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  client_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
`;

/** The branch of a thread started in its own worktree. NULL for one in the project itself. */
const SCHEMA_V5 = `
ALTER TABLE threads ADD COLUMN branch TEXT;
`;

/**
 * Who wrote the title: prompt, agent or user. A thread from before this
 * column reads `prompt`, which is what every title was.
 */
const SCHEMA_V6 = `
ALTER TABLE threads ADD COLUMN title_source TEXT NOT NULL DEFAULT 'prompt';
`;

/** The context meter as JSON (`ContextUse`). NULL until the agent reports its usage. */
const SCHEMA_V7 = `
ALTER TABLE threads ADD COLUMN context TEXT;
`;

/** The role a pairing link carried. Every session from before this column was a phone's. */
const SCHEMA_V8 = `
ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'device';
`;

function migrate(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
  let version = row?.user_version ?? 0;
  if (version < 1) {
    db.exec(SCHEMA_V1);
    version = 1;
  }
  if (version < 2) {
    db.exec(SCHEMA_V2);
    version = 2;
  }
  if (version < 3) {
    db.exec(SCHEMA_V3);
    version = 3;
  }
  if (version < 4) {
    db.exec(SCHEMA_V4);
    version = 4;
  }
  if (version < 5) {
    db.exec(SCHEMA_V5);
    version = 5;
  }
  if (version < 6) {
    db.exec(SCHEMA_V6);
    version = 6;
  }
  if (version < 7) {
    db.exec(SCHEMA_V7);
    version = 7;
  }
  if (version < 8) {
    db.exec(SCHEMA_V8);
    version = 8;
  }
  if (version < 9) {
    db.transaction(() => {
      db.exec('ALTER TABLE threads ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE threads ADD COLUMN selection_version INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE turns ADD COLUMN execution TEXT');
      db.exec('PRAGMA user_version = 9');
    })();
    version = 9;
  }
  if (version < 10) { db.exec('ALTER TABLE threads ADD COLUMN speed TEXT'); version = 10; }
  if (version < 11) {
    db.exec('CREATE TABLE turn_requests (thread_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, PRIMARY KEY(thread_id, request_id))');
    version = 11;
  }
  if (version < 12) {
    db.exec(`CREATE TABLE coordination_letters (
      id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      direction TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      request_id TEXT, fingerprint TEXT, data TEXT NOT NULL,
      PRIMARY KEY(id, direction), UNIQUE(thread_id, request_id)
    );
    CREATE INDEX coordination_thread ON coordination_letters(thread_id, created_at);
    CREATE TABLE coordination_wakes (thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, at INTEGER NOT NULL);
    CREATE INDEX coordination_wake_thread ON coordination_wakes(thread_id, at);`);
    version = 12;
  }
  db.exec(`PRAGMA user_version = ${version}`);
}

function parseJson<T>(text: string, location: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`invalid JSON in ${location}`);
  }
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, path: row.path, createdAt: row.created_at };
}

function toThread(row: ThreadRow): ThreadSummary {
  return {
    lastUserMessageAt: row.last_user_message_at ?? null,
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    titleSource: row.title_source as ThreadSummary['titleSource'],
    providerId: row.provider_id,
    accountId: row.account_id,
    model: row.model,
    effort: row.effort,
    speed: row.speed,
    cwd: row.cwd,
    branch: row.branch,
    permissionMode: row.permission_mode as ThreadSummary['permissionMode'],
    status: row.status as ThreadSummary['status'],
    unread: row.unread !== 0,
    archived: row.archived !== 0,
    pinned: row.pinned !== 0,
    sessionId: row.session_id,
    sessionGeneration: row.session_generation,
    selectionVersion: row.selection_version,
    load: null,
    context: row.context === null ? null : parseJson<ThreadSummary['context']>(row.context, `threads.context of ${row.id}`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status as Turn['status'],
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    usage: row.usage === null ? null : parseJson<Usage>(row.usage, `turns.usage row ${row.id}`),
    error: row.error,
    ...(row.execution === null ? {} : { execution: parseJson<NonNullable<Turn['execution']>>(row.execution, `turns.execution of ${row.id}`) }),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    role: row.role as MessageRole,
    parts: parseJson<MessagePart[]>(row.parts, `messages.parts row ${row.id}`),
    state: row.state as Message['state'],
    createdAt: row.created_at,
  };
}

function toProcess(row: ProcessRow): ProcessRecord {
  return {
    pid: row.pid,
    parentPid: row.parent_pid,
    threadId: row.thread_id,
    exe: row.exe,
    commandLine: row.command_line,
    startedAt: row.started_at,
    exitedAt: row.exited_at,
    exitCode: row.exit_code,
    cpuMs: row.cpu_ms,
    peakMemoryBytes: row.peak_memory_bytes,
    ioBytes: row.io_bytes,
  };
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    isolationDir: row.isolation_dir,
    status: row.status as Account['status'],
    identity: row.identity,
    createdAt: row.created_at,
  };
}

/**
 * Append-only event log plus the projections the RPC reads from. Every write
 * goes through `append`, which puts the event and the projection update in the
 * same transaction.
 */
export class Journal {
  readonly db: Database;
  private readonly deltas = new Map<string, PendingDelta>();
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(file: string) {
    this.db = new Database(file, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.transaction(() => migrate(this.db))();
    this.db.exec('CREATE INDEX IF NOT EXISTS turns_by_status ON turns (status)');
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_by_turn ON messages (thread_id, turn_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS turns_by_finished ON turns (finished_at)');
  }

  append<T>(event: JournalEvent, apply: (db: Database) => T): T {
    this.flushDeltas();
    const run = this.db.transaction((): T => {
      this.writeEvent(event);
      return apply(this.db);
    });
    return run();
  }

  appendDelta(threadId: string, messageId: string, partIndex: number, text: string): void {
    const key = `${messageId}|${partIndex}`;
    const current = this.deltas.get(key);
    if (current) current.text += text;
    else this.deltas.set(key, { threadId, messageId, partIndex, text });
    if (this.deltaTimer === null) {
      this.deltaTimer = setTimeout(() => {
        this.deltaTimer = null;
        this.flushDeltas();
      }, DELTA_WINDOW_MS);
    }
  }

  flushDeltas(): void {
    if (this.deltaTimer !== null) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    if (this.deltas.size === 0 || this.closed) return;
    const items = [...this.deltas.values()];
    this.deltas.clear();
    const run = this.db.transaction(() => {
      for (const item of items) {
        this.writeEvent({
          type: 'message.delta',
          threadId: item.threadId,
          version: 1,
          payload: { messageId: item.messageId, partIndex: item.partIndex, text: item.text },
        });
        this.appendToPart(item.messageId, item.partIndex, item.text);
      }
    });
    run();
  }

  isClosed(): boolean {
    return this.closed;
  }

  countEvents(type?: string): number {
    const row =
      type === undefined
        ? (this.db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number } | null)
        : (this.db.query('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(type) as { n: number } | null);
    return row?.n ?? 0;
  }

  close(): void {
    if (this.closed) return;
    this.flushDeltas();
    this.closed = true;
    this.db.close(false);
  }

  // -- projects -------------------------------------------------------------

  putProject(project: Project): void {
    this.db
      .query('INSERT OR REPLACE INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)')
      .run(project.id, project.name, project.path, project.createdAt);
  }

  deleteProject(projectId: string): void {
    this.db.query('DELETE FROM projects WHERE id = ?').run(projectId);
  }

  getProject(projectId: string): Project | null {
    const row = this.db.query('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | null;
    return row === null ? null : toProject(row);
  }

  listProjects(): Project[] {
    const rows = this.db.query('SELECT * FROM projects ORDER BY rowid').all() as ProjectRow[];
    return rows.map(toProject);
  }

  // -- threads --------------------------------------------------------------

  putThread(thread: ThreadSummary): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO threads
         (id, project_id, title, title_source, provider_id, account_id, model, effort, cwd, branch, permission_mode, status, unread, archived, pinned, session_id, context, created_at, updated_at, session_generation, selection_version, speed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.title,
        thread.titleSource,
        thread.providerId,
        thread.accountId,
        thread.model,
        thread.effort,
        thread.cwd,
        thread.branch,
        thread.permissionMode,
        thread.status,
        thread.unread ? 1 : 0,
        thread.archived ? 1 : 0,
        thread.pinned ? 1 : 0,
        thread.sessionId,
        thread.context === null ? null : JSON.stringify(thread.context),
        thread.createdAt,
        thread.updatedAt,
        thread.sessionGeneration ?? 0,
        thread.selectionVersion ?? 0,
        thread.speed ?? null,
      );
  }

  getThread(threadId: string): ThreadSummary | null {
    const row = this.db.query("SELECT *, (SELECT MAX(created_at) FROM messages WHERE thread_id = threads.id AND role = 'user') AS last_user_message_at FROM threads WHERE id = ?").get(threadId) as ThreadRow | null;
    return row === null ? null : toThread(row);
  }

  listThreads(projectId?: string): ThreadSummary[] {
    const rows =
      projectId === undefined
        ? (this.db.query("SELECT *, (SELECT MAX(created_at) FROM messages WHERE thread_id = threads.id AND role = 'user') AS last_user_message_at FROM threads ORDER BY rowid").all() as ThreadRow[])
        : (this.db.query("SELECT *, (SELECT MAX(created_at) FROM messages WHERE thread_id = threads.id AND role = 'user') AS last_user_message_at FROM threads WHERE project_id = ? ORDER BY rowid").all(projectId) as ThreadRow[]);
    return rows.map(toThread);
  }

  deleteThreadsOfProject(projectId: string): string[] {
    const rows = this.db.query('SELECT id FROM threads WHERE project_id = ?').all(projectId) as { id: string }[];
    for (const table of ['turn_requests', 'turns', 'messages', 'processes']) {
      this.db.query(`DELETE FROM ${table} WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)`).run(projectId);
    }
    this.db.query('DELETE FROM threads WHERE project_id = ?').run(projectId);
    return rows.map((row) => row.id);
  }

  // -- sessions -------------------------------------------------------------

  putSession(row: SessionRow): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO sessions (id, token_hash, client_name, client_version, role, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.token_hash, row.client_name, row.client_version, row.role, row.created_at, row.last_seen_at);
  }

  getSessionByHash(tokenHash: string): SessionRow | null {
    return (this.db.query('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as SessionRow | null) ?? null;
  }

  getSession(sessionId: string): SessionRow | null {
    return (this.db.query('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | null) ?? null;
  }

  touchSession(sessionId: string, at: number): void {
    this.db.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, sessionId);
  }

  listSessions(): SessionRow[] {
    return this.db.query('SELECT * FROM sessions ORDER BY rowid').all() as SessionRow[];
  }

  deleteSession(sessionId: string): boolean {
    return this.db.query('DELETE FROM sessions WHERE id = ?').run(sessionId).changes > 0;
  }

  // -- turns ----------------------------------------------------------------

  putTurn(turn: Turn): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO turns (id, thread_id, status, queued_at, started_at, finished_at, usage, error, execution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.id,
        turn.threadId,
        turn.status,
        turn.queuedAt,
        turn.startedAt,
        turn.finishedAt,
        turn.usage === null ? null : JSON.stringify(turn.usage),
        turn.error,
        turn.execution === undefined ? null : JSON.stringify(turn.execution),
      );
  }

  getTurn(turnId: string): Turn | null {
    const row = this.db.query('SELECT * FROM turns WHERE id = ?').get(turnId) as TurnRow | null;
    return row === null ? null : toTurn(row);
  }

  turnRequest(threadId: string, requestId: string): { fingerprint: string; turn_id: string } | null {
    return this.db.query('SELECT fingerprint, turn_id FROM turn_requests WHERE thread_id = ? AND request_id = ?').get(threadId, requestId) as { fingerprint: string; turn_id: string } | null;
  }

  putTurnRequest(threadId: string, requestId: string, fingerprint: string, turnId: string): void {
    this.db.query('INSERT INTO turn_requests (thread_id, request_id, fingerprint, turn_id) VALUES (?, ?, ?, ?)').run(threadId, requestId, fingerprint, turnId);
  }

  listTurns(threadId?: string): Turn[] {
    const rows =
      threadId === undefined
        ? (this.db.query('SELECT * FROM turns ORDER BY rowid').all() as TurnRow[])
        : (this.db.query('SELECT * FROM turns WHERE thread_id = ? ORDER BY rowid').all(threadId) as TurnRow[]);
    return rows.map(toTurn);
  }

  /**
   * The turns a page of messages refers to, plus any turn of the thread still
   * queued or running, in journal order. What `threads.get` hands back instead
   * of every turn: a thousand-turn thread costs the page, not the lot.
   */
  listTurnsFor(threadId: string, turnIds: Iterable<string>): Turn[] {
    const ids = [...new Set(turnIds)];
    const marks = ids.map(() => '?').join(', ');
    const where = ids.length === 0 ? '' : ` OR id IN (${marks})`;
    const rows = this.db
      .query(`SELECT * FROM turns WHERE thread_id = ? AND (status IN ('running', 'queued')${where}) ORDER BY rowid`)
      .all(threadId, ...ids) as TurnRow[];
    return rows.map(toTurn);
  }

  unfinishedTurns(): Turn[] {
    const rows = this.db.query("SELECT * FROM turns WHERE status IN ('running', 'queued') ORDER BY rowid").all() as TurnRow[];
    return rows.map(toTurn);
  }

  /**
   * Finished turns summed per bucket, provider and model: bucket `i` holds the
   * turns with `edges[i] <= finished_at < edges[i + 1]`. A turn saved before
   * execution snapshots counts under its thread's provider and model. Token
   * counts are summed as each provider reported them.
   */
  usageByBucket(edges: readonly number[]): UsageSumRow[] {
    return this.db
      .query(
        `WITH e AS (SELECT CAST(key AS INTEGER) AS i, value AS lo, LEAD(value) OVER (ORDER BY CAST(key AS INTEGER)) AS hi FROM json_each(?)),
         x AS (
           SELECT e.i AS bucket, t.thread_id, t.usage,
             COALESCE(json_extract(t.execution, '$.providerId'), th.provider_id, '') AS provider_id,
             CASE WHEN t.execution IS NULL THEN th.model ELSE json_extract(t.execution, '$.model') END AS model
           FROM e JOIN turns t ON t.finished_at >= e.lo AND t.finished_at < e.hi
           LEFT JOIN threads th ON th.id = t.thread_id
           WHERE e.hi IS NOT NULL
         )
         SELECT bucket, provider_id, model, ${USAGE_SUMS}
         FROM x GROUP BY bucket, provider_id, model ORDER BY bucket, provider_id, model`,
      )
      .all(JSON.stringify(edges)) as UsageSumRow[];
  }

  /**
   * The same sums per thread and provider over `[from, to)`, with what a list
   * needs to name each thread.
   */
  usageByThread(from: number, to: number): UsageThreadRow[] {
    return this.db
      .query(
        `WITH x AS (
           SELECT t.thread_id, t.usage,
             COALESCE(json_extract(t.execution, '$.providerId'), th.provider_id, '') AS provider_id
           FROM turns t LEFT JOIN threads th ON th.id = t.thread_id
           WHERE t.finished_at >= ? AND t.finished_at < ?
         )
         SELECT x.thread_id, x.provider_id, COALESCE(th.title, '') AS title, COALESCE(th.project_id, '') AS project_id,
           COALESCE(th.provider_id, '') AS thread_provider_id, COALESCE(th.archived, 0) AS archived, ${USAGE_SUMS}
         FROM x LEFT JOIN threads th ON th.id = x.thread_id
         GROUP BY x.thread_id, x.provider_id`,
      )
      .all(from, to) as UsageThreadRow[];
  }

  // -- messages -------------------------------------------------------------

  putMessage(message: Message): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO messages (id, thread_id, turn_id, role, parts, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.threadId,
        message.turnId,
        message.role,
        JSON.stringify(message.parts),
        message.state,
        message.createdAt,
      );
  }

  getMessage(messageId: string): Message | null {
    const row = this.db.query('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | null;
    return row === null ? null : toMessage(row);
  }

  listMessages(threadId: string): Message[] {
    const rows = this.db
      .query('SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid')
      .all(threadId) as MessageRow[];
    return rows.map(toMessage);
  }

  lastUserMessage(threadId: string, turnId: string): Message | null {
    const row = this.db.query("SELECT * FROM messages WHERE thread_id = ? AND turn_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1")
      .get(threadId, turnId) as MessageRow | null;
    return row === null ? null : toMessage(row);
  }

  *walkTurnMessages(threadId: string, turnId: string): Iterable<Message> {
    const statement = this.db.prepare('SELECT * FROM messages WHERE thread_id = ? AND turn_id = ? ORDER BY rowid');
    try {
      for (const row of statement.iterate(threadId, turnId)) yield toMessage(row as MessageRow);
    } finally { statement.finalize(); }
  }

  /** Stream history for a continuation without loading images from every message at once. */
  *walkMessages(threadId: string): Iterable<Message> {
    // A caller may stop at its current turn. Do not leave a partially consumed
    // cached statement for the next continuation to reuse.
    const statement = this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid');
    try {
      for (const row of statement.iterate(threadId)) yield toMessage(row as MessageRow);
    } finally { statement.finalize(); }
  }

  /**
   * The rowid of one message inside one thread, which is the cursor a page walks
   * back from. Null when that id belongs to no message of that thread.
   */
  messageRowid(threadId: string, messageId: string): number | null {
    const row = this.db
      .query('SELECT rowid AS row FROM messages WHERE id = ? AND thread_id = ?')
      .get(messageId, threadId) as { row: number } | null;
    return row === null ? null : row.row;
  }

  /**
   * One page of a thread's messages, oldest first: the last `limit` of them, or
   * the last `limit` written before `beforeRowid`. `before` names the oldest one
   * returned while the thread still holds older ones, and is null once the page
   * reaches the first message.
   *
   * `messages_by_thread` is `(thread_id)` plus the implicit rowid, so both shapes
   * are an index search, descending, with no sort step and no scan of the rest of
   * the thread.
   */
  listMessagePage(threadId: string, options: { beforeRowid?: number; limit: number }): MessagePage {
    // Subscribers have already received buffered deltas. A reload must not replace
    // those messages with an older projection while the next delta is streaming.
    this.flushDeltas();
    const limit = Math.max(1, Math.trunc(options.limit));
    // One row past the page is what says whether anything is left behind it.
    const rows =
      options.beforeRowid === undefined
        ? (this.db
            .query('SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?')
            .all(threadId, limit + 1) as MessageRow[])
        : (this.db
            .query('SELECT * FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?')
            .all(threadId, options.beforeRowid, limit + 1) as MessageRow[]);
    const older = rows.length > limit;
    const page = (older ? rows.slice(0, limit) : rows).reverse();
    return {
      messages: page.map(toMessage),
      before: older ? (page[0]?.id ?? null) : null,
    };
  }

  setMessagePart(messageId: string, partIndex: number, part: MessagePart): void {
    const message = this.getMessage(messageId);
    if (message === null) return;
    const parts = padParts(message.parts, partIndex);
    parts[partIndex] = part;
    this.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(parts), messageId);
  }

  setMessageState(messageId: string, state: Message['state']): void {
    this.db.query('UPDATE messages SET state = ? WHERE id = ?').run(state, messageId);
  }

  // -- processes ------------------------------------------------------------

  putProcess(record: ProcessRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO processes
         (thread_id, pid, parent_pid, exe, command_line, started_at, exited_at, exit_code, cpu_ms, peak_memory_bytes, io_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.threadId,
        record.pid,
        record.parentPid,
        record.exe,
        record.commandLine,
        record.startedAt,
        record.exitedAt,
        record.exitCode,
        record.cpuMs,
        record.peakMemoryBytes,
        record.ioBytes,
      );
  }

  listProcesses(threadId: string, limit: number): ProcessRecord[] {
    const rows = this.db
      .query('SELECT * FROM processes WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(threadId, limit) as ProcessRow[];
    return rows.map(toProcess);
  }

  processTotals(threadId: string): { processes: number; cpuMs: number; peakMemoryBytes: number } {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS processes, COALESCE(SUM(cpu_ms), 0) AS cpu_ms, COALESCE(MAX(peak_memory_bytes), 0) AS peak
         FROM processes WHERE thread_id = ?`,
      )
      .get(threadId) as { processes: number; cpu_ms: number; peak: number } | null;
    return {
      processes: row?.processes ?? 0,
      cpuMs: row?.cpu_ms ?? 0,
      peakMemoryBytes: row?.peak ?? 0,
    };
  }

  // -- accounts -------------------------------------------------------------

  putAccount(account: Account): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO accounts (id, provider_id, label, isolation_dir, status, identity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        account.providerId,
        account.label,
        account.isolationDir,
        account.status,
        account.identity,
        account.createdAt,
      );
  }

  deleteAccount(accountId: string): void {
    this.db.query('DELETE FROM accounts WHERE id = ?').run(accountId);
  }

  getAccount(accountId: string): Account | null {
    const row = this.db.query('SELECT * FROM accounts WHERE id = ?').get(accountId) as AccountRow | null;
    return row === null ? null : toAccount(row);
  }

  listAccounts(): Account[] {
    const rows = this.db.query('SELECT * FROM accounts ORDER BY rowid').all() as AccountRow[];
    return rows.map(toAccount);
  }

  // -- settings -------------------------------------------------------------

  getSetting(key: string): unknown {
    const row = this.db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null;
    if (row === null) return undefined;
    return parseJson<unknown>(row.value, `settings.value row ${key}`);
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value ?? null));
  }

  private writeEvent(event: JournalEvent): void {
    this.db
      .query('INSERT INTO events (thread_id, ts, type, version, payload) VALUES (?, ?, ?, ?, ?)')
      .run(event.threadId, event.ts ?? Date.now(), event.type, event.version, JSON.stringify(event.payload ?? null));
  }

  private appendToPart(messageId: string, partIndex: number, text: string): void {
    const message = this.getMessage(messageId);
    if (message === null) return;
    const parts = padParts(message.parts, partIndex);
    const part = parts[partIndex];
    // A delta appends to whatever kind of text part sits there: text or thinking.
    if (part !== undefined && (part.type === 'text' || part.type === 'thinking')) {
      parts[partIndex] = { type: part.type, text: part.text + text };
    } else if (part !== undefined && part.type === 'tool') {
      // On a tool part a delta is the input's JSON, still being typed by the model.
      parts[partIndex] = { ...part, inputText: (part.inputText ?? '') + text };
    } else parts[partIndex] = { type: 'text', text };
    this.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(parts), messageId);
  }
}

function padParts(parts: MessagePart[], index: number): MessagePart[] {
  const out = [...parts];
  while (out.length <= index) out.push({ type: 'text', text: '' });
  return out;
}
