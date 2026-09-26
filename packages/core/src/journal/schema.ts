import type { Database } from 'bun:sqlite';

export const SCHEMA_VERSION = 19;

/** Raised when the journal was written by a newer core than this one. */
export class JournalTooNewError extends Error {
  constructor(readonly file: string, readonly found: number, readonly supported: number) {
    super(`${file} has journal schema ${found}, and this Boite reads up to ${supported}. Install the newer release again, or restore the backup made before it.`);
    this.name = 'JournalTooNewError';
  }
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

export function migrate(db: Database, file: string): void {
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
  // Workflows: a run is one JSON record (its plan and every step's state), a
  // step thread maps back to its run, a template is a plan kept for a project.
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'workflow_runs'").get()) {
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
  version = Math.max(version, SCHEMA_VERSION);
  db.exec(`PRAGMA user_version = ${version}`);
}

/** Indexes made on every open, after the migration and outside its transaction. */
export function ensureIndexes(db: Database): void {
  db.exec('CREATE INDEX IF NOT EXISTS turns_by_status ON turns (status)');
  db.exec('CREATE INDEX IF NOT EXISTS messages_by_turn ON messages (thread_id, turn_id)');
  db.exec('CREATE INDEX IF NOT EXISTS turns_by_finished ON turns (finished_at)');
}
