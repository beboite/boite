import { Database } from 'bun:sqlite';
import { MESSAGE_PAGE_MAX_BYTES, RPC_MAX_FRAME_BYTES } from '@boite/contracts';
import type {
  Account,
  DeletedThreadSummary,
  Message,
  MessagePart,
  PairingRole,
  Project,
  ProcessRecord,
  QuestionRequest,
  ThreadSummary,
  Timestamp,
  Turn,
} from '@boite/contracts';
import { migrate } from './journal/schema.ts';
import { toAccount, toMessage, toProcess, toProject, toThread, toTurn, parseJson } from './journal/rows.ts';
import type { AccountRow, MessageRow, ProcessRow, ProjectIconRow, ProjectRow, ThreadRow, TurnRow } from './journal/rows.ts';
import type { DetectedIcon as StoredProjectIcon } from './project-icons.ts';
import { messageOfError, StreamBuffer } from './journal/stream-buffer.ts';
import { usageByBucket, usageByThread, type UsageSumRow, type UsageThreadRow } from './journal/usage-sums.ts';
import { refused } from './errors.ts';

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
   * never the whole table: ids grow with time. Nothing replays events but
   * `openAsyncQuestions`, since the projections are written in the same transaction. The newest agents
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
      .query('INSERT OR REPLACE INTO projects (id, name, path, created_at, archived, worktree_default) VALUES (?, ?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.path, project.createdAt, project.archived === true ? 1 : 0, project.worktreeDefault === true ? 1 : 0);
  }

  /** How many of a project's own threads are archived, sub-threads left out, per project id. */
  archivedThreadCounts(): Map<string, number> {
    const rows = this.db
      .query('SELECT project_id, COUNT(*) AS count FROM threads WHERE archived = 1 AND parent_thread_id IS NULL AND project_id IS NOT NULL AND id NOT IN (SELECT thread_id FROM thread_deletions) GROUP BY project_id')
      .all() as { project_id: string; count: number }[];
    return new Map(rows.map((row) => [row.project_id, row.count]));
  }

  deleteProject(projectId: string): void {
    this.deleteSetting(`project-auto-archive-merged-pr:${projectId}`);
    this.deleteSetting(`todos:${projectId}`);
    this.db.query('DELETE FROM projects WHERE id = ?').run(projectId);
    this.db.query('DELETE FROM project_icons WHERE project_id = ?').run(projectId);
    this.db.query('DELETE FROM workflow_templates WHERE project_id = ?').run(projectId);
  }

  /** What every project's icon reads as, bytes left out: one small query per list. */
  projectIcons(): Map<string, ProjectIconRow> {
    const rows = this.db.query('SELECT project_id, kind, tech, version FROM project_icons').all() as (ProjectIconRow & { project_id: string })[];
    return new Map(rows.map(({ project_id, ...row }) => [project_id, row]));
  }

  /** The stored image of a project, or null when its icon is not one. */
  projectIconImage(projectId: string): { mime: string; data: Uint8Array; version: string } | null {
    const row = this.db
      .query("SELECT mime, data, version FROM project_icons WHERE project_id = ? AND kind = 'image'")
      .get(projectId) as { mime: string | null; data: Uint8Array | null; version: string | null } | null;
    if (row === null || row.mime === null || row.data === null || row.version === null) return null;
    return { mime: row.mime, data: row.data, version: row.version };
  }

  putProjectIcon(projectId: string, icon: StoredProjectIcon, checkedAt: number): void {
    this.db
      .query('INSERT OR REPLACE INTO project_icons (project_id, kind, tech, mime, data, version, source, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        projectId,
        icon.kind,
        icon.kind === 'tech' ? icon.id : null,
        icon.kind === 'image' ? icon.mime : null,
        icon.kind === 'image' ? icon.bytes : null,
        icon.kind === 'image' ? icon.version : null,
        icon.kind === 'image' ? icon.source : null,
        checkedAt,
      );
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
         (id, project_id, title, title_source, provider_id, account_id, model, effort, cwd, branch, permission_mode, status, unread, archived, pinned, session_id, context, created_at, updated_at, session_generation, selection_version, speed, parent_thread_id, prompt_cache, agent_session_id, session_resume_at, title_state, branch_naming_pending, fork_origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        thread.sessionResumeAt ?? null,
        thread.titleState ? JSON.stringify(thread.titleState) : null,
        thread.branchNamingPending === true ? 1 : 0,
        thread.forkOrigin ? JSON.stringify(thread.forkOrigin) : null,
      );
  }

  getThread(threadId: string): ThreadSummary | null {
    const row = this.db.query("SELECT *, (SELECT MAX(created_at) FROM messages WHERE thread_id = threads.id AND role = 'user') AS last_user_message_at FROM threads WHERE id = ? AND id NOT IN (SELECT thread_id FROM thread_deletions)").get(threadId) as ThreadRow | null;
    return row === null ? null : toThread(row);
  }

  listThreads(projectId?: string): ThreadSummary[] {
    const rows =
      projectId === undefined
        ? (this.db.query("SELECT *, (SELECT MAX(created_at) FROM messages WHERE thread_id = threads.id AND role = 'user') AS last_user_message_at FROM threads WHERE id NOT IN (SELECT thread_id FROM thread_deletions) ORDER BY rowid").all() as ThreadRow[])
        : (this.db.query("SELECT *, (SELECT MAX(created_at) FROM messages WHERE thread_id = threads.id AND role = 'user') AS last_user_message_at FROM threads WHERE project_id = ? AND id NOT IN (SELECT thread_id FROM thread_deletions) ORDER BY rowid").all(projectId) as ThreadRow[]);
    return rows.map(toThread);
  }

  /** Keep full hydration's corruption errors before startup recovery writes. */
  validateVisibleThreadJson(): void {
    // SQLite's JSON depth and storage-type rules differ from the JavaScript row parser.
    const candidates = this.db.query(`SELECT id FROM threads WHERE id NOT IN (SELECT thread_id FROM thread_deletions)
      AND ((context IS NOT NULL AND (typeof(context) <> 'text' OR NOT json_valid(context)))
        OR (prompt_cache IS NOT NULL AND (typeof(prompt_cache) <> 'text' OR NOT json_valid(prompt_cache)))
        OR (title_state IS NOT NULL AND title_state <> '' AND (typeof(title_state) <> 'text' OR NOT json_valid(title_state)))) ORDER BY rowid`).all() as { id: string }[];
    for (const thread of candidates) this.getThread(thread.id);
  }

  deleteThreadsOfProject(projectId: string): string[] {
    const rows = this.db.query('SELECT id FROM threads WHERE project_id = ?').all(projectId) as { id: string }[];
    const ids = rows.map(row => row.id);
    this.deleteThreads(ids);
    return ids;
  }

  /** Hide the stopped family while keeping its rows and deletion time across restarts. */
  stageThreadDeletion(rootId: string, threads: ThreadSummary[]): void {
    this.flushDeltas();
    this.persistMessages();
    const now = Date.now();
    this.db.transaction(() => {
      for (const thread of threads) this.db.query('INSERT INTO thread_deletions VALUES (?, ?, ?, ?)').run(thread.id, rootId, thread.archived ? 1 : 0, now);
    })();
    this.stream.forgetThreads(new Set(threads.map(t => t.id)));
  }

  listDeletedThreads(): DeletedThreadSummary[] {
    const rows = this.db.query(`SELECT t.*, d.deleted_at, (SELECT MAX(created_at) FROM messages WHERE thread_id = t.id AND role = 'user') AS last_user_message_at
      FROM threads t JOIN thread_deletions d ON t.id = d.thread_id
      WHERE d.root_id = t.id ORDER BY d.deleted_at DESC, d.rowid DESC`).all() as (ThreadRow & { deleted_at: number })[];
    return rows.map(row => ({ ...toThread(row), deletedAt: row.deleted_at }));
  }

  /** Restore the family atomically, retaining IDs, message cursors and prior archive flags. */
  restoreDeletedThreads(rootId: string): string[] {
    return this.db.transaction(() => {
      const rows = this.db.query('SELECT thread_id, archived FROM thread_deletions WHERE root_id = ?').all(rootId) as { thread_id: string; archived: number }[];
      for (const row of rows) this.db.query('UPDATE threads SET archived = ? WHERE id = ?').run(row.archived, row.thread_id);
      this.db.query('DELETE FROM thread_deletions WHERE root_id = ?').run(rootId);
      return rows.map(row => row.thread_id);
    })();
  }

  /** Purge expired families atomically, using their root's deletion time. */
  purgeDeletedThreads(before: number): number {
    if (this.closed) return 0;
    const rows = this.db.query(`SELECT thread_id FROM thread_deletions WHERE root_id IN
      (SELECT root_id FROM thread_deletions WHERE thread_id = root_id AND deleted_at <= ?)`)
      .all(before) as { thread_id: string }[];
    this.deleteThreads(rows.map(row => row.thread_id));
    return rows.length;
  }

  /** Erase conversation history and its dependent records in one transaction, before client notifications. */
  deleteThreads(threadIds: string[]): void {
    if (threadIds.length === 0) return;
    // Foreign keys are off, so the ON DELETE CASCADE clauses never fire: every
    // table keyed by thread is cleared here, events included, so a removed
    // project's prompts and tool output leave the disk.
    this.db.transaction(() => {
      for (const table of ['background_observations', 'turn_requests', 'turns', 'messages', 'processes', 'coordination_letters', 'coordination_wakes', 'events']) {
        const query = this.db.query(`DELETE FROM ${table} WHERE thread_id = ?`);
        for (const id of threadIds) query.run(id);
      }
      for (const id of threadIds) {
        // A conversation's terminal uses a separate process group and trace key.
        this.db.query("DELETE FROM processes WHERE thread_id = 'terminal:' || ?").run(id);
        this.db.query('DELETE FROM delegated_agents WHERE thread_id = ? OR root_id = ?').run(id, id);
        this.db.query('DELETE FROM delegation_messages WHERE root_id = ? OR sender_id = ? OR recipient_id = ?').run(id, id, id);
        this.db.query('DELETE FROM workflow_steps WHERE thread_id = ? OR run_id IN (SELECT id FROM workflow_runs WHERE root_id = ?)').run(id, id);
        this.db.query('DELETE FROM workflow_requests WHERE run_id IN (SELECT id FROM workflow_runs WHERE root_id = ?)').run(id);
        this.db.query('DELETE FROM workflow_runs WHERE root_id = ?').run(id);
        for (const prefix of ['merged-pr-archive:', 'linked-pull-requests:', 'activity:', 'activity-input:', 'move-note:', 'memory-notices:', 'coordination:', 'coordination-autopause:', 'delegation:', 'delegation-turns:', 'delegation-episode:', 'spawn-origin:', 'spawns:']) this.deleteSetting(`${prefix}${id}`);
        this.db.query('DELETE FROM threads WHERE id = ?').run(id);
        this.db.query('DELETE FROM thread_deletions WHERE thread_id = ?').run(id);
      }
    })();
    this.stream.forgetThreads(new Set(threadIds));
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
        `INSERT OR REPLACE INTO turns (id, thread_id, status, queued_at, started_at, finished_at, usage, error, execution, checkpoint, queue_hold)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        turn.checkpoint ? JSON.stringify(turn.checkpoint) : null,
        turn.queueHold ? JSON.stringify(turn.queueHold) : null,
      );
  }

  getTurn(turnId: string): Turn | null {
    const row = this.db.query('SELECT * FROM turns WHERE id = ?').get(turnId) as TurnRow | null;
    return row === null ? null : toTurn(row);
  }

  turnRequest(threadId: string, requestId: string): { fingerprint: string; turn_id: string } | null {
    return this.db.query('SELECT fingerprint, turn_id FROM turn_requests WHERE thread_id = ? AND request_id = ?').get(threadId, requestId) as { fingerprint: string; turn_id: string } | null;
  }

  putTurnRequest(threadId: string, requestId: string, fingerprint: string, turnId: string, messageId: string | null = null): void {
    this.db.query('INSERT INTO turn_requests (thread_id, request_id, fingerprint, turn_id, message_id) VALUES (?, ?, ?, ?, ?)').run(threadId, requestId, fingerprint, turnId, messageId);
  }

  listTurns(threadId?: string): Turn[] {
    const rows =
      threadId === undefined
        ? (this.db.query('SELECT * FROM turns ORDER BY rowid').all() as TurnRow[])
        : (this.db.query('SELECT * FROM turns WHERE thread_id = ? ORDER BY rowid').all(threadId) as TurnRow[]);
    return rows.map(toTurn);
  }

  /** A coordination contact needs one completion timestamp, without loading its turn history. */
  lastCompletedAt(threadId: string): number | null {
    const row = this.db.query("SELECT finished_at AS at FROM turns WHERE thread_id = ? AND status = 'done' AND finished_at IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(threadId) as { at: number } | null;
    return row?.at ?? null;
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

  /** When the turn this thread now runs started, or null when none runs. */
  runningSince(threadId: string): number | null {
    const row = this.db
      .query("SELECT MIN(started_at) AS since FROM turns WHERE thread_id = ? AND status = 'running'")
      .get(threadId) as { since: number | null } | null;
    return row?.since ?? null;
  }

  /**
   * The asynchronous questions asked and never answered or skipped, oldest
   * first. The one place events are read back: a pending card has no
   * projection, and the trail keeps it for as long as events are kept.
   */
  openAsyncQuestions(): QuestionRequest[] {
    const rows = this.db
      .query(
        `SELECT asked.payload FROM events asked
          WHERE asked.type = 'question.asked' AND json_extract(asked.payload, '$.async') = 1
            AND NOT EXISTS (
              SELECT 1 FROM events done
               WHERE done.thread_id = asked.thread_id AND done.id > asked.id AND done.type = 'question.answered'
                 AND json_extract(done.payload, '$.questionId') = json_extract(asked.payload, '$.id'))
          ORDER BY asked.id`,
      )
      .all() as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as QuestionRequest);
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
    this.flushDeltas();
    const open = this.stream.openCopy(messageId);
    if (open !== undefined) return open;
    const row = this.db.query('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | null;
    return row === null ? null : toMessage(row);
  }

  /** Held parts for a selected live message, without reading or writing its stored JSON. */
  streamingMessage(messageId: string): Message | undefined {
    return this.stream.openCopy(messageId);
  }

  listMessages(threadId: string): Message[] {
    this.flushDeltas();
    const rows = this.db
      .query('SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid')
      .all(threadId) as MessageRow[];
    return rows.map((row) => this.currentMessage(row));
  }

  lastUserMessage(threadId: string, turnId: string): Message | null {
    this.flushDeltas();
    const row = this.db.query("SELECT * FROM messages WHERE thread_id = ? AND turn_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1")
      .get(threadId, turnId) as MessageRow | null;
    return row === null ? null : this.currentMessage(row);
  }

  /** The agent's messages of a turn, newest first: a notification reads only as far as the last reply. */
  *walkAgentMessagesBackwards(threadId: string, turnId: string): Iterable<Message> {
    this.flushDeltas();
    const statement = this.db.prepare("SELECT * FROM messages WHERE thread_id = ? AND turn_id = ? AND role = 'assistant' ORDER BY rowid DESC");
    try {
      for (const row of statement.iterate(threadId, turnId)) yield this.currentMessage(row as MessageRow);
    } finally { statement.finalize(); }
  }

  *walkTurnMessages(threadId: string, turnId: string): Iterable<Message> {
    this.flushDeltas();
    const statement = this.db.prepare('SELECT * FROM messages WHERE thread_id = ? AND turn_id = ? ORDER BY rowid');
    try {
      for (const row of statement.iterate(threadId, turnId)) yield this.currentMessage(row as MessageRow);
    } finally { statement.finalize(); }
  }

  /** Stream history for a continuation without loading images from every message at once. */
  *walkMessages(threadId: string): Iterable<Message> {
    // A caller may stop at its current turn. Do not leave a partially consumed
    // cached statement for the next continuation to reuse.
    this.flushDeltas();
    const statement = this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid');
    try {
      for (const row of statement.iterate(threadId)) yield this.currentMessage(row as MessageRow);
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
   * the last `limit` written before `beforeRowid`, within the serialized byte
   * budget except for one complete transportable message. `before` names the oldest one
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
    const statement = this.db.prepare(options.beforeRowid === undefined
      ? 'SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?'
      : 'SELECT * FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?');
    const rows = options.beforeRowid === undefined
      ? statement.iterate(threadId, limit + 1)
      : statement.iterate(threadId, options.beforeRowid, limit + 1);
    const messages: Message[] = [];
    let bytes = 2, older = false;
    try {
      for (const row of rows) {
        if (messages.length >= limit || bytes >= MESSAGE_PAGE_MAX_BYTES) { older = true; break; }
        const message = this.currentMessage(row as MessageRow);
        const size = Buffer.byteLength(JSON.stringify(message));
        const next = bytes + size + (messages.length ? 1 : 0);
        if (messages.length && next > MESSAGE_PAGE_MAX_BYTES) { older = true; break; }
        // One complete attachment-sized message can exceed the page budget.
        // Never pretend a message too large for any RPC frame was sent.
        if (size >= RPC_MAX_FRAME_BYTES) {
          throw refused(`message ${message.id} is ${size} serialized UTF-8 bytes; expected a complete message below ${RPC_MAX_FRAME_BYTES} bytes`,
            { threadId, messageId: message.id, field: 'messages', bytes: size, max: RPC_MAX_FRAME_BYTES, expected: `a complete message below ${RPC_MAX_FRAME_BYTES} serialized UTF-8 bytes` });
        }
        messages.push(message);
        bytes = next;
      }
    } finally { statement.finalize(); }
    messages.reverse();
    return { messages, before: older ? (messages[0]?.id ?? null) : null };
  }

  /** The complete reconnect tail, or null when its count or serialized bytes exceed a page. */
  listMessagesFrom(threadId: string, fromRowid: number, limit: number): Message[] | null {
    this.flushDeltas();
    const statement = this.db.prepare('SELECT * FROM messages WHERE thread_id = ? AND rowid >= ? ORDER BY rowid ASC LIMIT ?');
    const messages: Message[] = [];
    let bytes = 2;
    try {
      for (const row of statement.iterate(threadId, fromRowid, limit + 1)) {
        if (messages.length >= limit) return null;
        const message = this.currentMessage(row as MessageRow);
        bytes += Buffer.byteLength(JSON.stringify(message)) + (messages.length ? 1 : 0);
        if (bytes > MESSAGE_PAGE_MAX_BYTES) return null;
        messages.push(message);
      }
      return messages;
    } finally { statement.finalize(); }
  }

  /**
   * Deletes the message at `fromRowid` and every later one of the thread, and
   * the request keys bound to removed inputs. Kept inputs retain their retry
   * receipts; unidentifiable legacy inputs retain replay protection without
   * acknowledging delivery. The turn rows stay: their
   * usage was spent. Returns what went, oldest first. Run inside `append`.
   */
  truncateMessages(threadId: string, fromRowid: number): { messageIds: string[]; turnIds: string[] } {
    const removed = this.messageIdsFrom(threadId, fromRowid);
    this.db.query('DELETE FROM turn_requests WHERE thread_id = ? AND message_id IN (SELECT id FROM messages WHERE thread_id = ? AND rowid >= ?)').run(threadId, threadId, fromRowid);
    this.db.query('DELETE FROM messages WHERE thread_id = ? AND rowid >= ?').run(threadId, fromRowid);
    for (const turnId of removed.turnIds) {
      // An unknown accepted follow-up might be the removed input. Never acknowledge it again.
      this.db.query("UPDATE turn_requests SET fingerprint = replace(fingerprint, 'steer:accepted:', 'steer:pending:') WHERE thread_id = ? AND turn_id = ? AND message_id IS NULL AND fingerprint LIKE 'steer:accepted:%'").run(threadId, turnId);
      // Pending native submissions have no journaled message and remain unsafe to replay even after a full cut.
      this.db.query("DELETE FROM turn_requests WHERE thread_id = ? AND turn_id = ? AND message_id IS NULL AND fingerprint NOT LIKE 'steer:%' AND NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = ? AND turn_id = ? AND role IN ('user', 'system'))").run(threadId, turnId, threadId, turnId);
      this.db.query("UPDATE turn_requests SET fingerprint = 'start:pending:' || fingerprint WHERE thread_id = ? AND turn_id = ? AND message_id IS NULL AND fingerprint NOT LIKE 'steer:%' AND fingerprint NOT LIKE 'start:pending:%'").run(threadId, turnId);
    }
    return removed;
  }

  /** The ids of the message at `fromRowid`, of every later one, and of their turns, oldest first. */
  messageIdsFrom(threadId: string, fromRowid: number): { messageIds: string[]; turnIds: string[] } {
    this.flushDeltas();
    const rows = this.db
      .query('SELECT id, turn_id FROM messages WHERE thread_id = ? AND rowid >= ? ORDER BY rowid')
      .all(threadId, fromRowid) as { id: string; turn_id: string }[];
    return { messageIds: rows.map((row) => row.id), turnIds: [...new Set(rows.map((row) => row.turn_id))] };
  }

  setMessagePart(messageId: string, partIndex: number, part: MessagePart): void {
    this.stream.setMessagePart(messageId, partIndex, part);
  }

  /** Only selected rows need current parts; reads leave the persistence timer alone. */
  private currentMessage(row: MessageRow): Message {
    return this.stream.openCopy(row.id) ?? toMessage(row);
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
