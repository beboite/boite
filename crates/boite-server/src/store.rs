use std::path::Path;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::models::{Project, Thread, Todo};

pub struct Store {
    conn: Mutex<Connection>,
}

// Append-only, mirrors the tauri-plugin-sql migrations in src-tauri/src/lib.rs.
// Each entry runs once, gated by PRAGMA user_version.
const MIGRATIONS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        default_cmd TEXT NOT NULL,
        default_args TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );",
    "ALTER TABLE projects ADD COLUMN icon TEXT;",
    "CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );",
    "CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        label TEXT NOT NULL,
        title TEXT,
        cmd TEXT NOT NULL,
        args TEXT NOT NULL,
        exit_code INTEGER,
        created_at INTEGER NOT NULL
    );",
    "ALTER TABLE threads ADD COLUMN session_id TEXT;
     ALTER TABLE threads ADD COLUMN icon_key TEXT;",
    "ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE threads ADD COLUMN status TEXT;
     ALTER TABLE threads ADD COLUMN auto_slept INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE threads ADD COLUMN keep_awake INTEGER NOT NULL DEFAULT 0;",
    // Web Push subscriptions (server-global, like settings). endpoint is the
    // browser-issued push URL and the natural primary key: re-subscribing the
    // same browser replaces the row instead of duplicating it.
    "CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );",
    "ALTER TABLE projects ADD COLUMN git_root TEXT;",
    "ALTER TABLE threads ADD COLUMN icon_color TEXT;",
    // A table rather than a key in the settings blob: an agent writes here
    // through the MCP endpoint while a client is connected, and a whole-blob
    // rewrite from either side would drop the other's edits.
    "CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        text TEXT NOT NULL,
        state TEXT NOT NULL,
        note TEXT,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_todos_project ON todos (project_id);",
    // Both mirror a desktop migration: the same client reads either store, and
    // a column missing on one side means a claim made against a remote boite
    // silently loses its commit and its badge.
    "ALTER TABLE todos ADD COLUMN commit_sha TEXT;",
    "ALTER TABLE todos ADD COLUMN claimed_by TEXT;",
];

impl Store {
    pub fn open(path: &Path) -> Result<Store, String> {
        let conn = Connection::open(path).map_err(|e| format!("open db failed: {e}"))?;
        // WAL + NORMAL: thread status/title updates fire on agent activity, and
        // the default rollback journal with synchronous=FULL costs an fsync per
        // UPDATE. On the SD card of a small ARM box that dominates both latency
        // and flash wear. WAL still survives a process crash; only a host power
        // loss can lose the last commits, which for cosmetic thread metadata is
        // the right trade. busy_timeout keeps a concurrent reader from erroring
        // out instantly on a write lock.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|e| format!("pragma setup failed: {e}"))?;
        let store = Store {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| format!("read user_version failed: {e}"))?;
        let mut applied = version as usize;
        if applied >= MIGRATIONS.len() {
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
        while applied < MIGRATIONS.len() {
            tx.execute_batch(MIGRATIONS[applied])
                .map_err(|e| format!("migration {} failed: {e}", applied + 1))?;
            applied += 1;
        }
        tx.execute_batch(&format!("PRAGMA user_version = {applied};"))
            .map_err(|e| format!("set user_version failed: {e}"))?;
        tx.commit()
            .map_err(|e| format!("migration commit failed: {e}"))?;
        Ok(())
    }

    pub fn load_todos(&self) -> Result<Vec<Todo>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, text, state, note, commit_sha, claimed_by,
                        position, created_at, updated_at
                 FROM todos ORDER BY position ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Todo {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    text: r.get(2)?,
                    state: r.get(3)?,
                    note: r.get(4)?,
                    commit_sha: r.get(5)?,
                    claimed_by: r.get(6)?,
                    position: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn save_todo(&self, t: &Todo) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO todos
             (id, project_id, text, state, note, commit_sha, claimed_by,
              position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                t.id,
                t.project_id,
                t.text,
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
                "SELECT id, project_id, text, state, note, commit_sha, claimed_by,
                        position, created_at, updated_at
                 FROM todos WHERE project_id = ?1 ORDER BY position ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(Todo {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    text: r.get(2)?,
                    state: r.get(3)?,
                    note: r.get(4)?,
                    commit_sha: r.get(5)?,
                    claimed_by: r.get(6)?,
                    position: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
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

    pub fn add_todo(&self, project_id: &str, text: &str, now: i64) -> Result<String, String> {
        let conn = self.conn.lock();
        let position: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM todos WHERE project_id = ?1",
                [project_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let id = format!("{:032x}", rand::random::<u128>());
        conn.execute(
            "INSERT INTO todos (id, project_id, text, state, note, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'open', NULL, ?4, ?5, ?5)",
            rusqlite::params![id, project_id, text, position, now],
        )
        .map_err(|e| e.to_string())?;
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
        Ok(())
    }

    pub fn load_projects(&self) -> Result<Vec<Project>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, cwd, icon, archived, git_root FROM projects ORDER BY created_at ASC")
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
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn save_project(&self, p: &Project, created_at: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO projects (id, name, cwd, default_cmd, default_args, icon, archived, git_root, created_at)
             VALUES (?1, ?2, ?3, '', '[]', ?4, ?5, ?6, ?7)",
            rusqlite::params![p.id, p.name, p.cwd, p.icon, p.archived as i64, p.git_root, created_at],
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
                "SELECT id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, status, keep_awake, created_at, icon_color
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
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn load_thread(&self, id: &str) -> Result<Option<Thread>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, status, keep_awake, created_at, icon_color
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
    pub fn thread_status(&self, id: &str) -> Option<(String, Option<i32>)> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT status, exit_code FROM threads WHERE id = ?1",
            [id],
            |r| Ok((normalize_status(r.get::<_, Option<String>>(0)?), r.get::<_, Option<i32>>(1)?)),
        )
        .ok()
    }

    pub fn save_thread(&self, t: &Thread) -> Result<(), String> {
        let conn = self.conn.lock();
        let args = serde_json::to_string(&t.args).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT OR REPLACE INTO threads
             (id, project_id, label, title, cmd, args, exit_code, session_id, icon_key, status, keep_awake, created_at, icon_color)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                t.id, t.project_id, t.label, t.title, t.cmd, args, t.exit_code,
                t.session_id, t.icon_key, t.status, t.keep_awake as i64, t.created_at,
                t.icon_color,
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

    /// Display name for a thread, used by the notifier. Prefers the live OSC
    /// title over the user label.
    pub fn thread_label(&self, id: &str) -> Option<String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT COALESCE(NULLIF(title, ''), label) FROM threads WHERE id = ?1",
            [id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    }

    pub fn delete_thread(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM threads WHERE id = ?1", [id])
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
        }
    }
}

const TERMINAL_STATUSES: &[&str] = &["done", "exited", "error", "stopped"];

fn normalize_status(raw: Option<String>) -> String {
    match raw {
        Some(s) if TERMINAL_STATUSES.contains(&s.as_str()) => s,
        _ => "idle".to_string(),
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
        assert_eq!(version as usize, MIGRATIONS.len());

        // Third open, to catch a version bump that only sticks in-memory.
        drop(second);
        Store::open(&db).expect("third open");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
