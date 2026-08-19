use std::path::Path;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::model::{Project, Thread, Todo};
use crate::{approval, journal, migrations, pairing, search, timeline};

pub struct Store {
    conn: Mutex<Connection>,
}

/// A thread's display name and where it lives. Feeds `awareness::Facts`.
pub struct ThreadContext {
    pub label: String,
    pub project_id: Option<String>,
    /// `None` for a thread whose project row is gone, which is a state the
    /// journal can outlive a project into.
    pub project: Option<String>,
}

/// Names itself and stops there.
///
/// `Ready` derives `Debug` and one of its arms carries a store, so this has to
/// exist. Printing anything about the connection would put a database path into
/// whatever log the value was formatted into, which is the kind of thing
/// `sanitize_log_text` exists to undo after the fact.
impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Store")
    }
}

impl Store {
    /// Opens the database and brings the schema up to date.
    ///
    /// For the process that owns the file. On the desktop the schema belongs to
    /// tauri-plugin-sql, which keeps its own ledger — use [`Store::attach`]
    /// there, or two migration mechanisms race over the same tables.
    pub fn open(path: &Path) -> Result<Store, String> {
        let store = Store::attach(path)?;
        store.migrate()?;
        Ok(store)
    }

    /// Opens the database of a process that migrates it some other way.
    ///
    /// The desktop is one: its schema is applied by tauri-plugin-sql from the
    /// frontend, against an sqlx checksum ledger, and this connection is a
    /// second reader of the same file. Same pragmas, no migration.
    pub fn attach(path: &Path) -> Result<Store, String> {
        let conn = Connection::open(path).map_err(|e| format!("open db failed: {e}"))?;
        // WAL + NORMAL: thread status/title updates fire on agent activity, and
        // the default rollback journal with synchronous=FULL costs an fsync per
        // UPDATE. On the SD card of a small ARM box that dominates both latency
        // and flash wear. WAL still survives a process crash; only a host power
        // loss can lose the last commits, which for cosmetic thread metadata is
        // the right trade. busy_timeout keeps a concurrent reader from erroring
        // out instantly on a write lock, which on the desktop is the plugin and
        // this connection taking turns.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|e| format!("pragma setup failed: {e}"))?;
        Ok(Store {
            conn: Mutex::new(conn),
        })
    }

    /// Applies whatever `PRAGMA user_version` says is still pending.
    ///
    /// The list itself lives in `crate::migrations`, shared with the
    /// desktop, which keeps two hand-copied schemas from drifting. What stays
    /// here is the mechanism: this side counts positions, the desktop counts
    /// explicit versions, and the shared list is ordered so both readings land
    /// on the entry they already applied.
    fn migrate(&self) -> Result<(), String> {
        let pending = migrations::server();
        let mut conn = self.conn.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| format!("read user_version failed: {e}"))?;
        let mut applied = version as usize;
        if applied >= pending.len() {
            return Ok(());
        }
        // One transaction over every pending migration AND the user_version
        // bump. Several entries are multi-statement ALTERs: committing half of
        // one and losing the version bump means the next boot replays it and
        // dies on "duplicate column name" forever, which under
        // `restart: unless-stopped` is an unbootable server, not a bad startup.
        let tx = conn
            .transaction()
            .map_err(|e| format!("migration transaction failed: {e}"))?;
        while applied < pending.len() {
            let m = pending[applied];
            tx.execute_batch(m.sql)
                .map_err(|e| format!("migration {} ({}) failed: {e}", applied + 1, m.description))?;
            applied += 1;
        }
        tx.execute_batch(&format!("PRAGMA user_version = {applied};"))
            .map_err(|e| format!("set user_version failed: {e}"))?;
        tx.commit()
            .map_err(|e| format!("migration commit failed: {e}"))?;
        Ok(())
    }

    /// Takes a table away, so a caller's "what if this cannot be read" path can
    /// be tested rather than assumed.
    #[cfg(test)]
    pub fn drop_table_for_test(&self, table: &str) {
        let conn = self.conn.lock();
        conn.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))
            .unwrap();
    }

    pub fn load_todos(&self) -> Result<Vec<Todo>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, text, description, state, note, commit_sha, claimed_by,
                        position, created_at, updated_at
                 FROM todos ORDER BY position ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Todo {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    title: r.get(2)?,
                    description: r.get(3)?,
                    state: normalize_todo_state(r.get(4)?),
                    note: r.get(5)?,
                    commit_sha: r.get(6)?,
                    claimed_by: r.get(7)?,
                    position: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn save_todo(&self, t: &Todo) -> Result<(), String> {
        let conn = self.conn.lock();
        search::index(
            &conn,
            search::Kind::Todo,
            &t.project_id,
            &t.id,
            &[
                t.title.as_str(),
                t.description.as_deref().unwrap_or_default(),
                t.note.as_deref().unwrap_or_default(),
            ]
            .join(" "),
        );
        conn.execute(
            "INSERT OR REPLACE INTO todos
             (id, project_id, text, description, state, note, commit_sha, claimed_by,
              position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                t.id,
                t.project_id,
                t.title,
                t.description,
                t.state,
                t.note,
                t.commit_sha,
                t.claimed_by,
                t.position,
                t.created_at,
                t.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn todos_for_project(&self, project_id: &str) -> Result<Vec<Todo>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, text, description, state, note, commit_sha, claimed_by,
                        position, created_at, updated_at
                 FROM todos WHERE project_id = ?1 ORDER BY position ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(Todo {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    title: r.get(2)?,
                    description: r.get(3)?,
                    state: normalize_todo_state(r.get(4)?),
                    note: r.get(5)?,
                    commit_sha: r.get(6)?,
                    claimed_by: r.get(7)?,
                    position: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Which agent a thread is running, as the icon key the rest of the app
    /// already draws by. Only ever used to put a badge on a claim; it grants
    /// nothing.
    pub fn agent_of_thread(&self, thread_id: &str) -> Option<String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT icon_key FROM threads WHERE id = ?1",
            [thread_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .filter(|k| !k.is_empty() && k != "terminal")
    }

    /// Binds a thread to the identity it was spawned with. Once.
    ///
    /// The owner lock. `ON CONFLICT DO NOTHING` plus a read back rather than a
    /// check above the SQL: the check would leave a window between the read and
    /// the write that two spawns of the same thread could both pass through.
    ///
    /// Re-binding the *same* key succeeds, because that is not a takeover: it is
    /// a respawn of a terminal whose key file is still on disk, and refusing it
    /// would mean an agent loses its own workspace when its PTY restarts.
    ///
    /// No foreign key to `threads`, and deliberately: the desktop persists a
    /// thread's row behind the caller while the terminal is already mounting, so
    /// the key can be minted before the row lands. A key with no thread grants
    /// nothing, since resolving a project still needs the row.
    pub fn bind_thread_identity(&self, thread_id: &str, public_key: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO thread_keys (thread_id, public_key) VALUES (?1, ?2)
             ON CONFLICT(thread_id) DO NOTHING",
            rusqlite::params![thread_id, public_key],
        )
        .map_err(|e| e.to_string())?;
        let owner: String = conn
            .query_row(
                "SELECT public_key FROM thread_keys WHERE thread_id = ?1",
                [thread_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if owner == public_key {
            return Ok(());
        }
        Err(format!(
            "thread {thread_id} already has an owner, and an owner is never replaced"
        ))
    }

    /// The public half of a thread's identity, for verifying what it signed.
    ///
    /// `None` covers both "no such thread" and "a thread from before identities
    /// existed". Neither can prove anything, and the endpoint treats them the
    /// same way, so there is nothing to tell apart here.
    pub fn public_key_of_thread(&self, thread_id: &str) -> Option<String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT public_key FROM thread_keys WHERE thread_id = ?1",
            [thread_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .filter(|k| !k.is_empty())
    }

    /// Drops a thread's identity. For a thread being deleted.
    pub fn forget_thread_identity(&self, thread_id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM thread_keys WHERE thread_id = ?1", [thread_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// What scopes an agent: it presents the thread Boite spawned it for, never
    /// a project of its choosing.
    pub fn project_of_thread(&self, thread_id: &str) -> Result<String, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT project_id FROM threads WHERE id = ?1",
            [thread_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| "unknown thread".to_string())
    }

    /// Puts a request in front of the user, and hands back the record.
    ///
    /// The dispatch is stored whole, so allowing one replays exactly what was
    /// asked for. See `crate::approval`.
    pub fn open_approval(
        &self,
        pending: &approval::Pending,
        request: &serde_json::Value,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO approvals
             (id, project_id, thread_id, action, detail, request, verdict, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)",
            rusqlite::params![
                pending.id,
                pending.project_id,
                pending.thread_id,
                pending.action,
                pending.detail,
                request.to_string(),
                pending.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Everything still waiting, oldest first, across every project.
    ///
    /// Not scoped: the card belongs to the window, and a user looking at one
    /// project still has to see that an agent in another is asking. Scoping it
    /// would mean a request that is only visible if you happen to be standing in
    /// the right place.
    pub fn open_approvals(&self) -> Result<Vec<approval::Pending>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, thread_id, action, detail, created_at
                 FROM approvals WHERE verdict = 'pending' ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(approval::Pending {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    thread_id: r.get(2)?,
                    action: r.get(3)?,
                    detail: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Answers one, once.
    ///
    /// `WHERE verdict = 'pending'` rather than a check above it: two devices can
    /// be looking at the same card, and the one that loses has to come back with
    /// `None` rather than dispatching the same move a second time.
    ///
    /// `Some(request)` is what was asked for, ready to hand to whoever carries
    /// it out. `None` means somebody else already answered.
    pub fn decide_approval(
        &self,
        id: &str,
        verdict: approval::Verdict,
        now: i64,
    ) -> Result<Option<(approval::Pending, serde_json::Value)>, String> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE approvals SET verdict = ?1, decided_at = ?2
                 WHERE id = ?3 AND verdict = 'pending'",
                rusqlite::params![verdict.as_str(), now, id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Ok(None);
        }
        conn.query_row(
            "SELECT id, project_id, thread_id, action, detail, request, created_at
             FROM approvals WHERE id = ?1",
            [id],
            |r| {
                let raw: String = r.get(5)?;
                Ok((
                    approval::Pending {
                        id: r.get(0)?,
                        project_id: r.get(1)?,
                        thread_id: r.get(2)?,
                        action: r.get(3)?,
                        detail: r.get(4)?,
                        created_at: r.get(6)?,
                    },
                    serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null),
                ))
            },
        )
        .map(Some)
        .map_err(|e| e.to_string())
    }

    /// Records what happened in the project's log.
    ///
    /// Not in the same transaction as the write it describes, and that is a
    /// known gap rather than an oversight: threading a transaction through
    /// every handler would buy an atomicity that belongs one layer up, at the
    /// single dispatch every mutation will go through. Until then the record
    /// follows the write, so a crash between the two loses an entry rather than
    /// inventing one, which is the right way round.
    pub fn record(&self, entry: journal::Entry) -> Result<journal::Recorded, String> {
        let mut conn = self.conn.lock();
        let recorded = journal::append(&mut conn, entry)?;
        // What happened is half of what anybody searches for. An entry never
        // changes, so this is an insert and never a correction.
        search::index(
            &conn,
            search::Kind::Event,
            &recorded.project_id,
            &format!("{}#{}", recorded.project_id, recorded.seq),
            &searchable(&recorded),
        );
        Ok(recorded)
    }

    /// Everything a caller might type when looking for one entry, and nothing
    /// that is only meaningful to the chain: a hash is not something anyone
    /// searches by, and indexing it would put two hex strings in every row.
    pub fn search(&self, needle: &str, limit: usize) -> Vec<search::Hit> {
        let conn = self.conn.lock();
        search::rows(&conn, needle, limit)
    }

    /// What happened here, newest first. See `crate::timeline`.
    pub fn timeline(&self, project_id: Option<&str>, limit: usize) -> Vec<timeline::Moment> {
        let conn = self.conn.lock();
        timeline::from_store(&conn, project_id, limit)
    }

    pub fn add_todo(
        &self,
        project_id: &str,
        title: &str,
        description: Option<&str>,
        now: i64,
    ) -> Result<String, String> {
        let conn = self.conn.lock();
        let position: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM todos WHERE project_id = ?1",
                [project_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        // Thirty-two hex characters, which is the shape every id in this table
        // already has. It used to come from `rand`, a dependency this crate did
        // not have and does not need: a v4 uuid is the same width, the same
        // alphabet, and already here for the thread ids.
        let id = uuid::Uuid::new_v4().simple().to_string();
        conn.execute(
            "INSERT INTO todos
             (id, project_id, text, description, state, note, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'open', NULL, ?5, ?6, ?6)",
            rusqlite::params![id, project_id, title, description, position, now],
        )
        .map_err(|e| e.to_string())?;
        // Indexed where it is written, so there is no rebuild to run and no
        // reconciliation to get wrong.
        search::index(
            &conn,
            search::Kind::Todo,
            project_id,
            &id,
            &[title, description.unwrap_or_default()].join(" "),
        );
        Ok(id)
    }

    /// Moves an item to `claimed` with the agent's summary, and only from
    /// `open`, and only within the caller's own project: an agent must not be
    /// able to walk back a box a human ticked, re-claim what it already
    /// claimed, or reach another project's list. The condition is in the SQL
    /// rather than above it so it holds for whichever caller reaches the row.
    pub fn claim_todo(
        &self,
        id: &str,
        project_id: &str,
        note: Option<&str>,
        commit: Option<&str>,
        agent: Option<&str>,
        now: i64,
    ) -> Result<bool, String> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE todos SET state = 'claimed', note = ?1, commit_sha = ?2,
                 claimed_by = ?3, updated_at = ?4
                 WHERE id = ?5 AND project_id = ?6 AND state = 'open'",
                rusqlite::params![note, commit, agent, now, id, project_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    pub fn delete_todo(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM todos WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| e.to_string())?;
        search::forget(&conn, search::Kind::Todo, id);
        Ok(())
    }

    /// The repository and worktree a thread runs in, when it has a worktree of
    /// its own. `None` means it runs in the project folder itself.
    pub fn worktree_of_thread(&self, thread_id: &str) -> Option<(String, String)> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT t.worktree_path, p.cwd, p.git_root
             FROM threads t JOIN projects p ON p.id = t.project_id
             WHERE t.id = ?1",
            [thread_id],
            |r| {
                let worktree: Option<String> = r.get(0)?;
                let cwd: String = r.get(1)?;
                let git_root: Option<String> = r.get(2)?;
                Ok(worktree.map(|w| (git_root.unwrap_or(cwd), w)))
            },
        )
        .ok()
        .flatten()
    }

    pub fn load_projects(&self) -> Result<Vec<Project>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, cwd, icon, archived, git_root, worktrees FROM projects ORDER BY created_at ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    cwd: r.get(2)?,
                    icon: r.get(3)?,
                    archived: r.get::<_, i64>(4)? == 1,
                    git_root: r.get(5)?,
                    worktrees: r.get::<_, Option<i64>>(6)?.map(|v| v == 1),
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn save_project(&self, p: &Project, created_at: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO projects (id, name, cwd, default_cmd, default_args, icon, archived, git_root, worktrees, created_at)
             VALUES (?1, ?2, ?3, '', '[]', ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                p.id,
                p.name,
                p.cwd,
                p.icon,
                p.archived as i64,
                p.git_root,
                p.worktrees.map(|v| v as i64),
                created_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_project_archived(&self, id: &str, archived: bool) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE projects SET archived = ?1 WHERE id = ?2",
            rusqlite::params![archived as i64, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_project(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM projects WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_threads(&self) -> Result<Vec<Thread>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, status, keep_awake, created_at, icon_color, worktree_path, settled_at, parent_thread_id, delegation_mode, delegation_status, role, orchestrator_scope, accept_dispatch
                 FROM threads ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let args_raw: String = r.get(5)?;
                let args = serde_json::from_str::<Vec<String>>(&args_raw).unwrap_or_default();
                Ok(Thread {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    pty_id: None,
                    label: r.get(2)?,
                    title: r.get(3)?,
                    cmd: r.get(4)?,
                    args,
                    icon_key: r.get(8)?,
                    icon_color: r.get(12)?,
                    session_id: r.get(7)?,
                    status: normalize_status(r.get::<_, Option<String>>(9)?),
                    exit_code: r.get(6)?,
                    created_at: r.get(11)?,
                    auto_slept: false,
                    keep_awake: r.get::<_, i64>(10)? == 1,
                    worktree_path: r.get(13)?,
                    settled_at: r.get(14)?,
                    parent_thread_id: r.get(15)?,
                    delegation_mode: r.get(16)?,
                    delegation_status: r.get(17)?,
                    role: r.get(18)?,
                    orchestrator_scope: r.get(19)?,
                    accept_dispatch: r.get::<_, i64>(20)? == 1,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn load_thread(&self, id: &str) -> Result<Option<Thread>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, status, keep_awake, created_at, icon_color, worktree_path, settled_at, parent_thread_id, delegation_mode, delegation_status, role, orchestrator_scope, accept_dispatch
             FROM threads WHERE id = ?1",
            [id],
            |r| {
                let args_raw: String = r.get(5)?;
                let args = serde_json::from_str::<Vec<String>>(&args_raw).unwrap_or_default();
                Ok(Thread {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    pty_id: None,
                    label: r.get(2)?,
                    title: r.get(3)?,
                    cmd: r.get(4)?,
                    args,
                    icon_key: r.get(8)?,
                    icon_color: r.get(12)?,
                    session_id: r.get(7)?,
                    status: normalize_status(r.get::<_, Option<String>>(9)?),
                    exit_code: r.get(6)?,
                    created_at: r.get(11)?,
                    auto_slept: false,
                    keep_awake: r.get::<_, i64>(10)? == 1,
                    worktree_path: r.get(13)?,
                    settled_at: r.get(14)?,
                    parent_thread_id: r.get(15)?,
                    delegation_mode: r.get(16)?,
                    delegation_status: r.get(17)?,
                    role: r.get(18)?,
                    orchestrator_scope: r.get(19)?,
                    accept_dispatch: r.get::<_, i64>(20)? == 1,
                })
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
    }

    /// Persisted (status, exit_code) for a thread, or None if the row is absent.
    /// Lets thread.create preserve server-authoritative runtime state on re-save.
    ///
    /// Raw, where the two `load_` readers answer with [`display_status`]. A
    /// re-save writes what this returns back onto the row, so translating here
    /// would turn the mark of a live run into `stopped` the next time the window
    /// captured a session id — and the row would then have said "asleep" about a
    /// thread that was working, one restart later.
    pub fn thread_status(&self, id: &str) -> Option<(String, Option<i32>)> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT status, exit_code FROM threads WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?.unwrap_or_else(|| "idle".to_string()),
                    r.get::<_, Option<i32>>(1)?,
                ))
            },
        )
        .ok()
    }

    /// When this thread was put away, or None while it is live or absent.
    ///
    /// Read back on every re-save for the same reason as [`Store::thread_status`]:
    /// `save_thread` is an `INSERT OR REPLACE`, so a column the caller does not
    /// carry is a column set to null. A row nobody has put away and a row that is
    /// not there both answer None, which is what an ordinary live thread is.
    pub fn thread_settled_at(&self, id: &str) -> Option<i64> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT settled_at FROM threads WHERE id = ?1",
            [id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    }

    /// The orchestration columns of a row, or `None` if the row is absent.
    ///
    /// Read back on every re-save for the same reason as
    /// [`Store::thread_status`]: `save_thread` is an `INSERT OR REPLACE`, and
    /// `role` is what selects the orchestrator tool tier, so a caller's copy of
    /// it is never trusted — the row's own answer is.
    pub fn thread_orchestration(&self, id: &str) -> Option<(Option<String>, Option<String>, bool)> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT role, orchestrator_scope, accept_dispatch FROM threads WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)? == 1,
                ))
            },
        )
        .ok()
    }

    /// Stamps a thread as an orchestrator. The one write path for `role`.
    ///
    /// Deliberately not a `ThreadCol`: `update_thread_field` is what
    /// `thread.update` reaches, and these columns must not be reachable from
    /// there. Only a `Grant::Local` command calls this.
    pub fn stamp_orchestrator_role(
        &self,
        id: &str,
        scope: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE threads SET role = 'orchestrator', orchestrator_scope = ?2 WHERE id = ?1",
            rusqlite::params![id, scope],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The live orchestrator thread for a scope, if one is running.
    ///
    /// Live means not settled: a settled orchestrator left its stamp behind,
    /// and the stamp on a closed row must not block the next start. Ties are
    /// broken by creation time, newest first, though two live holders of one
    /// scope is exactly what `orchestrator.start` refuses to create.
    pub fn find_orchestrator(&self, scope: Option<&str>) -> Option<String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id FROM threads
             WHERE role = 'orchestrator' AND settled_at IS NULL
               AND (?1 IS NULL AND orchestrator_scope IS NULL OR orchestrator_scope = ?1)
             ORDER BY created_at DESC LIMIT 1",
            [scope],
            |r| r.get::<_, String>(0),
        )
        .ok()
    }

    /// How many live threads this one has spawned. Live means not settled: a
    /// worker whose job ended and was filed no longer counts against a cap.
    pub fn live_children(&self, parent_id: &str) -> i64 {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM threads WHERE parent_thread_id = ?1 AND settled_at IS NULL",
            [parent_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Whether this thread still accepts dispatched lines. User-only write.
    pub fn set_accept_dispatch(&self, id: &str, accept: bool) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE threads SET accept_dispatch = ?2 WHERE id = ?1",
            rusqlite::params![id, accept as i64],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Appends one moment to the workspace pulse and prunes the ring.
    ///
    /// The prune keeps the newest [`crate::pulse::RING_CAP`] rows. Done here,
    /// on every write, so no sweep has to exist: a delete of zero rows is one
    /// indexed statement.
    pub fn append_moment(
        &self,
        kind: &str,
        project_id: Option<&str>,
        object_id: Option<&str>,
        detail: &str,
        source: &str,
        at: i64,
    ) -> Result<i64, String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO moments (kind, project_id, object_id, detail, source, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![kind, project_id, object_id, detail, source, at],
        )
        .map_err(|e| e.to_string())?;
        let seq = conn.last_insert_rowid();
        conn.execute(
            "DELETE FROM moments WHERE seq <= ?1",
            [seq - crate::pulse::RING_CAP],
        )
        .map_err(|e| e.to_string())?;
        Ok(seq)
    }

    /// Moments after a cursor, oldest first, plus whether the cursor fell out
    /// of the ring.
    ///
    /// `truncated` is the honest answer for an orchestrator that slept past the
    /// ring: it missed things, and it must know that rather than believe
    /// nothing happened. The caller re-reads the roster in that case.
    pub fn read_moments(
        &self,
        after_seq: i64,
        limit: usize,
        project_id: Option<&str>,
    ) -> Result<(Vec<crate::pulse::Moment>, bool), String> {
        let conn = self.conn.lock();
        let oldest: Option<i64> = conn
            .query_row("SELECT MIN(seq) FROM moments", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let truncated = matches!(oldest, Some(min) if after_seq > 0 && min > after_seq + 1);
        let mut stmt = conn
            .prepare(
                "SELECT seq, kind, project_id, object_id, detail, source, at FROM moments
                 WHERE seq > ?1 AND (?2 IS NULL OR project_id = ?2)
                 ORDER BY seq ASC LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                rusqlite::params![after_seq, project_id, limit as i64],
                |r| {
                    Ok(crate::pulse::Moment {
                        seq: r.get(0)?,
                        kind: r.get(1)?,
                        project_id: r.get(2)?,
                        object_id: r.get(3)?,
                        detail: r.get(4)?,
                        source: r.get(5)?,
                        at: r.get(6)?,
                    })
                },
            )
            .map_err(|e| e.to_string())?;
        let moments = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok((moments, truncated))
    }

    /// The newest sequence the pulse has handed out, or 0 on an empty ring.
    pub fn latest_moment_seq(&self) -> i64 {
        let conn = self.conn.lock();
        conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM moments", [], |r| r.get(0))
            .unwrap_or(0)
    }

    /// Writes one line of the orchestrator conversation.
    pub fn add_orchestrator_message(
        &self,
        scope: Option<&str>,
        role: &str,
        text: &str,
        aloud: Option<&str>,
        urgency: Option<&str>,
        at: i64,
    ) -> Result<String, String> {
        let conn = self.conn.lock();
        let id = uuid::Uuid::new_v4().simple().to_string();
        conn.execute(
            "INSERT INTO orchestrator_messages (id, scope, role, text, aloud, urgency, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![id, scope, role, text, aloud, urgency, at],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    /// One scope's conversation, oldest first, after an optional cursor id.
    ///
    /// The cursor is resolved to its timestamp first: message ids are random,
    /// so "after this id" only means anything as "after the moment it landed".
    pub fn orchestrator_messages(
        &self,
        scope: Option<&str>,
        since_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>, String> {
        let conn = self.conn.lock();
        // No cursor reads everything, including a row stamped at zero; an
        // unknown cursor reads everything too rather than nothing.
        let since_at: i64 = match since_id {
            Some(id) => conn
                .query_row(
                    "SELECT at FROM orchestrator_messages WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap_or(-1),
            None => -1,
        };
        let mut stmt = conn
            .prepare(
                "SELECT id, role, text, aloud, urgency, at FROM orchestrator_messages
                 WHERE (?1 IS NULL AND scope IS NULL OR scope = ?1) AND at > ?2
                 ORDER BY at ASC, id ASC LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![scope, since_at, limit as i64], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "role": r.get::<_, String>(1)?,
                    "text": r.get::<_, String>(2)?,
                    "aloud": r.get::<_, Option<String>>(3)?,
                    "urgency": r.get::<_, Option<String>>(4)?,
                    "at": r.get::<_, i64>(5)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Settles what the last run of this host left on the rows. Once, at start.
    ///
    /// Two writes, in this order, and nowhere else. A row still naming a process
    /// becomes `stopped`: that thread was on when the host went away, which is a
    /// thread that was cut off rather than one that never started. A row that was
    /// already `stopped` when this host started was on during the run *before*
    /// this one and has not been touched since, so it stops being news and goes
    /// back to `idle`, which draws nothing.
    ///
    /// The second write is what keeps the first from filling the sidebar back up
    /// one restart at a time. Without it, a thread launched once a month ago
    /// would still be reported asleep today, which is the state this whole rule
    /// exists to stop being the default.
    ///
    /// Run before anything reads the table: on the desktop that is where the
    /// store is attached, on the server where it is opened.
    pub fn settle_last_run(&self) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("UPDATE threads SET status = 'idle' WHERE status = 'stopped'", [])
            .map_err(|e| e.to_string())?;
        let live = LIVE_STATUSES
            .iter()
            .map(|s| format!("'{s}'"))
            .collect::<Vec<_>>()
            .join(", ");
        tx.execute(
            &format!("UPDATE threads SET status = 'stopped' WHERE status IN ({live})"),
            [],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn save_thread(&self, t: &Thread) -> Result<(), String> {
        let conn = self.conn.lock();
        let args = serde_json::to_string(&t.args).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT OR REPLACE INTO threads
             (id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, status, keep_awake, created_at, icon_color, worktree_path, settled_at, parent_thread_id, delegation_mode, delegation_status, role, orchestrator_scope, accept_dispatch)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            rusqlite::params![
                t.id, t.project_id, t.label, t.title, t.cmd, args, t.exit_code,
                t.session_id, t.icon_key, t.status, t.keep_awake as i64, t.created_at,
                t.icon_color, t.worktree_path, t.settled_at, t.parent_thread_id,
                t.delegation_mode, t.delegation_status, t.role, t.orchestrator_scope,
                t.accept_dispatch as i64,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_thread_field(
        &self,
        id: &str,
        column: ThreadCol,
        value: ColVal,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        let column = column.as_str();
        let sql = format!("UPDATE threads SET {column} = ?1 WHERE id = ?2");
        match value {
            ColVal::Text(v) => conn.execute(&sql, rusqlite::params![v, id]),
            ColVal::Int(v) => conn.execute(&sql, rusqlite::params![v, id]),
            ColVal::Null => conn.execute(&sql, rusqlite::params![rusqlite::types::Null, id]),
        }
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Where a thread belongs, for whoever has to speak for it out loud.
    ///
    /// The display name prefers the live OSC title over the user label, which is
    /// what an agent renamed the thread to while it worked.
    ///
    /// One query rather than three. The notifier runs on a broadcast receiver
    /// and every status transition in the workspace passes through it, so
    /// looking up the label, then the project id, then the project name would be
    /// three round trips per event to build one sentence.
    pub fn thread_context(&self, id: &str) -> Option<ThreadContext> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT COALESCE(NULLIF(t.title, ''), t.label), t.project_id, p.name
             FROM threads t LEFT JOIN projects p ON p.id = t.project_id
             WHERE t.id = ?1",
            [id],
            |r| {
                Ok(ThreadContext {
                    label: r.get(0)?,
                    project_id: r.get(1)?,
                    project: r.get(2)?,
                })
            },
        )
        .ok()
    }

    /// Deletes a thread and the identity that belonged to it.
    ///
    /// Both, always. A key left behind would let a reused id inherit an owner it
    /// never had, and the owner lock means that one could never be corrected.
    pub fn delete_thread(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM threads WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM thread_keys WHERE thread_id = ?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_settings(&self) -> Result<serde_json::Value, String> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'main'", [], |r| {
                r.get(0)
            })
            .ok();
        match raw {
            Some(s) => Ok(serde_json::from_str(&s).unwrap_or(serde_json::json!({}))),
            None => Ok(serde_json::json!({})),
        }
    }

    pub fn save_settings(&self, value: &serde_json::Value) -> Result<(), String> {
        let conn = self.conn.lock();
        let s = serde_json::to_string(value).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('main', ?1)",
            [s],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Cosmetic workspace identity (name + color), shared by every connected
    /// device so a rename on one phone shows up on the laptop. Stored in the
    /// settings k/v under its own key; clients fetch it via workspace.info.
    pub fn load_workspace_meta(&self) -> Result<serde_json::Value, String> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'workspace'", [], |r| {
                r.get(0)
            })
            .ok();
        match raw {
            Some(s) => Ok(serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({}))),
            None => Ok(serde_json::json!({})),
        }
    }

    pub fn save_workspace_meta(&self, value: &serde_json::Value) -> Result<(), String> {
        let conn = self.conn.lock();
        let s = serde_json::to_string(value).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace', ?1)",
            [s],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn add_push_subscription(
        &self,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        created_at: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![endpoint, p256dh, auth, created_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_push_subscriptions(&self) -> Result<Vec<PushSub>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PushSub {
                    endpoint: r.get(0)?,
                    p256dh: r.get(1)?,
                    auth: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn delete_push_subscription(&self, endpoint: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM push_subscriptions WHERE endpoint = ?1",
            [endpoint],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Writes a paired device down. The secret is already a hash by the time it
    /// reaches here; nothing in this file has ever seen the value it covers.
    pub fn add_pairing(&self, pairing: &pairing::Pairing, secret_hash: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO pairings
             (id, label, kind, scopes, secret_hash, created_at, last_seen_at, revoked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
            rusqlite::params![
                pairing.id,
                pairing.label,
                pairing.kind,
                pairing.scopes.to_text(),
                secret_hash,
                pairing.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Every pairing, revoked ones included.
    ///
    /// A revoked row stays and is shown struck through rather than deleted: the
    /// question a compromised phone raises is *when did that device last reach
    /// this workspace*, and a deleted row answers nothing.
    pub fn list_pairings(&self) -> Result<Vec<pairing::Pairing>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, label, kind, scopes, created_at, last_seen_at, revoked_at
                 FROM pairings ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(pairing::Pairing {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    kind: r.get(2)?,
                    scopes: pairing::ScopeSet::parse(&r.get::<_, String>(3)?),
                    created_at: r.get(4)?,
                    last_seen_at: r.get(5)?,
                    revoked_at: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// One pairing and the hash it is proved against.
    ///
    /// Found by id, which is the half of the credential that is not secret, so
    /// this is an indexed read rather than a scan comparing every stored secret
    /// against the one presented.
    pub fn pairing(&self, id: &str) -> Option<(pairing::Pairing, String)> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, label, kind, scopes, created_at, last_seen_at, revoked_at, secret_hash
             FROM pairings WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    pairing::Pairing {
                        id: r.get(0)?,
                        label: r.get(1)?,
                        kind: r.get(2)?,
                        scopes: pairing::ScopeSet::parse(&r.get::<_, String>(3)?),
                        created_at: r.get(4)?,
                        last_seen_at: r.get(5)?,
                        revoked_at: r.get(6)?,
                    },
                    r.get(7)?,
                ))
            },
        )
        .ok()
    }

    /// Whether this pairing is still allowed to do anything.
    ///
    /// The question a socket that is already open asks, so it stays one indexed
    /// read of one column: revoking a device has to reach the connection it is
    /// holding, not only the next handshake it attempts.
    pub fn pairing_is_live(&self, id: &str) -> bool {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT revoked_at FROM pairings WHERE id = ?1",
            [id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .map(|revoked| revoked.is_none())
        .unwrap_or(false)
    }

    /// Shuts one device out. False means there was nothing open to shut.
    pub fn revoke_pairing(&self, id: &str, at: i64) -> Result<bool, String> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE pairings SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
                rusqlite::params![id, at],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    pub fn touch_pairing(&self, id: &str, at: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE pairings SET last_seen_at = ?2 WHERE id = ?1",
            rusqlite::params![id, at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn add_pairing_token(&self, pending: &pairing::PendingPairing) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO pairing_tokens
             (id, label, kind, scopes, secret_hash, created_at, expires_at, used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
            rusqlite::params![
                pending.id,
                pending.label,
                pending.kind,
                pending.scopes.to_text(),
                pending.secret_hash,
                pending.created_at,
                pending.expires_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn pairing_token(&self, id: &str) -> Option<pairing::PendingPairing> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, label, kind, scopes, secret_hash, created_at, expires_at, used_at
             FROM pairing_tokens WHERE id = ?1",
            [id],
            |r| {
                Ok(pairing::PendingPairing {
                    id: r.get(0)?,
                    label: r.get(1)?,
                    kind: r.get(2)?,
                    scopes: pairing::ScopeSet::parse(&r.get::<_, String>(3)?),
                    secret_hash: r.get(4)?,
                    created_at: r.get(5)?,
                    expires_at: r.get(6)?,
                    used_at: r.get(7)?,
                })
            },
        )
        .ok()
    }

    /// Spends a pairing token, once.
    ///
    /// The `used_at IS NULL AND expires_at > now` lives in the SQL rather than
    /// in a read followed by a write, so two devices presenting the same token
    /// in the same breath produce one pairing and the loser gets `false`. The
    /// same shape as `decide_approval`, for the same reason.
    pub fn spend_pairing_token(&self, id: &str, now: i64) -> Result<bool, String> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE pairing_tokens SET used_at = ?2
                 WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2",
                rusqlite::params![id, now],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    /// Drops tokens nobody can spend any more.
    ///
    /// Spent and expired both: what is left is only ever what is still offered,
    /// so a long-lived server does not accumulate a table of dead invitations.
    pub fn sweep_pairing_tokens(&self, now: i64) -> Result<usize, String> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM pairing_tokens WHERE used_at IS NOT NULL OR expires_at <= ?1",
            [now],
        )
        .map_err(|e| e.to_string())
    }
}

/// One journal entry flattened into the words it could be found by.
fn searchable(recorded: &journal::Recorded) -> String {
    let mut out = String::from(&recorded.action);
    out.push(' ');
    out.push_str(&recorded.actor);
    if let Some(object) = &recorded.object_id {
        out.push(' ');
        out.push_str(object);
    }
    for (key, value) in &recorded.detail {
        out.push(' ');
        out.push_str(key);
        out.push(' ');
        out.push_str(value);
    }
    out
}

pub struct PushSub {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

pub enum ColVal {
    Text(String),
    Int(i64),
    Null,
}

/// Updatable `threads` columns. An enum rather than a `&str`, because
/// update_thread_field interpolates the column into the SQL (it cannot be
/// bound) — a caller-supplied string there is an injection one refactor away.
#[derive(Clone, Copy)]
pub enum ThreadCol {
    Label,
    Title,
    Status,
    ExitCode,
    IconKey,
    SessionId,
    KeepAwake,
    SettledAt,
}

impl ThreadCol {
    fn as_str(self) -> &'static str {
        match self {
            ThreadCol::Label => "label",
            ThreadCol::Title => "title",
            ThreadCol::Status => "status",
            ThreadCol::ExitCode => "exit_code",
            ThreadCol::IconKey => "icon_key",
            ThreadCol::SessionId => "session_id",
            ThreadCol::KeepAwake => "keep_awake",
            ThreadCol::SettledAt => "settled_at",
        }
    }
}

/// How a run ended, which is still true after a restart.
const TERMINAL_STATUSES: &[&str] = &["done", "exited", "error", "stopped"];

/// A process, which no restart survives. Stored all the same: the row saying one
/// of these is the only record that the thread was on when the host went away.
const LIVE_STATUSES: &[&str] = &["running", "ready", "waiting"];

/// What a stored status means to whoever reads the row.
///
/// A row naming a process describes one that stopped existing when the host that
/// spawned it did, so it never reads back as itself. It used to read as `idle`,
/// which is what a row that has never been started says, and the sidebar then
/// drew every thread asleep on every launch. It reads as `stopped` instead — the
/// same word an auto-sleep leaves — because a thread cut off by the app closing
/// was cut off. `idle` is left to the rows that have nothing to say, and those
/// draw nothing at all.
///
/// What is stored stays stored: [`Store::settle_last_run`] is the one place that
/// rewrites it, once per host, and it is what keeps a mark from meaning "asleep"
/// forever.
pub fn display_status(raw: Option<&str>) -> String {
    match raw {
        Some(s) if TERMINAL_STATUSES.contains(&s) => s.to_string(),
        Some(s) if LIVE_STATUSES.contains(&s) => "stopped".to_string(),
        _ => "idle".to_string(),
    }
}

fn normalize_status(raw: Option<String>) -> String {
    display_status(raw.as_deref())
}

/// The three states a todo can be in, and what anything else reads as.
///
/// The agent endpoint writes this table too, so a row can carry a state this
/// build does not know — an older Boite reading a database a newer one wrote, or
/// a value nothing here produced. Unknown reads as `open` rather than
/// disappearing from the list, because a card nobody can see is a card nobody
/// finishes.
///
/// This was in the desktop's TypeScript and nowhere else. Both hosts read the
/// same rows, so only one of them was guarded.
fn normalize_todo_state(raw: String) -> String {
    match raw.as_str() {
        "done" | "claimed" => raw,
        _ => "open".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Guards the migration transaction: user_version must be committed with the
    // statements it gates, or a reopen replays applied ALTERs and dies on
    // "duplicate column name" — permanently, since the server restarts on exit.
    #[test]
    fn migrations_are_idempotent_across_reopen() {
        let dir = std::env::temp_dir().join(format!(
            "boite-migrate-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("boite.db");

        let first = Store::open(&db).expect("first open");
        drop(first);
        let second = Store::open(&db).expect("reopen must not replay migrations");

        let version: i64 = second
            .conn
            .lock()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version as usize, migrations::server().len());

        // Third open, to catch a version bump that only sticks in-memory.
        drop(second);
        Store::open(&db).expect("third open");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A thread's identity is set once and never replaced, which is the whole
    /// reason a stolen thread id is worth nothing on its own.
    #[test]
    fn an_owner_is_never_replaced() {
        let (store, _dir) = scratch_store("owner-lock");
        assert!(store.bind_thread_identity("t1", "aa").is_ok());
        assert_eq!(store.public_key_of_thread("t1").as_deref(), Some("aa"));

        // A second, different key is refused, and the first one stays.
        let stolen = store.bind_thread_identity("t1", "bb").unwrap_err();
        assert!(stolen.contains("already has an owner"), "{stolen}");
        assert_eq!(store.public_key_of_thread("t1").as_deref(), Some("aa"));

        // The same key again is a respawn, not a takeover.
        assert!(store.bind_thread_identity("t1", "aa").is_ok());

        // Forgetting it lets the id be minted again, which is what a deleted
        // thread and a reused id look like.
        store.forget_thread_identity("t1").unwrap();
        assert_eq!(store.public_key_of_thread("t1"), None);
        assert!(store.bind_thread_identity("t1", "bb").is_ok());
    }

    /// A key can be minted before the thread's row lands, because the desktop
    /// persists that row behind the caller while the terminal is mounting.
    #[test]
    fn a_key_does_not_wait_for_the_row_it_belongs_to() {
        let (store, _dir) = scratch_store("early-key");
        assert!(store.bind_thread_identity("not-yet", "aa").is_ok());
        assert_eq!(store.public_key_of_thread("not-yet").as_deref(), Some("aa"));
        // And it still opens nothing on its own: the project comes from a row
        // that is not there.
        assert!(store.project_of_thread("not-yet").is_err());
    }

    /// A thread that predates identities has none, and cannot be given one by
    /// asking: there is nothing to read back.
    #[test]
    fn a_thread_with_no_key_proves_nothing() {
        let (store, _dir) = scratch_store("no-key");
        store
            .conn
            .lock()
            .execute(
                "INSERT INTO threads (id, project_id, label, cmd, args, created_at)
                 VALUES ('old', 'p1', 'a', 'sh', '[]', 0)",
                [],
            )
            .unwrap();
        assert_eq!(store.public_key_of_thread("old"), None);
        assert_eq!(store.public_key_of_thread("never-existed"), None);
    }

    /// Two devices can be looking at the same card. Only one answer lands, and
    /// the other has to come back empty rather than dispatching the same move
    /// a second time.
    #[test]
    fn an_approval_is_answered_once() {
        let (store, _dir) = scratch_store("approval");
        let pending = approval::Pending {
            id: "a1".into(),
            project_id: "p1".into(),
            thread_id: "t1".into(),
            action: "thread.move".into(),
            detail: "other".into(),
            created_at: 10,
        };
        let request = serde_json::json!({ "kind": "thread.move", "threadId": "t1" });
        store.open_approval(&pending, &request).unwrap();

        assert_eq!(store.open_approvals().unwrap(), vec![pending.clone()]);

        let allowed = store
            .decide_approval("a1", approval::Verdict::Allowed, 20)
            .unwrap()
            .expect("the first answer lands");
        assert_eq!(allowed.0, pending);
        // What is replayed is what was asked for, not a reconstruction.
        assert_eq!(allowed.1, request);

        assert!(store
            .decide_approval("a1", approval::Verdict::Refused, 21)
            .unwrap()
            .is_none());
        assert!(store.open_approvals().unwrap().is_empty());
        // And an id nobody opened is not an answer either.
        assert!(store
            .decide_approval("never", approval::Verdict::Allowed, 22)
            .unwrap()
            .is_none());
    }

    /// The rule the sidebar is drawn from: a launch is remembered for exactly
    /// one restart.
    ///
    /// Three rows and three boots. What separates them is the second write in
    /// `settle_last_run`: without it the thread launched in the first run would
    /// still be reported asleep after the third, and a week of those is the
    /// column of sleeping rows this replaced.
    #[test]
    fn a_run_is_remembered_for_one_restart_and_no_more() {
        let (store, _dir) = scratch_store("settle");
        let insert = |id: &str, status: &str| {
            store
                .conn
                .lock()
                .execute(
                    "INSERT INTO threads (id, project_id, label, cmd, args, status, created_at)
                     VALUES (?1, 'p1', 'a', 'sh', '[]', ?2, 0)",
                    rusqlite::params![id, status],
                )
                .unwrap();
        };
        let status_of = |id: &str| {
            store
                .load_threads()
                .unwrap()
                .into_iter()
                .find(|t| t.id == id)
                .unwrap()
                .status
        };

        insert("live", "running");
        insert("never", "idle");
        insert("ended", "exited");

        // A row still naming a process is read as cut off before anything has
        // been settled: the process died with the host that spawned it.
        assert_eq!(status_of("live"), "stopped");

        // First boot after that run. The mark is written down as what it means.
        store.settle_last_run().unwrap();
        assert_eq!(status_of("live"), "stopped");
        assert_eq!(status_of("never"), "idle");
        assert_eq!(status_of("ended"), "exited");

        // A run in which nobody touched it. It stops being news.
        store.settle_last_run().unwrap();
        assert_eq!(status_of("live"), "idle");
        assert_eq!(status_of("ended"), "exited", "how a run ended is not news to decay");
    }

    fn a_pairing(id: &str, scopes: pairing::ScopeSet) -> pairing::Pairing {
        pairing::Pairing {
            id: id.into(),
            label: "a phone".into(),
            kind: "phone".into(),
            scopes,
            created_at: 1,
            last_seen_at: None,
            revoked_at: None,
        }
    }

    /// Revoking one device leaves every other one alone. That is the whole
    /// point: the only revocation before this was rotating the secret that
    /// every device held.
    #[test]
    fn a_revoked_pairing_stops_and_its_neighbours_do_not() {
        let (store, _dir) = scratch_store("pairings");
        store
            .add_pairing(&a_pairing("aa", pairing::ScopeSet::standard()), "hash-a")
            .unwrap();
        store
            .add_pairing(&a_pairing("bb", pairing::ScopeSet::full()), "hash-b")
            .unwrap();

        assert!(store.pairing_is_live("aa"));
        assert!(store.revoke_pairing("aa", 99).unwrap());
        assert!(!store.pairing_is_live("aa"));
        assert!(store.pairing_is_live("bb"));

        // Revoking twice is not a second event, and a row nobody has is not one
        // either. Both answer false rather than erroring, so a device that got
        // there first does not turn the second click into a failure.
        assert!(!store.revoke_pairing("aa", 100).unwrap());
        assert!(!store.revoke_pairing("nobody", 100).unwrap());
        assert!(!store.pairing_is_live("nobody"));

        // The row stays, struck through: "when did that phone last reach this
        // workspace" is the question a compromised device raises, and a deleted
        // row answers nothing.
        let listed = store.list_pairings().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].revoked_at, Some(99));
        assert!(listed[0].revoked());

        // The stored hash comes back beside the row and never inside it.
        let (row, hash) = store.pairing("bb").unwrap();
        assert_eq!(hash, "hash-b");
        assert!(!serde_json::to_string(&row).unwrap().contains("hash-b"));
    }

    /// Once, and only while it is offered. Two devices racing on one link
    /// produce one pairing, the same way two devices answering one approval
    /// produce one verdict.
    #[test]
    fn a_pairing_token_is_spent_exactly_once() {
        let (store, _dir) = scratch_store("tokens");
        let pending = pairing::PendingPairing {
            id: "tok".into(),
            secret_hash: "h".into(),
            label: "new phone".into(),
            kind: "phone".into(),
            scopes: pairing::ScopeSet::standard(),
            created_at: 10,
            expires_at: 100,
            used_at: None,
        };
        store.add_pairing_token(&pending).unwrap();
        assert_eq!(store.pairing_token("tok").unwrap().secret_hash, "h");

        assert!(store.spend_pairing_token("tok", 50).unwrap());
        assert!(!store.spend_pairing_token("tok", 50).unwrap(), "replayed");
        assert_eq!(store.pairing_token("tok").unwrap().used_at, Some(50));

        // Past its expiry it is not offered at all, spent or not.
        let later = pairing::PendingPairing {
            id: "old".into(),
            ..pending.clone()
        };
        store.add_pairing_token(&later).unwrap();
        assert!(!store.spend_pairing_token("old", 200).unwrap());

        // And the sweep leaves only what is still offered.
        let fresh = pairing::PendingPairing {
            id: "live".into(),
            expires_at: 10_000,
            ..pending
        };
        store.add_pairing_token(&fresh).unwrap();
        store.sweep_pairing_tokens(200).unwrap();
        assert!(store.pairing_token("tok").is_none());
        assert!(store.pairing_token("old").is_none());
        assert!(store.pairing_token("live").is_some());
    }

    /// A migrated database in its own directory, removed when the guard drops.
    fn scratch_store(name: &str) -> (Store, ScratchDir) {
        let dir = std::env::temp_dir().join(format!(
            "boite-store-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("boite.db")).unwrap();
        (store, ScratchDir(dir))
    }

    struct ScratchDir(std::path::PathBuf);

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
