import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { MessagePart } from '@boite/contracts';
import { nativeAgentPartSql } from './native-agent-parts.ts';
import { createPartBlobs } from './part-blobs.ts';
import { parseJson } from './rows.ts';

export const SCHEMA_VERSION = 32;

/** Raised when the journal was written by a newer core than this one. */
export class JournalTooNewError extends Error {
  constructor(readonly file: string, readonly found: number, readonly supported: number) {
    super(`${file} has journal schema ${found}, and this Boite reads up to ${supported}. Install the newer release again, or restore the backup made before it.`);
    this.name = 'JournalTooNewError';
  }
}

// Missing tables use current ownership columns; old tables keep the repair path below.
const INITIAL_SCHEMA = `
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
  project_id TEXT,
  agent_session_id TEXT,
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

/** Brings the journal to the current schema; returns the version found on disk and the one now stamped. */
export function migrate(db: Database, file: string): { from: number; to: number } {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
  let version = row?.user_version ?? 0;
  // An older core must not write a schema it does not know: it would stamp its
  // own version on it and skip what the newer one relies on.
  if (version > SCHEMA_VERSION) throw new JournalTooNewError(file, version, SCHEMA_VERSION);
  const initialSchemas = [INITIAL_SCHEMA, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7, SCHEMA_V8];
  for (const [index, sql] of initialSchemas.entries()) {
    if (version >= index + 1) continue;
    db.exec(sql);
    version = index + 1;
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
  // Each repair inspects a distinct object/column. Keep one snapshot per table,
  // before its ALTER statements, instead of rebuilding table_info for every field.
  const objects = new Set((db.query('SELECT name FROM sqlite_master').all() as { name: string }[]).map(row => row.name));
  const columns = new Map<string, Set<string>>();
  function hasColumn(table: string, name: string): boolean {
    let names = columns.get(table);
    if (names === undefined) {
      names = new Set((db.query('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map(row => row.name));
      columns.set(table, names);
    }
    return names.has(name);
  }
  // The prompt cache the last turn left, as JSON (`PromptCache`).
  if (!hasColumn('threads', 'prompt_cache')) { db.exec('ALTER TABLE threads ADD COLUMN prompt_cache TEXT'); version = 13; }
  if (!objects.has('delegated_agents')) {
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
  if (!objects.has('agent_entities')) {
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
  if (!hasColumn('threads', 'agent_session_id')) {
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
  if (!objects.has('agent_recent')) {
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
  if (!objects.has('coordination_status')) {
    db.exec('CREATE INDEX IF NOT EXISTS coordination_status ON coordination_letters (status, direction, created_at)');
    version = 17;
  }
  // Request receipts are kept a month, then dropped: the rows already there count from now.
  if (!hasColumn('agent_requests', 'created_at')) {
    db.exec(`ALTER TABLE agent_requests ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      UPDATE agent_requests SET created_at = ${Date.now()};
      CREATE INDEX IF NOT EXISTS agent_requests_created ON agent_requests (created_at);`);
    version = 18;
  }
  // Workflows: a run is one JSON record (its plan and every step's state), a
  // step thread maps back to its run, a template is a plan kept for a project.
  if (!objects.has('workflow_runs')) {
    db.exec(`CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
      );
      CREATE INDEX workflow_runs_root ON workflow_runs(root_id, created_at);
      CREATE INDEX workflow_runs_status ON workflow_runs(status);
      CREATE TABLE workflow_steps (thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_key TEXT NOT NULL);
      CREATE INDEX workflow_steps_run ON workflow_steps(run_id);
      CREATE TABLE workflow_requests (
        scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, run_id TEXT NOT NULL,
        PRIMARY KEY(scope, request_id)
      );
      CREATE TABLE workflow_templates (
        id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
      );
      CREATE INDEX workflow_templates_project ON workflow_templates(project_id, name);`);
    version = 19;
  }
  // Rewind and fork: the transcript entry a thread's next turn resumes at, and
  // the entry each turn ended on (`Turn.checkpoint`, JSON).
  if (!hasColumn('turns', 'checkpoint')) {
    db.exec(`ALTER TABLE threads ADD COLUMN session_resume_at TEXT;
      ALTER TABLE turns ADD COLUMN checkpoint TEXT;`);
    version = 20;
  }
  // A project put away: hidden from the sidebar, its threads untouched.
  if (!hasColumn('projects', 'archived')) {
    db.exec('ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    version = 21;
  }
  // A project's icon as detected from its folder: `image` with its bytes,
  // `tech` with a stack id, or `none`. Derived from the disk and rebuilt by
  // detecting again, so it is written without an event.
  if (!objects.has('project_icons')) {
    db.exec(`CREATE TABLE project_icons (
      project_id TEXT PRIMARY KEY, kind TEXT NOT NULL, tech TEXT, mime TEXT, data BLOB,
      version TEXT, source TEXT, checked_at INTEGER NOT NULL
    )`);
    version = 22;
  }
  if (version < 23) {
    db.exec(`CREATE TABLE IF NOT EXISTS thread_deletions (
      thread_id TEXT PRIMARY KEY, root_id TEXT NOT NULL,
      archived INTEGER NOT NULL, deleted_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS thread_deletions_root ON thread_deletions(root_id);`);
    version = 23;
  }
  if (!hasColumn('threads', 'title_state')) {
    db.exec('ALTER TABLE threads ADD COLUMN title_state TEXT;');
    version = 24;
  }
  if (!hasColumn('projects', 'worktree_default')) {
    db.exec('ALTER TABLE projects ADD COLUMN worktree_default INTEGER NOT NULL DEFAULT 0');
    version = 25;
  }
  if (!hasColumn('threads', 'branch_naming_pending')) {
    db.exec('ALTER TABLE threads ADD COLUMN branch_naming_pending INTEGER NOT NULL DEFAULT 0');
    version = 26;
  }
  ensureIndexes(db);
  if (!hasColumn('turn_requests', 'message_id')) {
    db.exec('ALTER TABLE turn_requests ADD COLUMN message_id TEXT');
    bindLegacyTurnRequests(db);
    version = 27;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS background_observations (
    thread_id TEXT NOT NULL, provider_id TEXT NOT NULL, session_generation INTEGER NOT NULL,
    parent_turn_id TEXT NOT NULL, task_id TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(thread_id, provider_id, session_generation, parent_turn_id, task_id)
  ); CREATE INDEX IF NOT EXISTS background_observations_thread ON background_observations(thread_id);
    CREATE INDEX IF NOT EXISTS background_observations_live ON background_observations(thread_id, provider_id, session_generation, json_extract(payload, '$.state'));
    CREATE INDEX IF NOT EXISTS background_observations_recent ON background_observations(thread_id, json_extract(payload, '$.observedAt') DESC);`);
  if (!hasColumn('threads', 'fork_origin')) db.exec('ALTER TABLE threads ADD COLUMN fork_origin TEXT');
  if (!hasColumn('turns', 'queue_hold')) db.exec('ALTER TABLE turns ADD COLUMN queue_hold TEXT');
  if (!hasColumn('threads', 'done_at')) db.exec('ALTER TABLE threads ADD COLUMN done_at INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS threads_done_expiry ON threads(done_at)');
  // An incognito conversation of the drafts, erased when it is left.
  if (!hasColumn('threads', 'incognito')) {
    db.exec('ALTER TABLE threads ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0');
    version = 30;
  }
  // The messages that hold a native agent call, so the team view stops parsing
  // every part of a thread. Filled once from the stored parts, then on each write.
  // Large part values written from now on go to part_blobs; older rows keep theirs inline.
  if (version < 31) {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS native_agent_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS native_agent_messages_thread ON native_agent_messages (thread_id);
        INSERT OR IGNORE INTO native_agent_messages (message_id, thread_id)
          SELECT DISTINCT m.id, m.thread_id FROM messages m, json_each(m.parts) p WHERE ${nativeAgentPartSql('p')};`);
      createPartBlobs(db);
    })();
    version = 31;
  }
  // The blur each deferred picture is drawn with before its bytes arrive, by
  // message and part; part -1 says every picture of that message was looked
  // at. `media_displays` holds the WebP copy the timeline draws, empty when
  // the original is lighter. Derived from the messages and made again when
  // missing: no event.
  if (version < 32) {
    db.exec(`CREATE TABLE IF NOT EXISTS media_previews (
        message_id TEXT NOT NULL, part_index INTEGER NOT NULL, thread_id TEXT NOT NULL, preview TEXT,
        PRIMARY KEY (message_id, part_index)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS media_previews_thread ON media_previews (thread_id);
      CREATE TABLE IF NOT EXISTS media_displays (
        message_id TEXT NOT NULL, part_index INTEGER NOT NULL, thread_id TEXT NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY (message_id, part_index)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS media_displays_thread ON media_displays (thread_id);`);
    version = 32;
  }
  version = Math.max(version, SCHEMA_VERSION);
  if (row?.user_version !== version) db.exec(`PRAGMA user_version = ${version}`);
  return { from: row?.user_version ?? 0, to: version };
}

/** Old receipts lacked input identity. A hash match must name exactly one stored input. */
function bindLegacyTurnRequests(db: Database): void {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const receipts = db.query('SELECT thread_id, request_id, turn_id, fingerprint FROM turn_requests').all() as {
    thread_id: string; request_id: string; turn_id: string; fingerprint: string;
  }[];
  const messages = db.query("SELECT id, parts FROM messages WHERE thread_id = ? AND turn_id = ? AND role IN ('user', 'system')");
  const bind = db.query('UPDATE turn_requests SET message_id = ? WHERE thread_id = ? AND request_id = ?');
  for (const receipt of receipts) {
    if (receipt.fingerprint.startsWith('steer:pending:') || receipt.fingerprint.startsWith('start:pending:')) continue;
    const matches: string[] = [];
    for (const row of messages.all(receipt.thread_id, receipt.turn_id) as { id: string; parts: string }[]) {
      const parts = parseJson<MessagePart[]>(row.parts, `messages.parts row ${row.id}`);
      const text = parts[0];
      if (text?.type !== 'text' || parts.slice(1).some(part => part.type !== 'image' && part.type !== 'file')) continue;
      const references = text.previewReferences ?? [];
      const prompt = references.length ? text.displayText : text.text;
      if (typeof prompt !== 'string') continue;
      const attachments = parts.slice(1).map(part => {
        if (part.type === 'file') return { kind: 'file', mimeType: part.mimeType, data: part.data, name: part.name };
        if (part.type === 'image') return { kind: 'image', mimeType: part.mimeType, data: part.data, name: part.alt };
        throw new Error('unexpected input attachment');
      });
      const fingerprint = receipt.fingerprint.startsWith('steer:accepted:')
        ? `steer:accepted:${hash([receipt.turn_id, prompt, attachments, references])}`
        : hash([prompt, attachments.map(a => [a.kind, a.mimeType, a.data, a.name]), ...(references.length ? [references] : [])]);
      if (fingerprint === receipt.fingerprint) matches.push(row.id);
    }
    if (matches.length === 1) bind.run(matches[0]!, receipt.thread_id, receipt.request_id);
  }
}

/** Maintain lookup indexes in the same transaction as the schema they serve. */
export function ensureIndexes(db: Database): void {
  db.exec('CREATE INDEX IF NOT EXISTS thread_deletions_by_date ON thread_deletions (deleted_at)');
  db.exec('CREATE INDEX IF NOT EXISTS processes_by_started ON processes (thread_id, started_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS turns_by_status ON turns (status)');
  db.exec('CREATE INDEX IF NOT EXISTS messages_by_turn ON messages (thread_id, turn_id)');
  db.exec('CREATE INDEX IF NOT EXISTS turns_by_finished ON turns (finished_at)');
  // `requestSince` walks a busy thread's turns back from the newest on every summary.
  db.exec('CREATE INDEX IF NOT EXISTS turns_by_thread_queue ON turns (thread_id, queued_at, id) WHERE started_at IS NOT NULL');
  // The few event types read back. Without them, restoring asynchronous questions
  // at startup read the whole events table, and every thread open walked all of
  // its thread's events for memory notices.
  db.exec("CREATE INDEX IF NOT EXISTS events_questions_asked ON events (id) WHERE type = 'question.asked'");
  db.exec("CREATE INDEX IF NOT EXISTS events_questions_answered ON events (thread_id, id) WHERE type = 'question.answered'");
  db.exec("CREATE INDEX IF NOT EXISTS events_thread_memory ON events (thread_id, id) WHERE type = 'thread.memory'");
}
