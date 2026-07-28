//! The door an agent running inside a Boite terminal uses to reach its own
//! todo list.
//!
//! Three verbs on one table, bound to loopback, behind a per-session bearer
//! token. That narrowness is the whole security argument: the dev-only
//! `mcp-bridge` could already do this through `invoke_tauri`, which is exactly
//! why it cannot ship — a door that does everything cannot be defended, one
//! that lists, adds and claims todos can.
//!
//! An agent Boite launched never names a project: it presents the thread id
//! stamped into its environment at spawn, and the project is resolved from
//! that, so it cannot reach another project's list.
//!
//! An agent registered from a credentials file does name one, and the check on
//! it is that the project exists — not that it is the agent's own. Every file
//! carries the same session token, so an agent wired for one project can read
//! and write the lists of the others by editing the id in its own config. That
//! is the price of reaching agents that hand a server process nothing but PATH;
//! it is a scope within one workspace, not across workspaces, and the token
//! dies with the process.

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

/// Everything an agent asks for that only the app can carry out.
///
/// Moving a thread, creating a project and opening a second terminal all mean
/// killing or spawning a PTY, opening or releasing a worktree, and writing rows
/// the front end owns. None of that belongs behind an HTTP handler holding a
/// second connection to the database — so the endpoint checks what it can see,
/// emits, and lets the app do the work.
const AGENT_REQUEST: &str = "boite://agent-request";

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
    /// The one-line label of the card. Named `text` in the table since before
    /// there was anything else on a row; `title` is what it is called on the
    /// way out, because that is what an agent has to keep short.
    title: String,
    description: Option<String>,
    state: String,
    note: Option<String>,
    position: i64,
}

#[derive(Deserialize)]
struct AddIn {
    /// `text` stays accepted: it is what every shim built before the split
    /// sends, and a rejected add would read to the agent as a broken endpoint
    /// rather than as an old binary.
    #[serde(alias = "text")]
    title: String,
    #[serde(default)]
    description: Option<String>,
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
    // Where the agent is running, which beats the project its file names: the
    // entry is one per agent while the file is one per project, so a
    // registration made from project A used to keep answering for A everywhere.
    // The directory is the one thing that moves with the user.
    if let Some(cwd) = header("x-boite-cwd") {
        let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if let Some(id) = project_of_cwd(&conn, &cwd) {
            return Ok(id);
        }
        // Fall through rather than refuse: a directory no project claims is not
        // an error when the file still names one, and answering for that
        // project is what this did before the header existed.
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

/// The repository and the worktree this caller is running in.
///
/// Requires the thread header rather than accepting a project: a worktree
/// belongs to one terminal, and an agent that registered through a credentials
/// file names a project and could not say which of its threads it is.
fn worktree_of_request(
    inner: &Inner,
    headers: &HeaderMap,
) -> Result<(String, String), StatusCode> {
    let thread_id = headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (worktree, cwd, git_root): (Option<String>, String, Option<String>) = conn
        .query_row(
            "SELECT t.worktree_path, p.cwd, p.git_root
             FROM threads t JOIN projects p ON p.id = t.project_id
             WHERE t.id = ?1",
            [thread_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| StatusCode::NOT_FOUND)?;
    // CONFLICT rather than NOT_FOUND: the thread exists and simply runs in the
    // project folder, which is a state the agent should be told about plainly.
    let worktree = worktree.ok_or(StatusCode::CONFLICT)?;
    Ok((git_root.unwrap_or(cwd), worktree))
}

/// Where this terminal is working, and what it may still do about it.
async fn worktree_status(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (repo, worktree) = worktree_of_request(&inner, &headers)?;
    let hold = boite_core::git::worktree_hold_blocking(&worktree)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let branches = boite_core::git::branches_blocking(&repo).unwrap_or_default();
    let current = boite_core::git::repo_info_blocking(&worktree)
        .ok()
        .and_then(|i| i.branch);
    Ok(Json(json!({
        "path": worktree,
        "repo": repo,
        "branch": current,
        "detached": current.is_none(),
        "uncommittedChanges": hold.dirty,
        "branches": branches.iter().map(|b| &b.name).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct BranchIn {
    name: String,
}

/// Names a new branch for the work done here.
async fn worktree_branch(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<BranchIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (_, worktree) = worktree_of_request(&inner, &headers)?;
    match boite_core::git::claim_worktree_branch_blocking(&worktree, &body.name) {
        Ok(()) => {
            let _ = inner.app.emit("boite://worktrees-changed", ());
            Ok(Json(json!({ "branch": body.name })))
        }
        // The reason matters to the caller and none of it is secret: it is the
        // agent's own working copy being described back to it.
        Err(e) => Ok(Json(json!({ "error": e }))),
    }
}

/// Takes over a branch that already exists, to continue it.
async fn worktree_reserve(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<BranchIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (_, worktree) = worktree_of_request(&inner, &headers)?;
    match boite_core::git::reserve_worktree_branch_blocking(&worktree, &body.name) {
        Ok(()) => {
            let _ = inner.app.emit("boite://worktrees-changed", ());
            Ok(Json(json!({ "branch": body.name })))
        }
        Err(e) => Ok(Json(json!({ "error": e }))),
    }
}

/// The thread this caller is running in.
///
/// Required by everything that acts on the terminal itself. An agent registered
/// through a credentials file names a project and could not say which of its
/// threads it is — there is no answer to give it.
fn thread_of_request(inner: &Inner, headers: &HeaderMap) -> Result<String, StatusCode> {
    let thread_id = headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .ok_or(StatusCode::BAD_REQUEST)?
        .to_string();
    let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    conn.query_row("SELECT id FROM threads WHERE id = ?1", [&thread_id], |r| {
        r.get::<_, String>(0)
    })
    .map_err(|_| StatusCode::NOT_FOUND)
}

#[derive(Serialize)]
struct ProjectOut {
    id: String,
    name: String,
    path: String,
    archived: bool,
    /// Whether this is the project the calling thread is in right now.
    current: bool,
}

/// Every project in the workspace, archived ones included.
///
/// The list an agent reads before asking to be moved, so it has to show the put
/// away ones too: "move me back into the thing we shelved last month" is a
/// sentence people say, and hiding those rows would have the agent create a
/// second project on top of the first.
async fn projects(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let current = authorize(&inner, &headers)?;
    let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = conn
        .prepare("SELECT id, name, cwd, archived FROM projects ORDER BY name COLLATE NOCASE")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            Ok(ProjectOut {
                current: id == current,
                id,
                name: r.get(1)?,
                path: r.get(2)?,
                archived: r.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({ "projects": rows })))
}

/// Which project the caller means, from an id, a name or a path.
///
/// An agent has a list with all three on it and no reason to prefer one, so all
/// three are accepted. A name that matches more than one project is refused
/// rather than guessed: picking the first would move a conversation into the
/// wrong repository, and there is no undo for the folder it then works in.
fn resolve_project(conn: &Connection, needle: &str) -> Result<String, String> {
    let needle = needle.trim();
    if needle.is_empty() {
        return Err("name the project to move into".into());
    }
    if let Ok(id) = conn.query_row(
        "SELECT id FROM projects WHERE id = ?1",
        [needle],
        |r| r.get::<_, String>(0),
    ) {
        return Ok(id);
    }

    let mut stmt = conn
        .prepare("SELECT id, name, cwd FROM projects")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let target = norm(needle);
    if let Some((id, _, _)) = rows.iter().find(|(_, _, cwd)| norm(cwd) == target) {
        return Ok(id.clone());
    }
    let by_name: Vec<&(String, String, String)> = rows
        .iter()
        .filter(|(_, name, _)| name.to_lowercase() == target)
        .collect();
    if by_name.len() == 1 {
        return Ok(by_name[0].0.clone());
    }
    if by_name.len() > 1 {
        return Err(format!(
            "more than one project is called '{needle}'; give the id or the path instead"
        ));
    }
    Err(format!(
        "no project called '{needle}'. Call projects_list to see what there is."
    ))
}

#[derive(Deserialize)]
struct MoveIn {
    /// An id, a name or a path — whichever the agent has to hand.
    project: String,
    /// What to say to the agent when it comes back up in the new folder.
    note: Option<String>,
}

/// Asks Boite to move the calling thread into another project.
///
/// Answered the moment the request is understood, not when the move is done,
/// and that is not a shortcut: this call kills the process that made it. The
/// PTY runs in a directory, so a thread cannot change project while it is
/// alive — the reply is written, the terminal goes down, and the agent comes
/// back up in the new folder with its conversation resumed. Nothing would ever
/// read a result posted later.
///
/// What the endpoint does own is the refusal. An unknown or ambiguous project
/// is settled here, in front of the agent, while it is still running.
async fn thread_move(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<MoveIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let thread_id = thread_of_request(&inner, &headers)?;
    let (project_id, name) = {
        let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let id = match resolve_project(&conn, &body.project) {
            Ok(id) => id,
            Err(reason) => return Ok(Json(json!({ "error": reason }))),
        };
        let name: String = conn
            .query_row("SELECT name FROM projects WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap_or_else(|_| id.clone());
        (id, name)
    };

    let _ = inner.app.emit(
        AGENT_REQUEST,
        json!({
            "kind": "thread.move",
            "threadId": thread_id,
            "projectId": project_id,
            "note": body.note,
        }),
    );
    Ok(Json(json!({ "project": name })))
}

#[derive(Deserialize)]
struct CreateProjectIn {
    name: String,
    path: Option<String>,
    parent: Option<String>,
    /// Take over a folder that already has files in it.
    adopt: Option<bool>,
    /// Run `git init`. On unless said otherwise.
    git: Option<bool>,
    /// Move the calling thread into it once it exists. On unless said
    /// otherwise: an agent that just gave an idea a home is the one working on
    /// it.
    r#move: Option<bool>,
    note: Option<String>,
}

/// Gives a conversation somewhere to live: a folder, a repository, a project.
///
/// Same fire-and-forget shape as the move, and for the same reason — the
/// default is to move the calling thread in, which kills it. Boite settles what
/// the endpoint cannot see from here: whether the folder is free, whether a
/// project is already there, whether an archived one should come back.
async fn project_create(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<CreateProjectIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    // A thread is only needed for the move. An agent wired through a
    // credentials file can still create a project; it just stays where it is.
    let thread_id = thread_of_request(&inner, &headers).ok();
    authorize(&inner, &headers)?;
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Ok(Json(json!({ "error": "a project needs a name" })));
    }

    let _ = inner.app.emit(
        AGENT_REQUEST,
        json!({
            "kind": "project.create",
            "threadId": thread_id,
            "name": name,
            "path": body.path,
            "parent": body.parent,
            "adopt": body.adopt.unwrap_or(false),
            "git": body.git.unwrap_or(true),
            "move": body.r#move.unwrap_or(true) && thread_id.is_some(),
            "note": body.note,
        }),
    );
    Ok(Json(json!({ "name": name })))
}

#[derive(Deserialize)]
struct SpawnIn {
    /// Which agent to start, as an icon key (`claude`, `codex`, …) or the label
    /// of one of the user's shortcuts.
    agent: Option<String>,
    /// Where. The caller's own project when left out.
    project: Option<String>,
    /// The first thing the new thread is asked to do.
    prompt: Option<String>,
}

/// Starts a second agent, in this project or another.
///
/// The caller survives this one, so the answer is real: the request was
/// understood and the terminal is being opened. What it still cannot report is
/// the new thread's id, because the id is minted by the side that spawns it —
/// and an agent has nothing to do with one anyway. It sees its colleague in the
/// sidebar like everyone else.
async fn thread_spawn(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<SpawnIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let own_project = authorize(&inner, &headers)?;
    let project_id = match &body.project {
        Some(needle) => {
            let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            match resolve_project(&conn, needle) {
                Ok(id) => id,
                Err(reason) => return Ok(Json(json!({ "error": reason }))),
            }
        }
        None => own_project,
    };

    let _ = inner.app.emit(
        AGENT_REQUEST,
        json!({
            "kind": "thread.spawn",
            "projectId": project_id,
            // Who asked, so an unnamed agent defaults to another of the caller
            // rather than to whatever terminal the user happens to be looking
            // at. Absent for an agent wired through a credentials file.
            "callerThreadId": thread_of_request(&inner, &headers).ok(),
            "agent": body.agent,
            "prompt": body.prompt,
        }),
    );
    Ok(Json(json!({ "ok": true })))
}

/// Which agent is speaking, when Boite launched the terminal it speaks from.
///
/// The thread carries the icon key already — it is what the sidebar and the
/// shortcut bar draw — so a claim can be shown under the badge of the agent
/// that made it rather than a generic robot. Credentials that came from a file
/// name a project and no thread, and that claim stays anonymous: an agent Boite
/// did not start is not one it can name.
fn agent_of_request(inner: &Inner, headers: &HeaderMap) -> Option<String> {
    if let Some(thread_id) = headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
    {
        if let Ok(conn) = inner.conn.lock() {
            let from_thread = conn
                .query_row(
                    "SELECT icon_key FROM threads WHERE id = ?1",
                    [thread_id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten()
                .filter(|k| !k.is_empty());
            if from_thread.is_some() {
                return from_thread;
            }
        }
    }

    // Otherwise the registration says so: the Todo panel writes the agent's own
    // name into the line it hands over, because it knows which row the button
    // was under.
    headers
        .get("x-boite-agent")
        .and_then(|v| v.to_str().ok())
        .and_then(known_agent)
}

/// The header, if it names an agent this app can draw.
///
/// Checked rather than taken: the value comes from a config file the user (or
/// anything with write access to it) can edit, it ends up stored on a row and
/// then in an `<img>` path, and an unrecognised one would at best be a badge
/// nobody knows.
fn known_agent(value: &str) -> Option<String> {
    const KNOWN: [&str; 8] = [
        "claude",
        "codex",
        "antigravity",
        "cursor",
        "copilot",
        "opencode",
        "grok",
        "hermes",
    ];
    let value = value.trim().to_ascii_lowercase();
    KNOWN.contains(&value.as_str()).then_some(value)
}

async fn list(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let conn = inner.conn.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, text, description, state, note, position FROM todos
             WHERE project_id = ?1 ORDER BY position ASC, created_at ASC",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map([&project_id], |r| {
            Ok(TodoOut {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                description: r.get(3)?,
                state: r.get(4)?,
                note: r.get(5)?,
                position: r.get(6)?,
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
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    // An empty string and a missing description are the same thing, and only
    // one of them should reach the column: the panel shows a marker on any row
    // that has a body, and `Some("")` would put one on a card with nothing in
    // it.
    let description = body
        .description
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());

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
            "INSERT INTO todos
             (id, project_id, text, description, state, note, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'open', NULL, ?5, ?6, ?6)",
            rusqlite::params![id, project_id, title, description, position, now],
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
        if let Err(e) = write_one(app, url, token, &project_id) {
            eprintln!("[boite/agent-api] credentials for {project_id}: {e}");
        }
    }
}

/// One project's file, written wherever the caller found the project.
///
/// Public because the loop above only covers what existed at startup. A project
/// added since has no file, and the panel offering to wire an agent for it is
/// exactly when that becomes visible — so the command behind that panel writes
/// it then. Late or early is the same act: the file names a port that lives and
/// dies with this process.
pub fn write_one(
    app: &tauri::AppHandle,
    url: &str,
    token: &str,
    project_id: &str,
) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    let dir = base.join("mcp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("credentials dir: {e}"))?;

    let body = json!({ "url": url, "token": token, "projectId": project_id });
    let path = dir.join(format!("{project_id}.json"));
    std::fs::write(&path, body.to_string()).map_err(|e| format!("write: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path)
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
        .route("/v1/worktree", get(worktree_status))
        .route("/v1/worktree/branch", post(worktree_branch))
        .route("/v1/worktree/reserve", post(worktree_reserve))
        .route("/v1/projects", get(projects).post(project_create))
        .route("/v1/thread/move", post(thread_move))
        .route("/v1/threads", post(thread_spawn))
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

fn project_of_thread(conn: &Connection, thread_id: &str) -> Result<String, StatusCode> {
    conn.query_row(
        "SELECT project_id FROM threads WHERE id = ?1",
        [thread_id],
        |r| r.get::<_, String>(0),
    )
    .map_err(|_| StatusCode::NOT_FOUND)
}

/// Undoes the shim's percent-encoding of the cwd header.
///
/// Lenient by design: a stray `%` that starts no valid pair is kept as itself
/// rather than dropped, since the worst case here is a path that matches no
/// project, and refusing to decode would turn that into no answer at all.
fn decode_header_path(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| match b {
                b'0'..=b'9' => Some(b - b'0'),
                b'a'..=b'f' => Some(b - b'a' + 10),
                b'A'..=b'F' => Some(b - b'A' + 10),
                _ => None,
            };
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Normalized the same way both sides of a path comparison have to be: the
/// separator agents report varies on Windows, a trailing slash is noise, and
/// the two file systems this ships on are case-insensitive.
fn normalize_path(p: &str) -> String {
    p.replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

/// The project a directory belongs to, if any.
///
/// The deepest match wins, so a project nested inside another answers for its
/// own subtree rather than losing it to the parent. A prefix only counts on a
/// separator boundary — `/a/boite` must not swallow `/a/boite-mcp`.
fn project_of_cwd(conn: &Connection, cwd: &str) -> Option<String> {
    let target = normalize_path(&decode_header_path(cwd));
    if target.is_empty() {
        return None;
    }
    let mut stmt = conn.prepare("SELECT id, cwd FROM projects").ok()?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .ok()?;

    let mut best: Option<(String, usize)> = None;
    for (id, project_cwd) in rows.flatten() {
        let Some(root) = project_cwd.map(|c| normalize_path(&c)) else {
            continue;
        };
        if root.is_empty() {
            continue;
        }
        let inside = target == root
            || (target.starts_with(&root) && target.as_bytes().get(root.len()) == Some(&b'/'));
        if inside && best.as_ref().is_none_or(|(_, len)| root.len() > *len) {
            best = Some((id, root.len()));
        }
    }
    best.map(|(id, _)| id)
}

#[cfg(test)]
mod cwd_resolution_tests {
    use super::{decode_header_path, project_of_cwd};
    use rusqlite::Connection;

    fn projects(rows: &[(&str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE projects (id TEXT, cwd TEXT)", [])
            .unwrap();
        for (id, cwd) in rows {
            conn.execute("INSERT INTO projects VALUES (?1, ?2)", [id, cwd])
                .unwrap();
        }
        conn
    }

    #[test]
    fn the_directory_itself_and_anything_under_it() {
        let conn = projects(&[("p", "/w/boite")]);
        assert_eq!(project_of_cwd(&conn, "/w/boite").as_deref(), Some("p"));
        assert_eq!(project_of_cwd(&conn, "/w/boite/src").as_deref(), Some("p"));
        assert_eq!(project_of_cwd(&conn, "/w").as_deref(), None);
        assert_eq!(project_of_cwd(&conn, "").as_deref(), None);
    }

    /// A prefix is not a parent. `/w/boite` must not answer for `/w/boite-mcp`,
    /// which is a sibling that merely starts the same way.
    #[test]
    fn a_prefix_only_counts_on_a_separator() {
        let conn = projects(&[("p", "/w/boite")]);
        assert_eq!(project_of_cwd(&conn, "/w/boite-mcp").as_deref(), None);
    }

    /// A project inside another answers for its own subtree: the deepest root
    /// wins rather than the first row read.
    #[test]
    fn the_deepest_project_wins() {
        let conn = projects(&[("outer", "/w"), ("inner", "/w/apps/api")]);
        assert_eq!(project_of_cwd(&conn, "/w/apps/api/src").as_deref(), Some("inner"));
        assert_eq!(project_of_cwd(&conn, "/w/apps/web").as_deref(), Some("outer"));
    }

    /// The header is percent-encoded, since a header value is visible ASCII and
    /// a directory is not. Windows separators and case follow the same
    /// normalisation both sides use.
    #[test]
    fn encoded_accents_and_windows_paths_resolve() {
        let conn = projects(&[("p", "/w/réf onte"), ("q", r"C:\Users\x\Boite")]);
        assert_eq!(
            project_of_cwd(&conn, "/w/r%C3%A9f%20onte/src").as_deref(),
            Some("p")
        );
        assert_eq!(project_of_cwd(&conn, r"c:\users\x\boite").as_deref(), Some("q"));
    }

    /// A `%` that starts no valid pair is kept rather than dropped: the worst
    /// case is a path that matches nothing, and losing bytes would be worse.
    #[test]
    fn a_stray_percent_survives_decoding() {
        assert_eq!(decode_header_path("/w/100%/x"), "/w/100%/x");
        assert_eq!(decode_header_path("/w/a%zz"), "/w/a%zz");
    }
}

#[cfg(test)]
mod agent_header_tests {
    use super::known_agent;

    #[test]
    fn only_agents_the_app_can_draw_get_through() {
        assert_eq!(known_agent("copilot").as_deref(), Some("copilot"));
        assert_eq!(known_agent("  Copilot \n").as_deref(), Some("copilot"));

        for junk in [
            "",
            "terminal",
            "../../etc/passwd",
            "<img src=x>",
            "copilot; rm -rf /",
        ] {
            assert_eq!(known_agent(junk), None, "{junk}");
        }
    }
}
