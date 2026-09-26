import { Database } from 'bun:sqlite';
import type {
  Account,
  Message,
  MessagePart,
  PairingRole,
  Project,
  ProcessRecord,
  ThreadSummary,
  Timestamp,
  Turn,
} from '@boite/contracts';
import { ensureIndexes, migrate } from './journal/schema.ts';
import { toAccount, toMessage, toProcess, toProject, toThread, toTurn, parseJson } from './journal/rows.ts';
import type { AccountRow, MessageRow, ProcessRow, ProjectRow, ThreadRow, TurnRow } from './journal/rows.ts';
import { messageOfError, StreamBuffer } from './journal/stream-buffer.ts';
import { usageByBucket, usageByThread, type UsageSumRow, type UsageThreadRow } from './journal/usage-sums.ts';

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

/**
 * Append-only event log plus the projections the RPC reads from. Every write
 * goes through `append`, which puts the event and the projection update in the
 * same transaction.
 */
export class Journal {
  readonly db: Database;
  /** The streaming write path: deltas and the parts of messages still streaming. */
  private readonly stream: StreamBuffer;
  private readonly onError: (message: string) => void;
  private closed = false;

  constructor(file: string, options: JournalOptions = {}) {
    this.onError = options.onError ?? ((message) => console.error(message));
    this.db = new Database(file, { create: true });
    this.stream = new StreamBuffer(this.db, this, this.onError);
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
      // A large transaction grows the WAL file; this lets it shrink back at the next checkpoint.
      this.db.exec('PRAGMA journal_size_limit = 33554432');
      this.db.transaction(() => migrate(this.db, file))();
      ensureIndexes(this.db);
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
    this.stream.appendDelta(threadId, messageId, partIndex, text);
  }

  /**
   * Applies the buffered text. Streamed text is no event of its own: it is
   * journaled as the message it lands in, between the `message.started`,
   * `message.part` and `message.completed` events that frame it.
   */
  flushDeltas(): void {
    this.stream.flushDeltas();
  }

  /** Writes the parts of every streaming message whose row is behind. */
  persistMessages(): void {
    this.stream.persistMessages();
  }

  /**
   * The turn is over: whatever message its driver left open is written and no
   * longer held in memory. Its state stays what the driver left.
   */
  releaseTurn(turnId: string): void {
    this.stream.releaseTurn(turnId);
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
      this.stream.clear();
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
    this.stream.forgetThreads(removed);
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

  /** Finished turns summed per bucket, provider and model (`journal/usage-sums.ts`). */
  usageByBucket(edges: readonly number[]): UsageSumRow[] {
    return usageByBucket(this.db, edges);
  }

  /** The same sums per thread and provider over `[from, to)`. */
  usageByThread(from: number, to: number): UsageThreadRow[] {
    return usageByThread(this.db, from, to);
  }

  // -- messages -------------------------------------------------------------

  putMessage(message: Message): void {
    this.stream.track(message);
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
    const open = this.stream.openCopy(messageId);
    if (open !== undefined) return open;
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
    this.stream.setMessagePart(messageId, partIndex, part);
  }

  setMessageState(messageId: string, state: Message['state']): void {
    this.stream.setMessageState(messageId, state);
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
