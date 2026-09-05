import { Database } from 'bun:sqlite';
import type {
  Account,
  Message,
  MessagePart,
  MessageRole,
  Project,
  ProcessRecord,
  ThreadSummary,
  Timestamp,
  Turn,
  Usage,
} from '@boite/contracts';

export const SCHEMA_VERSION = 1;
const DELTA_WINDOW_MS = 16;

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
  id: string;
  project_id: string;
  title: string;
  provider_id: string;
  account_id: string;
  model: string | null;
  cwd: string;
  permission_mode: string;
  status: string;
  unread: number;
  archived: number;
  session_id: string | null;
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

function migrate(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
  let version = row?.user_version ?? 0;
  if (version < 1) {
    db.exec(SCHEMA_V1);
    version = 1;
  }
  db.exec(`PRAGMA user_version = ${version}`);
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, path: row.path, createdAt: row.created_at };
}

function toThread(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    providerId: row.provider_id,
    accountId: row.account_id,
    model: row.model,
    cwd: row.cwd,
    permissionMode: row.permission_mode as ThreadSummary['permissionMode'],
    status: row.status as ThreadSummary['status'],
    unread: row.unread !== 0,
    archived: row.archived !== 0,
    sessionId: row.session_id,
    load: null,
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
    usage: row.usage === null ? null : parseJson<Usage | null>(row.usage, null),
    error: row.error,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    role: row.role as MessageRole,
    parts: parseJson<MessagePart[]>(row.parts, []),
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
    migrate(this.db);
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
         (id, project_id, title, provider_id, account_id, model, cwd, permission_mode, status, unread, archived, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.title,
        thread.providerId,
        thread.accountId,
        thread.model,
        thread.cwd,
        thread.permissionMode,
        thread.status,
        thread.unread ? 1 : 0,
        thread.archived ? 1 : 0,
        thread.sessionId,
        thread.createdAt,
        thread.updatedAt,
      );
  }

  getThread(threadId: string): ThreadSummary | null {
    const row = this.db.query('SELECT * FROM threads WHERE id = ?').get(threadId) as ThreadRow | null;
    return row === null ? null : toThread(row);
  }

  listThreads(projectId?: string): ThreadSummary[] {
    const rows =
      projectId === undefined
        ? (this.db.query('SELECT * FROM threads ORDER BY rowid').all() as ThreadRow[])
        : (this.db.query('SELECT * FROM threads WHERE project_id = ? ORDER BY rowid').all(projectId) as ThreadRow[]);
    return rows.map(toThread);
  }

  deleteThreadsOfProject(projectId: string): string[] {
    const rows = this.db.query('SELECT id FROM threads WHERE project_id = ?').all(projectId) as { id: string }[];
    this.db.query('DELETE FROM threads WHERE project_id = ?').run(projectId);
    return rows.map((row) => row.id);
  }

  // -- turns ----------------------------------------------------------------

  putTurn(turn: Turn): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO turns (id, thread_id, status, queued_at, started_at, finished_at, usage, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  getTurn(turnId: string): Turn | null {
    const row = this.db.query('SELECT * FROM turns WHERE id = ?').get(turnId) as TurnRow | null;
    return row === null ? null : toTurn(row);
  }

  listTurns(threadId?: string): Turn[] {
    const rows =
      threadId === undefined
        ? (this.db.query('SELECT * FROM turns ORDER BY rowid').all() as TurnRow[])
        : (this.db.query('SELECT * FROM turns WHERE thread_id = ? ORDER BY rowid').all(threadId) as TurnRow[]);
    return rows.map(toTurn);
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
    return parseJson<unknown>(row.value, undefined);
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
    if (part !== undefined && part.type === 'text') parts[partIndex] = { type: 'text', text: part.text + text };
    else parts[partIndex] = { type: 'text', text };
    this.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(parts), messageId);
  }
}

function padParts(parts: MessagePart[], index: number): MessagePart[] {
  const out = [...parts];
  while (out.length <= index) out.push({ type: 'text', text: '' });
  return out;
}
