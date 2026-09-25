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

export const SCHEMA_VERSION = 18;
const DELTA_WINDOW_MS = 16;
/** The shortest wait before a streaming message's parts are written to its row. */
const PERSIST_MS = 500;
/** A slow write stretches the wait so that writing takes at most 1/PERSIST_SHARE of the time. */
const PERSIST_SHARE = 20;
const PERSIST_MAX_MS = 5_000;
/** A delta whose write keeps failing is dropped after this many tries, and the loss reported. */
const DELTA_ATTEMPTS = 3;

/** Raised when the journal was written by a newer core than this one. */
export class JournalTooNewError extends Error {
  constructor(readonly file: string, readonly found: number, readonly supported: number) {
    super(`${file} has journal schema ${found}, and this Boite reads up to ${supported}. Install the newer release again, or restore the backup made before it.`);
    this.name = 'JournalTooNewError';
  }
}

export interface JournalOptions {
  /** Where a write that fails on a timer, with no caller to throw to, is reported. */
  onError?: (message: string) => void;
}

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
  attempts?: number;
}

/**
 * A message still streaming. Its parts live here and reach the row on a timer,
 * so a delta or a tool card costs a change in memory instead of a rewrite of a
 * row that holds every part of the turn.
 */
interface OpenMessage {
  message: Message;
  dirty: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

interface ThreadRow {
  parent_thread_id: string | null;
  last_user_message_at?: number | null;
  id: string;
  project_id: string | null;
  agent_session_id?: string | null;
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
  prompt_cache: string | null;
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
  project_id: string | null;
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

function migrate(db: Database, file: string): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
  let version = row?.user_version ?? 0;
  // An older core must not write a schema it does not know: it would stamp its
  // own version on it and skip what the newer one relies on.
  if (version > SCHEMA_VERSION) throw new JournalTooNewError(file, version, SCHEMA_VERSION);
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
  // `foreign_keys` is off, so the REFERENCES ... ON DELETE CASCADE clauses below
  // are dead and deleteThreadsOfProject clears these tables itself. Turning it
  // on first needs putThread and putTurn moved from INSERT OR REPLACE to
  // INSERT ... ON CONFLICT(id) DO UPDATE: a REPLACE deletes the old row, and the
  // cascade would wipe that thread's coordination rows and that turn's request
  // keys on every save.
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
  // The prompt cache the last turn left, as JSON (`PromptCache`).
  if (!db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'prompt_cache'").get()) { db.exec('ALTER TABLE threads ADD COLUMN prompt_cache TEXT'); version = 13; }
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'delegated_agents'").get()) {
    db.transaction(() => {
      db.exec(`ALTER TABLE threads ADD COLUMN parent_thread_id TEXT;
        CREATE INDEX threads_parent ON threads(parent_thread_id);
        CREATE TABLE delegated_agents (
          thread_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, request_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, profile_id TEXT NOT NULL, task TEXT NOT NULL,
          UNIQUE(root_id, request_id)
        );
        CREATE INDEX delegated_root ON delegated_agents(root_id);
        CREATE TABLE delegation_messages (
          id TEXT PRIMARY KEY, root_id TEXT NOT NULL, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
          request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
          created_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(sender_id, request_id)
        );
        CREATE INDEX delegation_inbox ON delegation_messages(recipient_id, status, created_at);
        CREATE INDEX delegation_pending ON delegation_messages(status, created_at);
        CREATE INDEX delegation_history ON delegation_messages(root_id, created_at);`);
    })();
  }
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'agent_entities'").get()) {
    db.exec(`CREATE TABLE agent_entities (
      kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind, id)
    );
    CREATE UNIQUE INDEX agent_session_context ON agent_entities (
      json_extract(data, '$.agentId'), json_extract(data, '$.scope.kind'), json_extract(data, '$.scope.id')
    ) WHERE kind = 'session';
    CREATE UNIQUE INDEX agent_delivery_recipient ON agent_entities (
      json_extract(data, '$.messageId'), json_extract(data, '$.agentId')
    ) WHERE kind = 'delivery';
    CREATE INDEX agent_work_status ON agent_entities (json_extract(data, '$.status'), created_at) WHERE kind = 'work';
    CREATE INDEX agent_run_status ON agent_entities (json_extract(data, '$.status'), created_at) WHERE kind = 'run';
    CREATE TABLE agent_requests (
      actor TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(actor, request_id)
    );`);
    version = 13;
  }
  if (!db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'agent_session_id'").get()) {
    // Rebuild only this table to remove NOT NULL; preserve every existing column and row.
    const definition = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get() as { sql: string };
    const indexes = db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'threads' AND sql IS NOT NULL").all() as { sql: string }[];
    const replacement = definition.sql.replace(/CREATE TABLE (?:IF NOT EXISTS )?["`\[]?threads["`\]]?/i, 'CREATE TABLE threads_next').replace(/project_id TEXT NOT NULL/i, 'project_id TEXT');
    db.exec(replacement);
    db.exec('INSERT INTO threads_next SELECT * FROM threads');
    db.exec('DROP TABLE threads');
    db.exec('ALTER TABLE threads_next RENAME TO threads');
    db.exec('ALTER TABLE threads ADD COLUMN agent_session_id TEXT');
    for (const index of indexes) db.exec(index.sql);
    version = 15;
  }
  // Agent history grows without bound: targeted lookups and newest-first pages go through these, never a whole kind.
  // A partial index serves only queries naming the same literal kind, which AgentsRepository does.
  // IF NOT EXISTS: dropping agent_entities drops its indexes but keeps events_agents.
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'agent_recent'").get()) {
    db.exec(`CREATE INDEX IF NOT EXISTS agent_recent ON agent_entities (kind, updated_at, id);
      CREATE INDEX IF NOT EXISTS agent_session_thread ON agent_entities (json_extract(data, '$.threadId')) WHERE kind = 'session';
      CREATE INDEX IF NOT EXISTS agent_message_source_run ON agent_entities (json_extract(data, '$.sourceRunId')) WHERE kind = 'message';
      CREATE INDEX IF NOT EXISTS agent_message_scope ON agent_entities (json_extract(data, '$.scope.kind'), json_extract(data, '$.scope.id'), updated_at, id) WHERE kind = 'message';
      CREATE INDEX IF NOT EXISTS agent_work_episode ON agent_entities (json_extract(data, '$.episodeId')) WHERE kind = 'work';
      CREATE INDEX IF NOT EXISTS agent_work_scope ON agent_entities (json_extract(data, '$.scope.kind'), json_extract(data, '$.scope.id'), updated_at, id) WHERE kind = 'work';
      CREATE INDEX IF NOT EXISTS agent_work_agent ON agent_entities (json_extract(data, '$.agentId'), updated_at, id) WHERE kind = 'work';
      CREATE INDEX IF NOT EXISTS agent_memory_scope ON agent_entities (json_extract(data, '$.scope.kind'), json_extract(data, '$.scope.id'), updated_at, id) WHERE kind = 'memory';
      CREATE INDEX IF NOT EXISTS agent_delivery_work ON agent_entities (json_extract(data, '$.workId')) WHERE kind = 'delivery';
      CREATE INDEX IF NOT EXISTS agent_run_work ON agent_entities (json_extract(data, '$.workId')) WHERE kind = 'run';
      CREATE INDEX IF NOT EXISTS agent_run_thread ON agent_entities (json_extract(data, '$.threadId'), json_extract(data, '$.finishedAt')) WHERE kind = 'run';
      CREATE INDEX IF NOT EXISTS agent_decision_work ON agent_entities (json_extract(data, '$.workId')) WHERE kind = 'decision';
      CREATE INDEX IF NOT EXISTS events_agents ON events (id) WHERE type IN ('agents.record', 'agents.limits');`);
    version = 16;
  }
  // The coordination sweep filters letters by status and direction every two seconds,
  // and delivered, expired and rejected letters pile up behind the few it looks for.
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'coordination_status'").get()) {
    db.exec('CREATE INDEX IF NOT EXISTS coordination_status ON coordination_letters (status, direction, created_at)');
    version = 17;
  }
  // Request receipts are kept a month, then dropped: the rows already there count from now.
  if (!db.query("SELECT 1 FROM pragma_table_info('agent_requests') WHERE name = 'created_at'").get()) {
    db.exec(`ALTER TABLE agent_requests ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      UPDATE agent_requests SET created_at = ${Date.now()};
      CREATE INDEX IF NOT EXISTS agent_requests_created ON agent_requests (created_at);`);
    version = 18;
  }
  version = Math.max(version, SCHEMA_VERSION);
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
    ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id } : {}),
    lastUserMessageAt: row.last_user_message_at ?? null,
    id: row.id,
    projectId: row.project_id,
    ...(row.agent_session_id ? { agentSessionId: row.agent_session_id } : {}),
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
    promptCache: row.prompt_cache === null ? null : parseJson<ThreadSummary['promptCache']>(row.prompt_cache, `threads.prompt_cache of ${row.id}`),
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
  private readonly open = new Map<string, OpenMessage>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistDelay = PERSIST_MS;
  private readonly onError: (message: string) => void;
  private closed = false;

  constructor(file: string, options: JournalOptions = {}) {
    this.onError = options.onError ?? ((message) => console.error(message));
    this.db = new Database(file, { create: true });
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
      // A large transaction grows the WAL file; this lets it shrink back at the next checkpoint.
      this.db.exec('PRAGMA journal_size_limit = 33554432');
      this.db.transaction(() => migrate(this.db, file))();
      this.db.exec('CREATE INDEX IF NOT EXISTS turns_by_status ON turns (status)');
      this.db.exec('CREATE INDEX IF NOT EXISTS messages_by_turn ON messages (thread_id, turn_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS turns_by_finished ON turns (finished_at)');
    } catch (error) {
      this.db.close(false);
      throw error;
    }
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
    this.armDeltaTimer();
  }

  /**
   * Applies the buffered text. Streamed text is no event of its own: it is
   * journaled as the message it lands in, between the `message.started`,
   * `message.part` and `message.completed` events that frame it.
   */
  flushDeltas(): void {
    if (this.deltaTimer !== null) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    if (this.deltas.size === 0 || this.closed) return;
    const items = [...this.deltas.values()];
    this.deltas.clear();
    const stored: PendingDelta[] = [];
    for (const item of items) {
      if (this.open.has(item.messageId)) this.appendToPart(item.messageId, item.partIndex, item.text);
      else stored.push(item);
    }
    if (stored.length === 0) return;
    try {
      this.db.transaction(() => {
        for (const item of stored) this.appendToPart(item.messageId, item.partIndex, item.text);
      })();
    } catch (error) {
      this.requeue(stored);
      throw error;
    }
  }

  /** Writes the parts of every streaming message whose row is behind. */
  persistMessages(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.closed) return;
    const dirty = [...this.open.values()].filter((entry) => entry.dirty);
    if (dirty.length === 0) return;
    // Under a caller's transaction the write below is only a savepoint, which
    // that caller can still roll back: the parts are written but stay dirty,
    // and the timer writes them again on their own.
    const nested = this.db.inTransaction;
    const started = performance.now();
    const write = this.db.query('UPDATE messages SET parts = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const entry of dirty) write.run(JSON.stringify(entry.message.parts), entry.message.id);
    })();
    if (nested) {
      this.armPersistTimer();
      return;
    }
    // Clean only once committed: a rolled-back write stays dirty for the next try.
    for (const entry of dirty) entry.dirty = false;
    const elapsed = performance.now() - started;
    this.persistDelay = Math.min(PERSIST_MAX_MS, Math.max(PERSIST_MS, Math.round(elapsed * PERSIST_SHARE)));
  }

  /**
   * The turn is over: whatever message its driver left open is written and no
   * longer held in memory. Its state stays what the driver left.
   */
  releaseTurn(turnId: string): void {
    this.flushDeltas();
    for (const [id, entry] of this.open) {
      if (entry.message.turnId !== turnId) continue;
      // Written whatever the flag says: it can be clean after a write a caller's
      // transaction rolled back, and the memory copy is dropped right after.
      this.writeParts(entry);
      this.open.delete(id);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Looks at the `limit` oldest events and deletes those written before
   * `before`; 0 means nothing old is left at the front. Only the front is read,
   * never the whole table: ids grow with time. Nothing replays events, since
   * the projections are written in the same transaction. The newest agents
   * event stays, because its id is the agents revision and must never go back.
   */
  pruneEvents(before: number, limit: number): number {
    if (this.closed) return 0;
    return this.db
      .query(
        `DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id LIMIT ?) AND ts < ?
           AND id IS NOT (SELECT MAX(id) FROM events WHERE type IN ('agents.record', 'agents.limits'))`,
      )
      .run(limit, before).changes;
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
    try {
      this.flushDeltas();
      this.persistMessages();
    } finally {
      this.open.clear();
      this.closed = true;
      this.db.close(false);
    }
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
         (id, project_id, title, title_source, provider_id, account_id, model, effort, cwd, branch, permission_mode, status, unread, archived, pinned, session_id, context, created_at, updated_at, session_generation, selection_version, speed, parent_thread_id, prompt_cache, agent_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        thread.parentThreadId ?? null,
        thread.promptCache ? JSON.stringify(thread.promptCache) : null,
        thread.agentSessionId ?? null,
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
    const removed = new Set(rows.map((row) => row.id));
    for (const [id, entry] of this.open) if (removed.has(entry.message.threadId)) this.open.delete(id);
    // Foreign keys are off, so the ON DELETE CASCADE clauses never fire: every
    // table keyed by thread is cleared here, events included, so a removed
    // project's prompts and tool output leave the disk.
    for (const table of ['turn_requests', 'turns', 'messages', 'processes', 'coordination_letters', 'coordination_wakes', 'events']) {
      this.db.query(`DELETE FROM ${table} WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)`).run(projectId);
    }
    this.db.query("DELETE FROM settings WHERE key IN (SELECT 'activity:' || id FROM threads WHERE project_id = ?)").run(projectId);
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
         SELECT x.thread_id, x.provider_id, COALESCE(th.title, '') AS title, th.project_id,
           COALESCE(th.provider_id, '') AS thread_provider_id, COALESCE(th.archived, 0) AS archived, ${USAGE_SUMS}
         FROM x LEFT JOIN threads th ON th.id = x.thread_id
         GROUP BY x.thread_id, x.provider_id`,
      )
      .all(from, to) as UsageThreadRow[];
  }

  // -- messages -------------------------------------------------------------

  putMessage(message: Message): void {
    if (message.state === 'streaming') this.open.set(message.id, { message: { ...message, parts: [...message.parts] }, dirty: false });
    else this.open.delete(message.id);
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
    const open = this.open.get(messageId);
    if (open !== undefined) return { ...open.message, parts: [...open.message.parts] };
    const row = this.db.query('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | null;
    return row === null ? null : toMessage(row);
  }

  listMessages(threadId: string): Message[] {
    this.persistMessages();
    const rows = this.db
      .query('SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid')
      .all(threadId) as MessageRow[];
    return rows.map(toMessage);
  }

  lastUserMessage(threadId: string, turnId: string): Message | null {
    this.persistMessages();
    const row = this.db.query("SELECT * FROM messages WHERE thread_id = ? AND turn_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1")
      .get(threadId, turnId) as MessageRow | null;
    return row === null ? null : toMessage(row);
  }

  *walkTurnMessages(threadId: string, turnId: string): Iterable<Message> {
    this.persistMessages();
    const statement = this.db.prepare('SELECT * FROM messages WHERE thread_id = ? AND turn_id = ? ORDER BY rowid');
    try {
      for (const row of statement.iterate(threadId, turnId)) yield toMessage(row as MessageRow);
    } finally { statement.finalize(); }
  }

  /** Stream history for a continuation without loading images from every message at once. */
  *walkMessages(threadId: string): Iterable<Message> {
    // A caller may stop at its current turn. Do not leave a partially consumed
    // cached statement for the next continuation to reuse.
    this.persistMessages();
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
    this.persistMessages();
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

  /** That message and what was written after it, oldest first, or null when that is more than `limit`. */
  listMessagesFrom(threadId: string, fromRowid: number, limit: number): Message[] | null {
    this.flushDeltas();
    this.persistMessages();
    const rows = this.db
      .query('SELECT * FROM messages WHERE thread_id = ? AND rowid >= ? ORDER BY rowid ASC LIMIT ?')
      .all(threadId, fromRowid, limit + 1) as MessageRow[];
    return rows.length > limit ? null : rows.map(toMessage);
  }

  setMessagePart(messageId: string, partIndex: number, part: MessagePart): void {
    const open = this.open.get(messageId);
    if (open !== undefined) {
      padInPlace(open.message.parts, partIndex);
      open.message.parts[partIndex] = part;
      this.markDirty(open);
      return;
    }
    const message = this.getMessage(messageId);
    if (message === null) return;
    const parts = padParts(message.parts, partIndex);
    parts[partIndex] = part;
    this.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(parts), messageId);
  }

  setMessageState(messageId: string, state: Message['state']): void {
    const open = this.open.get(messageId);
    // Written whatever the flag says when the memory copy goes: a clean flag can
    // follow a write that a caller's transaction rolled back.
    if (open !== undefined && (open.dirty || state !== 'streaming')) this.writeParts(open);
    if (state !== 'streaming') this.open.delete(messageId);
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

  /**
   * Drops the trace of an id no thread stands behind: a plugin call, a brain
   * sync, a dictation. No RPC reads those rows, and a caller minting an id per
   * call would otherwise add rows for the life of the install.
   */
  forgetProcessesWithoutThread(threadId: string): void {
    this.db
      .query('DELETE FROM processes WHERE thread_id = ? AND NOT EXISTS (SELECT 1 FROM threads WHERE id = ?)')
      .run(threadId, threadId);
  }

  /** Process count, CPU time and peak memory of every thread that ran something, in one scan. */

  processTotalsByThread(): Map<string, { processes: number; cpuMs: number; peakMemoryBytes: number }> {
    const rows = this.db
      .query(
        `SELECT thread_id, COUNT(*) AS processes, COALESCE(SUM(cpu_ms), 0) AS cpu_ms, COALESCE(MAX(peak_memory_bytes), 0) AS peak
         FROM processes GROUP BY thread_id`,
      )
      .all() as { thread_id: string; processes: number; cpu_ms: number; peak: number }[];
    return new Map(rows.map((row) => [row.thread_id, { processes: row.processes, cpuMs: row.cpu_ms, peakMemoryBytes: row.peak }]));
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

  deleteSetting(key: string): void {
    this.db.query('DELETE FROM settings WHERE key = ?').run(key);
  }

  private writeEvent(event: JournalEvent): void {
    this.db
      .query('INSERT INTO events (thread_id, ts, type, version, payload) VALUES (?, ?, ?, ?, ?)')
      .run(event.threadId, event.ts ?? Date.now(), event.type, event.version, JSON.stringify(event.payload ?? null));
  }

  private appendToPart(messageId: string, partIndex: number, text: string): void {
    const open = this.open.get(messageId);
    if (open !== undefined) {
      padInPlace(open.message.parts, partIndex);
      appendText(open.message.parts, partIndex, text);
      this.markDirty(open);
      return;
    }
    const message = this.getMessage(messageId);
    if (message === null) return;
    const parts = padParts(message.parts, partIndex);
    appendText(parts, partIndex, text);
    this.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(parts), messageId);
  }

  private markDirty(entry: OpenMessage): void {
    entry.dirty = true;
    this.armPersistTimer();
  }

  private armPersistTimer(): void {
    if (this.persistTimer !== null || this.closed) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.persistMessages();
      } catch (error) {
        // The parts stay dirty in memory: the next change or read writes them again.
        this.onError(`journal message write: ${messageOfError(error)}`);
      }
    }, this.persistDelay);
    this.persistTimer.unref?.();
  }

  private writeParts(entry: OpenMessage): void {
    this.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(entry.message.parts), entry.message.id);
    // A write inside a caller's transaction is not committed yet: it stays dirty.
    if (!this.db.inTransaction) entry.dirty = false;
  }

  private armDeltaTimer(): void {
    if (this.deltaTimer !== null || this.closed) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = null;
      // No caller to throw to: an error thrown from a timer ends the whole process.
      try {
        this.flushDeltas();
      } catch (error) {
        this.onError(`journal delta flush: ${messageOfError(error)}`);
      }
    }, DELTA_WINDOW_MS);
  }

  /**
   * Puts back the text of a failed flush, ahead of anything newer for the same
   * part. The next flush, from the next delta, event or close, tries it again.
   */
  private requeue(items: PendingDelta[]): void {
    for (const item of items) {
      const attempts = (item.attempts ?? 0) + 1;
      if (attempts >= DELTA_ATTEMPTS) {
        this.onError(`journal dropped ${item.text.length} characters of message ${item.messageId} part ${item.partIndex} after ${attempts} failed writes`);
        continue;
      }
      const key = `${item.messageId}|${item.partIndex}`;
      const current = this.deltas.get(key);
      if (current) {
        current.text = item.text + current.text;
        current.attempts = attempts;
      } else this.deltas.set(key, { ...item, attempts });
    }
  }
}

/** How long events are kept. The projections hold the state; events are the recent trail. */
export const EVENT_RETENTION_MS = 30 * 86_400_000;
const RETENTION_FIRST_MS = 60_000;
const RETENTION_EVERY_MS = 86_400_000;
const RETENTION_BATCH = 5_000;

/**
 * Prunes events past the retention a minute after start and then daily, one
 * batch per timer tick so that no pass holds the event loop on an old machine.
 * Returns the stop.
 */
export function scheduleEventRetention(journal: Journal, onError: (message: string) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (delay: number): void => {
    timer = setTimeout(pass, delay);
    timer.unref?.();
  };
  const pass = (): void => {
    timer = null;
    if (journal.isClosed()) return;
    try {
      if (journal.pruneEvents(Date.now() - EVENT_RETENTION_MS, RETENTION_BATCH) > 0) {
        arm(10);
        return;
      }
    } catch (error) {
      onError(`journal event retention: ${messageOfError(error)}`);
    }
    arm(RETENTION_EVERY_MS);
  };
  arm(RETENTION_FIRST_MS);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function padParts(parts: MessagePart[], index: number): MessagePart[] {
  const out = [...parts];
  padInPlace(out, index);
  return out;
}

function padInPlace(parts: MessagePart[], index: number): void {
  while (parts.length <= index) parts.push({ type: 'text', text: '' });
}

/** A delta appends to whatever kind of text part sits there: text or thinking. */
function appendText(parts: MessagePart[], index: number, text: string): void {
  const part = parts[index];
  if (part !== undefined && (part.type === 'text' || part.type === 'thinking')) {
    parts[index] = { type: part.type, text: part.text + text };
  } else if (part !== undefined && part.type === 'tool') {
    // On a tool part a delta is the input's JSON, still being typed by the model.
    parts[index] = { ...part, inputText: (part.inputText ?? '') + text };
  } else parts[index] = { type: 'text', text };
}
