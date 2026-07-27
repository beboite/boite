//! The door an agent running inside a Boite terminal uses to reach its own
//! todo list.
//!
//! Three verbs on one table, bound to loopback, behind a per-session bearer
//! token. That narrowness is the whole security argument: the dev-only
//! `mcp-bridge` could already do this through `invoke_tauri`, which is exactly
//! why it cannot ship — a door that does everything cannot be defended, one
//! that lists, adds and claims todos can.
//!
//! The caller never names a project. It presents the thread id Boite stamped
//! into its environment at spawn, and the project is resolved from that, so an
//! agent cannot read or write another project's list.

use std::sync::Mutex;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rand::Rng;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, Manager};

/// Handed to spawned children so they can find and authenticate to this
/// endpoint without any configuration of their own.
#[derive(Clone)]
pub struct AgentApi {
    pub url: String,
    pub token: String,
}

struct Inner {
    conn: Mutex<Connection>,
    token: String,
    app: tauri::AppHandle,
}

#[derive(Serialize)]
struct TodoOut {
    id: String,
    #[serde(rename = "projectId")]
    project_id: String,
    text: String,
    state: String,
    note: Option<String>,
    position: i64,
}

#[derive(Deserialize)]
struct AddIn {
    text: String,
}

#[derive(Deserialize)]
struct ClaimIn {
    id: String,
    note: Option<String>,
    /// The commit the work landed in, if it landed in one. Stored as given and
    /// resolved against the repository before it is ever shown, so a sha
    /// nothing backs reads as unknown rather than as done.
    commit: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Bearer token plus the thread this caller was spawned for. Both must be
/// present: the token proves it came from us, the thread decides what it may
/// see. A stolen token without a thread id reaches nothing.
fn authorize(inner: &Inner, headers: &HeaderMap) -> Result<String, StatusCode> {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    // Length check first so the comparison below cannot be short-circuited by a
    // truncated guess.
    if bearer.len() != inner.token.len() || bearer != inner.token {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };

    // A thread is the precise answer and stays preferred: Boite stamped it into
    // the terminal it launched. A project is what an agent presents when its
    // credentials came from a file — the only route for the ones that hand a
    // server process nothing but PATH. Either way the answer is a project, which
    // is the unit the list belongs to.
    if let Some(thread_id) = header("x-boite-thread") {
        let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        return project_of_thread(&conn, &thread_id);
    }
    let project_id = header("x-boite-project").ok_or(StatusCode::BAD_REQUEST)?;
    // Existence is checked rather than trusted: the id arrives from a file the
    // caller could have edited, and an unknown project must not read as an empty
    // list — that would be a silent wrong answer instead of a refusal.
    let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    conn.query_row(
        "SELECT id FROM projects WHERE id = ?1",
        [&project_id],
        |r| r.get::<_, String>(0),
    )
    .map_err(|_| StatusCode::NOT_FOUND)
}

/// Which agent is speaking, when Boite launched the terminal it speaks from.
///
/// The thread carries the icon key already — it is what the sidebar and the
/// shortcut bar draw — so a claim can be shown under the badge of the agent
/// that made it rather than a generic robot. Credentials that came from a file
/// name a project and no thread, and that claim stays anonymous: an agent Boite
/// did not start is not one it can name.
fn agent_of_request(inner: &Inner, headers: &HeaderMap) -> Option<String> {
    let thread_id = headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())?;
    let conn = inner.conn.lock().ok()?;
    conn.query_row(
        "SELECT icon_key FROM threads WHERE id = ?1",
        [thread_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .filter(|k| !k.is_empty())
}

fn project_of_thread(conn: &Connection, thread_id: &str) -> Result<String, StatusCode> {
    conn.query_row(
        "SELECT project_id FROM threads WHERE id = ?1",
        [thread_id],
        |r| r.get::<_, String>(0),
    )
    .map_err(|_| StatusCode::NOT_FOUND)
}

async fn list(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, text, state, note, position FROM todos
             WHERE project_id = ?1 ORDER BY position ASC, created_at ASC",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map([&project_id], |r| {
            Ok(TodoOut {
                id: r.get(0)?,
                project_id: r.get(1)?,
                text: r.get(2)?,
                state: r.get(3)?,
                note: r.get(4)?,
                position: r.get(5)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(json!({ "todos": rows })))
}

async fn add(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<AddIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let text = body.text.trim().to_string();
    if text.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let id = {
        let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let position: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM todos WHERE project_id = ?1",
                [&project_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let id = format!("{:032x}", rand::thread_rng().gen::<u128>());
        let now = now_ms();
        conn.execute(
            "INSERT INTO todos (id, project_id, text, state, note, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'open', NULL, ?4, ?5, ?5)",
            rusqlite::params![id, project_id, text, position, now],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        id
    };

    let _ = inner.app.emit("boite://todos-changed", ());
    Ok(Json(json!({ "id": id })))
}

/// An agent may only move an item to `claimed`, and only from `open`. The
/// condition is in the SQL rather than in a check above it, so it holds for
/// every caller that ever reaches this row: a model that could tick its own
/// boxes would, and the list would stop recording verified work.
async fn claim(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<ClaimIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    // Read before the write lock is taken: both want the same mutex.
    let agent = agent_of_request(&inner, &headers);
    let changed = {
        let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        conn.execute(
            "UPDATE todos SET state = 'claimed', note = ?1, commit_sha = ?2, claimed_by = ?3,
             updated_at = ?4 WHERE id = ?5 AND project_id = ?6 AND state = 'open'",
            rusqlite::params![body.note, body.commit, agent, now_ms(), body.id, project_id],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };

    if changed == 0 {
        // Either it is not this project's row, or it is no longer open. Both
        // are refusals, and the agent does not get to learn which.
        return Err(StatusCode::CONFLICT);
    }
    let _ = inner.app.emit("boite://todos-changed", ());
    Ok(Json(json!({ "ok": true })))
}

/// Opens a second connection to the database the sql plugin owns. Safe because
/// that plugin opens it in WAL — readers never block, and writers serialize —
/// but only with a busy timeout: without one a write landing during the app's
/// own returns SQLITE_BUSY instead of waiting its turn.
fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    let conn = Connection::open(dir.join("boite.db")).map_err(|e| format!("open db: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("busy_timeout: {e}"))?;
    Ok(conn)
}

/// One credentials file per project, for agents Boite cannot hand anything at
/// launch.
///
/// Rewritten on every start, because the port is ephemeral: a file kept from a
/// previous run would name an address nothing answers on. That is also why the
/// token inside is the session's own — there is no second secret to manage, and
/// nothing here outlives the app by more than one launch.
///
/// Mode 0600 on unix: it grants write access to this workspace's todo lists,
/// which is modest but not nothing, and there is no reason for it to be
/// readable by anyone else on the machine.
fn write_project_credentials(app: &tauri::AppHandle, url: &str, token: &str) {
    let Ok(base) = app.path().app_config_dir() else {
        return;
    };
    let dir = base.join("mcp");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[boite/agent-api] credentials dir: {e}");
        return;
    }

    let conn = match open_db(app) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[boite/agent-api] credentials: {e}");
            return;
        }
    };
    let Ok(mut stmt) = conn.prepare("SELECT id FROM projects") else {
        return;
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
        return;
    };
    for project_id in rows.flatten() {
        let body = json!({ "url": url, "token": token, "projectId": project_id });
        let path = dir.join(format!("{project_id}.json"));
        if let Err(e) = std::fs::write(&path, body.to_string()) {
            eprintln!("[boite/agent-api] write {}: {e}", path.display());
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

/// Binds on an ephemeral loopback port and stores the address plus token in
/// managed state, where the PTY spawn path picks them up. Never binds anything
/// but 127.0.0.1: this endpoint mutates a workspace, and nothing about it
/// belongs on a LAN or a tailnet.
pub fn start(app: &tauri::AppHandle) {
    let conn = match open_db(app) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[boite/agent-api] disabled: {e}");
            return;
        }
    };

    let token = format!("{:032x}", rand::thread_rng().gen::<u128>());
    let inner = std::sync::Arc::new(Inner {
        conn: Mutex::new(conn),
        token: token.clone(),
        app: app.clone(),
    });

    let router = Router::new()
        .route("/v1/todos", get(list).post(add))
        .route("/v1/todos/claim", post(claim))
        .with_state(inner);

    // Bound here, not inside the task: the address has to be known before the
    // first thread can spawn. Registering it from the task left a window where
    // pty_open found no state and launched an agent with no credentials — the
    // shim then exits, and the agent reports only that its MCP server closed
    // the connection. Small window, but it is exactly the moment someone starts
    // a terminal: right after the app opens.
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[boite/agent-api] bind failed: {e}");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            eprintln!("[boite/agent-api] local_addr failed: {e}");
            return;
        }
    };
    if let Err(e) = listener.set_nonblocking(true) {
        eprintln!("[boite/agent-api] set_nonblocking failed: {e}");
        return;
    }
    let url = format!("http://127.0.0.1:{port}");
    write_project_credentials(app, &url, &token);
    app.manage(AgentApi {
        url,
        token,
    });

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[boite/agent-api] listener adoption failed: {e}");
                return;
            }
        };
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[boite/agent-api] serve ended: {e}");
        }
    });
}
