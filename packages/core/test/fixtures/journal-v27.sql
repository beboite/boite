-- Immutable synthetic schema27 generated with migrate from e1f00a326d45a2c212a351a79adc15d4317fdaba.
-- No current migration code or real user data participated.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  isolation_dir TEXT,
  status TEXT NOT NULL,
  identity TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE agent_entities (
      kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind, id)
    );
CREATE TABLE agent_requests (
      actor TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      result TEXT NOT NULL CHECK(json_valid(result)), created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(actor, request_id)
    );
CREATE TABLE coordination_letters (
      id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      direction TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      request_id TEXT, fingerprint TEXT, data TEXT NOT NULL,
      PRIMARY KEY(id, direction), UNIQUE(thread_id, request_id)
    );
CREATE TABLE coordination_wakes (thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, at INTEGER NOT NULL);
CREATE TABLE delegated_agents (
          thread_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, request_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, profile_id TEXT NOT NULL, task TEXT NOT NULL,
          UNIQUE(root_id, request_id)
        );
CREATE TABLE delegation_messages (
          id TEXT PRIMARY KEY, root_id TEXT NOT NULL, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
          request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
          created_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(sender_id, request_id)
        );
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  thread_id TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE processes (
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
CREATE TABLE project_icons (
      project_id TEXT PRIMARY KEY, kind TEXT NOT NULL, tech TEXT, mime TEXT, data BLOB,
      version TEXT, source TEXT, checked_at INTEGER NOT NULL
    );
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
, archived INTEGER NOT NULL DEFAULT 0, worktree_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  client_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
, role TEXT NOT NULL DEFAULT 'device');
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE thread_deletions (
      thread_id TEXT PRIMARY KEY, root_id TEXT NOT NULL,
      archived INTEGER NOT NULL, deleted_at INTEGER NOT NULL
    );
CREATE TABLE threads (
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
, effort TEXT, pinned INTEGER NOT NULL DEFAULT 0, branch TEXT, title_source TEXT NOT NULL DEFAULT 'prompt', context TEXT, session_generation INTEGER NOT NULL DEFAULT 0, selection_version INTEGER NOT NULL DEFAULT 0, speed TEXT, prompt_cache TEXT, parent_thread_id TEXT, session_resume_at TEXT, title_state TEXT, branch_naming_pending INTEGER NOT NULL DEFAULT 0);
CREATE TABLE turn_requests (thread_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, message_id TEXT, PRIMARY KEY(thread_id, request_id));
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  usage TEXT,
  error TEXT
, execution TEXT, checkpoint TEXT);
CREATE TABLE workflow_requests (
        scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, run_id TEXT NOT NULL,
        PRIMARY KEY(scope, request_id)
      );
CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
      );
CREATE TABLE workflow_steps (thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_key TEXT NOT NULL);
CREATE TABLE workflow_templates (
        id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
      );
CREATE INDEX agent_decision_work ON agent_entities (json_extract(data, '$.workId')) WHERE kind = 'decision';
CREATE UNIQUE INDEX agent_delivery_recipient ON agent_entities (
      json_extract(data, '$.messageId'), json_extract(data, '$.agentId')
    ) WHERE kind = 'delivery';
CREATE INDEX agent_delivery_work ON agent_entities (json_extract(data, '$.workId')) WHERE kind = 'delivery';
CREATE INDEX agent_memory_scope ON agent_entities (json_extract(data, '$.scope.kind'), json_extract(data, '$.scope.id'), updated_at, id) WHERE kind = 'memory';
CREATE INDEX agent_message_scope ON agent_entities (json_extract(data, '$.scope.kind'), json_extract(data, '$.scope.id'), updated_at, id) WHERE kind = 'message';
CREATE INDEX agent_message_source_run ON agent_entities (json_extract(data, '$.sourceRunId')) WHERE kind = 'message';
CREATE INDEX agent_recent ON agent_entities (kind, updated_at, id);
CREATE INDEX agent_requests_created ON agent_requests (created_at);
CREATE INDEX agent_run_status ON agent_entities (json_extract(data, '$.status'), created_at) WHERE kind = 'run';
CREATE INDEX agent_run_thread ON agent_entities (json_extract(data, '$.threadId'), json_extract(data, '$.finishedAt')) WHERE kind = 'run';
CREATE INDEX agent_run_work ON agent_entities (json_extract(data, '$.workId')) WHERE kind = 'run';
CREATE UNIQUE INDEX agent_session_context ON agent_entities (
      json_extract(data, '$.agentId'), json_extract(data, '$.scope.kind'), json_extract(data, '$.scope.id')
    ) WHERE kind = 'session';
CREATE INDEX agent_session_thread ON agent_entities (json_extract(data, '$.threadId')) WHERE kind = 'session';
CREATE INDEX agent_work_agent ON agent_entities (json_extract(data, '$.agentId'), updated_at, id) WHERE kind = 'work';
CREATE INDEX agent_work_episode ON agent_entities (json_extract(data, '$.episodeId')) WHERE kind = 'work';
CREATE INDEX agent_work_scope ON agent_entities (json_extract(data, '$.scope.kind'), json_extract(data, '$.scope.id'), updated_at, id) WHERE kind = 'work';
CREATE INDEX agent_work_status ON agent_entities (json_extract(data, '$.status'), created_at) WHERE kind = 'work';
CREATE INDEX coordination_status ON coordination_letters (status, direction, created_at);
CREATE INDEX coordination_thread ON coordination_letters(thread_id, created_at);
CREATE INDEX coordination_wake_thread ON coordination_wakes(thread_id, at);
CREATE INDEX delegated_root ON delegated_agents(root_id);
CREATE INDEX delegation_history ON delegation_messages(root_id, created_at);
CREATE INDEX delegation_inbox ON delegation_messages(recipient_id, status, created_at);
CREATE INDEX delegation_pending ON delegation_messages(status, created_at);
CREATE INDEX events_agents ON events (id) WHERE type IN ('agents.record', 'agents.limits');
CREATE INDEX events_by_thread ON events (thread_id, id);
CREATE INDEX messages_by_thread ON messages (thread_id);
CREATE INDEX messages_by_turn ON messages (thread_id, turn_id);
CREATE INDEX messages_user_time ON messages (thread_id, created_at DESC) WHERE role = 'user';
CREATE INDEX processes_by_started ON processes (thread_id, started_at DESC);
CREATE INDEX thread_deletions_by_date ON thread_deletions (deleted_at);
CREATE INDEX thread_deletions_root ON thread_deletions(root_id);
CREATE INDEX threads_parent ON threads(parent_thread_id);
CREATE INDEX turns_by_finished ON turns (finished_at);
CREATE INDEX turns_by_status ON turns (status);
CREATE INDEX turns_by_thread ON turns (thread_id);
CREATE INDEX workflow_runs_root ON workflow_runs(root_id, created_at);
CREATE INDEX workflow_runs_status ON workflow_runs(status);
CREATE INDEX workflow_steps_run ON workflow_steps(run_id);
CREATE INDEX workflow_templates_project ON workflow_templates(project_id, name);
INSERT INTO accounts (id,provider_id,label,isolation_dir,status,identity,created_at) VALUES ('acct_fixture','echo','Synthetic account',NULL,'ok',NULL,100);
INSERT INTO coordination_letters (id,thread_id,direction,status,created_at,request_id,fingerprint,data) VALUES ('letter_fixture','thr_deleted','out','received',180,'synthetic-return','cef1881cc5cc36a4d018399e73ad1b12ccb5bbd093e39ce7a0b0c73396a9d754','{"id":"letter_fixture","from":{"coreId":"synthetic-core","threadId":"thr_deleted","title":"Synthetic branch","agent":"echo","status":"idle","mode":"brief","resources":""},"to":{"coreId":"synthetic-core","threadId":"thr_fixture"},"toTitle":"Synthetic conversation","text":"Synthetic saved receipt","replyTo":null,"createdAt":180,"expiresAt":900180,"status":"received","error":null}');
INSERT INTO coordination_letters (id,thread_id,direction,status,created_at,request_id,fingerprint,data) VALUES ('letter_fixture','thr_fixture','in','received',180,NULL,NULL,'{"id":"letter_fixture","from":{"coreId":"synthetic-core","threadId":"thr_deleted","title":"Synthetic branch","agent":"echo","status":"idle","mode":"brief","resources":""},"to":{"coreId":"synthetic-core","threadId":"thr_fixture"},"toTitle":"Synthetic conversation","text":"Synthetic saved receipt","replyTo":null,"createdAt":180,"expiresAt":900180,"status":"received","error":null}');
INSERT INTO messages (id,thread_id,turn_id,role,parts,state,created_at) VALUES ('msg_prompt','thr_fixture','turn_done','user','[{"type":"text","text":"Synthetic prompt"}]','complete',120);
INSERT INTO messages (id,thread_id,turn_id,role,parts,state,created_at) VALUES ('msg_answer','thr_fixture','turn_done','assistant','[{"type":"text","text":"Synthetic answer"}]','complete',120);
INSERT INTO messages (id,thread_id,turn_id,role,parts,state,created_at) VALUES ('msg_queued','thr_fixture','turn_queued','user','[{"type":"text","text":"Synthetic queued"}]','complete',120);
INSERT INTO messages (id,thread_id,turn_id,role,parts,state,created_at) VALUES ('msg_running','thr_fixture','turn_running','assistant','[{"type":"text","text":"Synthetic progress"}]','streaming',120);
INSERT INTO messages (id,thread_id,turn_id,role,parts,state,created_at) VALUES ('msg_steer','thr_fixture','turn_running','user','[{"type":"text","text":"Synthetic accepted steer"}]','complete',120);
INSERT INTO projects (id,name,path,created_at,archived,worktree_default) VALUES ('p_fixture','Synthetic project','/synthetic/project',100,0,0);
INSERT INTO settings (key,value) VALUES ('coordination:thr_fixture','{"mode":"brief","resources":"synthetic","remote":false,"paused":true}');
INSERT INTO thread_deletions (thread_id,root_id,archived,deleted_at) VALUES ('thr_deleted','thr_deleted',0,190);
INSERT INTO threads (id,project_id,agent_session_id,title,provider_id,account_id,model,cwd,permission_mode,status,unread,archived,session_id,created_at,updated_at,effort,pinned,branch,title_source,context,session_generation,selection_version,speed,prompt_cache,parent_thread_id,session_resume_at,title_state,branch_naming_pending) VALUES ('thr_fixture','p_fixture',NULL,'Synthetic conversation','echo','acct_fixture',NULL,'/synthetic/project','default','idle',0,0,'synthetic-session',100,200,NULL,0,NULL,'prompt',NULL,0,0,NULL,NULL,NULL,NULL,NULL,0);
INSERT INTO threads (id,project_id,agent_session_id,title,provider_id,account_id,model,cwd,permission_mode,status,unread,archived,session_id,created_at,updated_at,effort,pinned,branch,title_source,context,session_generation,selection_version,speed,prompt_cache,parent_thread_id,session_resume_at,title_state,branch_naming_pending) VALUES ('thr_deleted','p_fixture',NULL,'Synthetic conversation','echo','acct_fixture',NULL,'/synthetic/project','default','idle',0,0,'synthetic-session',100,200,NULL,0,NULL,'prompt',NULL,0,0,NULL,NULL,NULL,NULL,NULL,0);
INSERT INTO turn_requests (thread_id,request_id,fingerprint,turn_id,message_id) VALUES ('thr_fixture','ordinary','a804970ebc92eb3da3dee1d742bc60e96729c086b5ace33ab67475c2306d2475','turn_done','msg_prompt');
INSERT INTO turn_requests (thread_id,request_id,fingerprint,turn_id,message_id) VALUES ('thr_fixture','accepted','steer:accepted:e6b7af22798951c463b69f397ca7dbe4e57c449f66a38f232aa06224bcc64b19','turn_running','msg_steer');
INSERT INTO turn_requests (thread_id,request_id,fingerprint,turn_id,message_id) VALUES ('thr_fixture','uncertain','steer:pending:synthetic-uncertain','turn_running',NULL);
INSERT INTO turns (id,thread_id,status,queued_at,started_at,finished_at,usage,error,execution,checkpoint) VALUES ('turn_done','thr_fixture','done',100,110,130,NULL,NULL,'{"providerId":"echo","accountId":"acct_fixture","model":"default","effort":null,"speed":null,"permissionMode":"default","sessionId":"synthetic-session","sessionResumeAt":null,"sessionGeneration":0,"selectionVersion":0}',NULL);
INSERT INTO turns (id,thread_id,status,queued_at,started_at,finished_at,usage,error,execution,checkpoint) VALUES ('turn_queued','thr_fixture','queued',100,NULL,NULL,NULL,NULL,'{"providerId":"echo","accountId":"acct_fixture","model":"default","effort":null,"speed":null,"permissionMode":"default","sessionId":"synthetic-session","sessionResumeAt":null,"sessionGeneration":0,"selectionVersion":0}',NULL);
INSERT INTO turns (id,thread_id,status,queued_at,started_at,finished_at,usage,error,execution,checkpoint) VALUES ('turn_running','thr_fixture','running',100,150,NULL,NULL,NULL,'{"providerId":"echo","accountId":"acct_fixture","model":"default","effort":null,"speed":null,"permissionMode":"default","sessionId":"synthetic-session","sessionResumeAt":null,"sessionGeneration":0,"selectionVersion":0}',NULL);
PRAGMA user_version = 27;
