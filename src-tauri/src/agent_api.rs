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
use subtle::ConstantTimeEq;
use tauri::{Emitter, Manager};
use url::Url;

use boite_core::project;
use boite_core::scope::ProjectRoots;

/// Everything an agent asks for that only the app can carry out.
///
/// Moving a thread, creating a project and opening a second terminal all mean
/// killing or spawning a PTY, opening or releasing a worktree, and writing rows
/// the front end owns. None of that belongs behind an HTTP handler holding a
/// second connection to the database — so the endpoint checks what it can see,
/// emits, and lets the app do the work.
const AGENT_REQUEST: &str = "boite://agent-request";

/// Says an agent just reached into Boite itself, and through which door.
///
/// Everything else an agent does happens inside its terminal, where it can be
/// read. This endpoint is the one thing that does not: a todo appears, a
/// worktree takes a branch, a thread moves, and the only trace is the result
/// showing up somewhere with nothing to say who did it. The window is what
/// tells the user, so the window has to be told.
///
/// Mutations only. `todo_list` and `worktree_status` run on most agent turns,
/// and a pulse on every read would be a light that is always on, which is a
/// light that says nothing.
const AGENT_ACTIVITY: &str = "boite://agent-activity";

fn note_activity(inner: &Inner, headers: &HeaderMap, surface: &str) {
    // Attribution is best-effort: an agent registered from a credentials file
    // presents a project rather than a thread, and there is no row to point at.
    // The surface still pulses; only the "which of these agents" half is lost.
    let thread_id = headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let _ = inner.app.emit(
        AGENT_ACTIVITY,
        json!({ "surface": surface, "threadId": thread_id }),
    );
}

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
    // Constant time: a byte-by-byte `!=` short-circuits, and this endpoint
    // answers on loopback, where anything running as the same user can call it
    // in a loop and read the token out of the timing instead of guessing it.
    let ok: bool = bearer.as_bytes().ct_eq(inner.token.as_bytes()).into();
    if !ok {
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

/// Runs git somewhere other than on the runtime's worker threads.
///
/// These handlers are futures like any other, so a `git` process spawned in one
/// of them holds a worker for as long as git takes. `worktree_status` runs on
/// most agent turns and spawns three, and the app has one runtime for
/// everything: with a few agents talking at once, the threads that carry the
/// window's own commands are inside `CreateProcess` instead. A launch waiting on
/// `worktree_open` cannot be answered while that lasts.
async fn off_thread<T, F>(work: F) -> Result<T, StatusCode>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// Where this terminal is working, and what it may still do about it.
async fn worktree_status(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (repo, worktree) = worktree_of_request(&inner, &headers)?;
    // One hop for the three of them: each is a process, and paying the handoff
    // once is the difference between three round trips and one.
    let (hold, branches, current) = {
        let repo = repo.clone();
        let worktree = worktree.clone();
        off_thread(move || {
            let hold = boite_core::git::worktree_hold_blocking(&worktree);
            let branches = boite_core::git::branches_blocking(&repo).unwrap_or_default();
            let current = boite_core::git::repo_info_blocking(&worktree)
                .ok()
                .and_then(|i| i.branch);
            (hold, branches, current)
        })
        .await?
    };
    let hold = hold.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
    let name = body.name.clone();
    let claimed = off_thread(move || {
        boite_core::git::claim_worktree_branch_blocking(&worktree, &name)
    })
    .await?;
    match claimed {
        Ok(()) => {
            note_activity(&inner, &headers, "worktree");
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
    let name = body.name.clone();
    let reserved = off_thread(move || {
        boite_core::git::reserve_worktree_branch_blocking(&worktree, &name)
    })
    .await?;
    match reserved {
        Ok(()) => {
            note_activity(&inner, &headers, "worktree");
            let _ = inner.app.emit("boite://worktrees-changed", ());
            Ok(Json(json!({ "branch": body.name })))
        }
        Err(e) => Ok(Json(json!({ "error": e }))),
    }
}

/// What this project shares with its worktrees, and whether anyone said so.
async fn artifacts_status(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (repo, _) = worktree_of_request(&inner, &headers)?;
    let policy = boite_core::git::effective_artifact_policy(std::path::Path::new(&repo));
    Ok(Json(json!({
        "repo": repo,
        "file": boite_core::git::POLICY_FILE,
        "declared": policy.declared,
        "shared": policy.shared,
    })))
}

/// Replaces the policy with the one given. Refusals arrive as a 200 carrying an
/// `error`: a directory name the policy may not hold is the agent's to fix, and
/// it needs to read which one.
async fn artifacts_set(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<boite_core::git::ArtifactPolicy>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (repo, _) = worktree_of_request(&inner, &headers)?;
    match boite_core::git::write_artifact_policy(std::path::Path::new(&repo), &body) {
        Ok(()) => Ok(Json(json!({
            "file": boite_core::git::POLICY_FILE,
            "shared": body.shared,
        }))),
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

    note_activity(&inner, &headers, "thread");
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
/// the endpoint cannot see from here: whether an archived project should come
/// back, what the folder is called, where it goes when the caller did not say.
///
/// What the endpoint does own, like the move, is the refusal it can reach:
/// whatever folder the caller pointed at, path or parent, is checked against the
/// same rules the front end would apply, while the agent is still running to
/// read the answer. Left to the app, a refusal is a notification on screen and
/// the agent has already been told its project is being created.
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
    if let Some(reason) = folder_refusal(&inner, &body) {
        return Ok(Json(json!({ "error": reason })));
    }

    note_activity(&inner, &headers, "project");
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

/// Why the folder an agent named cannot become a project, if it cannot.
///
/// Everything the app has to be running for: which projects are already there,
/// and where a new one is allowed to go. The rule itself is `folder_refusal_for`.
fn folder_refusal(inner: &Inner, body: &CreateProjectIn) -> Option<String> {
    let path = spelled(body.path.as_deref());
    let parent = spelled(body.parent.as_deref());
    if path.is_none() && parent.is_none() {
        return None;
    }
    // A project already sitting there is reused, archived or not, and none of
    // the rules about empty folders apply to it. Only asked of a path, since a
    // parent is not the folder the project lands in.
    let known = path.is_some_and(|path| match inner.conn.lock() {
        Ok(conn) => project_already_at(&conn, path),
        Err(_) => false,
    });
    let scope = inner.app.state::<ProjectRoots>();
    let allowed = crate::commands::new_project_roots(&inner.app, &scope);
    folder_refusal_for(path, parent, body.adopt.unwrap_or(false), known, &allowed)
}

/// The rule, against what the app answered.
///
/// The two refusals the front end would give that are reachable from here: the
/// folder already holds somebody's work, or it sits outside the places a
/// project is allowed to go. Both are questions about paths and the roots
/// already registered, so both are settled before anything is emitted.
///
/// A caller who named neither a path nor a parent gets no refusal: Boite puts
/// the folder beside the user's other projects, which is inside the boundary by
/// construction. A parent is checked as a parent: where the folder goes is the
/// only thing it settles, because the folder's name comes from the project name
/// through a rule the front end owns.
fn folder_refusal_for(
    path: Option<&str>,
    parent: Option<&str>,
    adopt: bool,
    known: bool,
    allowed: &[String],
) -> Option<String> {
    let Some(path) = path else {
        let parent = parent?;
        return (!project::may_create_project_in(parent, allowed))
            .then(|| crate::commands::WRONG_PLACE_FOR_A_PROJECT.to_string());
    };
    if known {
        return None;
    }
    match project::folder_state_blocking(path) {
        project::FolderState::Occupied if !adopt => Some(format!(
            "{path} already has files in it. Pass adopt to take it over, or pick another path."
        )),
        // Where it may go is only asked when there is a folder to make. One
        // already sitting there empty is taken as it is, exactly as the front
        // end takes it.
        project::FolderState::Missing => (!project::may_create_project_at(path, allowed))
            .then(|| crate::commands::WRONG_PLACE_FOR_A_PROJECT.to_string()),
        _ => None,
    }
}

/// A field the caller actually filled in, trimmed.
fn spelled(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// Whether one of the user's projects already lives at that folder.
///
/// A read that cannot refuse anything on its own: a table it cannot query, or a
/// row it cannot read, answers no and leaves the decision to the front end,
/// which is where it was before this check existed. The caller answers the same
/// way for a connection it cannot lock.
fn project_already_at(conn: &Connection, path: &str) -> bool {
    // Read out into owned strings before answering: the statement and the rows
    // both borrow the connection, and nothing that borrows it may still be
    // alive when this returns.
    let cwds: Vec<String> = match conn.prepare("SELECT cwd FROM projects") {
        Ok(mut stmt) => match stmt.query_map([], |row| row.get::<_, String>(0)) {
            Ok(rows) => rows.flatten().collect(),
            Err(_) => return false,
        },
        Err(_) => return false,
    };
    cwds.iter().any(|cwd| project::same_folder(cwd, path))
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

#[derive(Deserialize)]
struct PaneOpenIn {
    /// One of: dashboard, git, explorer, todo, editor, browser.
    kind: String,
    /// Required for `browser`, ignored otherwise.
    #[serde(default)]
    url: Option<String>,
    /// left, right, top or bottom. Defaults to right.
    #[serde(default)]
    side: Option<String>,
}

/// Hosts that mean "this machine", spelled exactly as a URL serializes them.
///
/// The list is short and literal on purpose: it is mirrored one for one by the
/// `frame-src` list in `tauri.conf.json`, and a host this accepts that the CSP
/// does not is a pane that opens blank. `127.0.0.2` is loopback to the network
/// stack and is deliberately not here — nobody runs a dev server on it, and a
/// rule the CSP cannot express is a rule that does not hold.
const LOCAL_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"];

/// The ports the app itself is served from in a dev build. See `BrowserUrl`.
const APP_PORTS: [u16; 2] = [1420, 1430];

/// An address a browser pane may point at, and whether it leaves this machine.
struct BrowserUrl {
    /// Re-serialized by the parser, so what the app frames is what was checked.
    url: String,
    /// Off this machine, so the app asks the user before framing it.
    external: bool,
}

/// Decides what a browser pane is allowed to point at.
///
/// The address is not a link an agent printed, it is a document the app is
/// about to host inside its own window, and a `starts_with("http://")` says
/// nothing about that: `http://evil.com@localhost` passes it, so does
/// `http://[::]`, and so does the app's own origin. Four rules, all of them on
/// a parsed URL:
///
/// - **Scheme.** http or https, so `file://` and custom schemes cannot reach
///   further than "show me a page" ever needs to.
/// - **No credentials.** A userinfo segment exists here only to make the host
///   read as something it is not.
/// - **Never the app's own origin.** Tauri serves the window from
///   `*.localhost`, and the dev build from a port on loopback. A page framed
///   there is same-origin with the webview, which means `window.parent` and
///   the IPC behind it.
/// - **Cleartext stays on this machine.** A local dev server is the case this
///   exists for; plain http to anywhere else is a document the network writes,
///   and the shipped CSP frames no such thing either.
///
/// Anything that survives all four and is not on this machine is legal but not
/// silent: it comes back marked `external`, and the app puts the user in front
/// of it before the frame is created.
fn classify_browser_url(raw: &str) -> Result<BrowserUrl, String> {
    let parsed = Url::parse(raw).map_err(|_| "that is not a url".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("url must start with http:// or https://".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("url must not carry a username or a password".to_string());
    }
    let Some(host) = parsed.host_str().map(|h| h.to_ascii_lowercase()) else {
        return Err("url must name a host".to_string());
    };
    if host.ends_with(".localhost") {
        return Err("that is Boite's own origin, not a page".to_string());
    }
    let on_this_machine = LOCAL_HOSTS.contains(&host.as_str());
    if on_this_machine && parsed.port().is_some_and(|p| APP_PORTS.contains(&p)) {
        return Err("that is Boite's own origin, not a page".to_string());
    }
    if parsed.scheme() == "http" && !on_this_machine {
        return Err(format!(
            "http reaches {} only; use https off this machine",
            LOCAL_HOSTS.join(", ")
        ));
    }
    Ok(BrowserUrl {
        url: parsed.to_string(),
        external: !on_this_machine,
    })
}

/// Shows the user something, beside the terminal the agent is talking in.
///
/// The half of the split that no keyboard shortcut can provide: an agent that
/// has just written a file, opened a branch or started a dev server knows what
/// is worth looking at, and until now the only way to say so was to print a
/// path and hope. It is deliberately the weakest verb here — it arranges panes
/// and touches no state — which is why it is also the only one that does not
/// pulse the sidebar: the pane appearing is its own notification.
async fn pane_open(
    State(inner): State<std::sync::Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<PaneOpenIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let kind = body.kind.trim().to_lowercase();
    const KINDS: [&str; 6] = ["dashboard", "git", "explorer", "todo", "editor", "browser"];
    if !KINDS.contains(&kind.as_str()) {
        return Ok(Json(json!({
            "error": format!("unknown pane kind '{}', expected one of {}", kind, KINDS.join(", "))
        })));
    }
    // Checked here rather than in the app: the agent is still alive to read a
    // refusal, and a browser pane with no address is a blank frame the user has
    // to close by hand.
    let (url, external) = match kind.as_str() {
        "browser" => {
            let raw = body.url.as_deref().map(str::trim).unwrap_or("");
            if raw.is_empty() {
                return Ok(Json(json!({ "error": "browser panes need a url" })));
            }
            match classify_browser_url(raw) {
                Ok(target) => (Some(target.url), target.external),
                Err(reason) => return Ok(Json(json!({ "error": reason }))),
            }
        }
        _ => (None, false),
    };
    let side = match body.side.as_deref().map(str::trim) {
        Some("left") => "left",
        Some("top") => "top",
        Some("bottom") => "bottom",
        _ => "right",
    };

    let _ = inner.app.emit(
        AGENT_REQUEST,
        json!({
            "kind": "pane.open",
            "projectId": project_id,
            "callerThreadId": thread_of_request(&inner, &headers).ok(),
            "pane": kind,
            "url": url,
            // Off this machine, so the app asks before framing it. The app
            // classifies the address again on its side rather than trusting
            // this: the same event also arrives from a remote boite, which
            // never went through this handler at all.
            "external": external,
            "side": side,
        }),
    );
    Ok(Json(json!({ "ok": true })))
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

    note_activity(&inner, &headers, "thread");
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

    note_activity(&inner, &headers, "todo");
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
    note_activity(&inner, &headers, "todo");
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
        .route("/v1/artifacts", get(artifacts_status).post(artifacts_set))
        .route("/v1/projects", get(projects).post(project_create))
        .route("/v1/thread/move", post(thread_move))
        .route("/v1/threads", post(thread_spawn))
        .route("/v1/pane/open", post(pane_open))
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

/// The security boundary of the browser pane, so it is tested as one.
///
/// Everything here is a case that the old `starts_with("http://")` check let
/// through: a host that is not the host it reads as, the app's own origin, and
/// a remote page opening silently in the user's window.
#[cfg(test)]
mod browser_url_tests {
    use super::classify_browser_url;

    fn refused(raw: &str) -> String {
        classify_browser_url(raw)
            .err()
            .unwrap_or_else(|| panic!("{raw} was allowed"))
    }

    fn allowed(raw: &str) -> (String, bool) {
        let target = classify_browser_url(raw)
            .unwrap_or_else(|e| panic!("{raw} was refused: {e}"));
        (target.url, target.external)
    }

    #[test]
    fn a_dev_server_on_this_machine_opens_without_asking() {
        for raw in [
            "http://localhost:5173/",
            "http://127.0.0.1:3000/x?y=1",
            "http://[::1]:8080/",
            "http://0.0.0.0:4000/",
            "https://localhost:5173/",
        ] {
            let (_, external) = allowed(raw);
            assert!(!external, "{raw}");
        }
    }

    #[test]
    fn anywhere_else_is_legal_but_never_silent() {
        let (url, external) = allowed("https://github.com/beboite/boite/pull/1");
        assert!(external);
        assert_eq!(url, "https://github.com/beboite/boite/pull/1");
    }

    /// The one the prefix check could never see: the host a human reads is the
    /// userinfo, and the host the request goes to is whatever follows the `@`.
    #[test]
    fn credentials_in_the_authority_are_refused() {
        for raw in [
            "http://evil.com@localhost/",
            "http://evil.com@127.0.0.1:1234/",
            "https://user:pass@example.com/",
        ] {
            assert!(refused(raw).contains("username"), "{raw}");
        }
    }

    /// `tauri.localhost` is the window itself on Windows, and 1420 is the dev
    /// server. A page framed at either reaches `window.parent` and the IPC.
    #[test]
    fn the_apps_own_origin_is_refused_outright() {
        for raw in [
            "http://tauri.localhost/index.html",
            "http://ipc.localhost/",
            "http://asset.localhost/x",
            "https://tauri.localhost/",
            "http://localhost:1420/",
            "http://127.0.0.1:1420/",
            "http://localhost:1430/",
        ] {
            assert!(refused(raw).contains("own origin"), "{raw}");
        }
    }

    /// Cleartext off this machine is refused rather than confirmed: the shipped
    /// `frame-src` does not carry plain `http:` either, so allowing it here
    /// would only produce a pane that asks the user a question and then stays
    /// blank whatever they answer.
    #[test]
    fn cleartext_stops_at_this_machine() {
        assert!(refused("http://example.com/").contains("https"));
        assert!(refused("http://[::]/").contains("https"));
        assert!(refused("http://127.0.0.2:3000/").contains("https"));
    }

    #[test]
    fn only_http_and_https_are_schemes() {
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>x</script>",
            "tauri://localhost/",
            "not a url at all",
            "localhost:3000",
        ] {
            let _ = refused(raw);
        }
    }

    /// What the app frames is what was checked, not the string the agent sent.
    #[test]
    fn the_answer_is_the_parsed_form() {
        let (url, _) = allowed("HTTP://LocalHost:3000");
        assert_eq!(url, "http://localhost:3000/");
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

#[cfg(test)]
mod create_project_tests {
    use super::*;
    use std::path::PathBuf;

    /// A stand-in for the user's disk: `dev` holds the projects they already
    /// have, `home` is their home folder, `elsewhere` is the rest of the
    /// machine. The roots are the first two, which is the shape
    /// `new_project_roots` hands over at runtime.
    struct Disk {
        base: PathBuf,
    }

    impl Disk {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "boite-agent-create-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(base.join("dev").join("thing")).unwrap();
            std::fs::create_dir_all(base.join("home")).unwrap();
            std::fs::create_dir_all(base.join("elsewhere")).unwrap();
            std::fs::write(base.join("dev").join("thing").join("README.md"), "mine").unwrap();
            Self { base }
        }

        fn at(&self, rel: &str) -> String {
            let mut p = self.base.clone();
            for part in rel.split('/') {
                p = p.join(part);
            }
            p.to_string_lossy().to_string()
        }

        fn roots(&self) -> Vec<String> {
            vec![self.at("dev"), self.at("home")]
        }
    }

    impl Drop for Disk {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn wrong_place() -> Option<String> {
        Some(crate::commands::WRONG_PLACE_FOR_A_PROJECT.to_string())
    }

    /// The field that used to reach the front end unread: a parent is as
    /// arbitrary as a path, and an agent naming a system folder is told so
    /// while it is still running rather than being told its project is on the
    /// way.
    #[test]
    fn a_parent_outside_the_places_a_project_may_go_is_refused() {
        let disk = Disk::new("parent");
        let roots = disk.roots();
        let refusal = |parent: &str| folder_refusal_for(None, Some(parent), false, false, &roots);

        assert_eq!(refusal(&disk.at("elsewhere")), wrong_place());
        assert_eq!(refusal(&disk.at("elsewhere/deeper")), wrong_place());
        assert_eq!(refusal(&disk.at("dev/../elsewhere")), wrong_place());
        // Beside the projects already there, and under the home folder, are the
        // two that are allowed.
        assert_eq!(refusal(&disk.at("dev")), None);
        assert_eq!(refusal(&disk.at("home")), None);
        assert_eq!(refusal(&disk.at("dev/team")), None);
    }

    #[test]
    fn a_path_outside_the_places_a_project_may_go_is_refused() {
        let disk = Disk::new("path");
        let roots = disk.roots();
        let refusal = |path: &str| folder_refusal_for(Some(path), None, false, false, &roots);

        assert_eq!(refusal(&disk.at("elsewhere/newproj")), wrong_place());
        assert_eq!(refusal(&disk.at("elsewhere/deeper/newproj")), wrong_place());
        // Climbing back out of a root lands outside it.
        assert_eq!(refusal(&disk.at("dev/../elsewhere/newproj")), wrong_place());
        assert_eq!(refusal(&disk.at("dev/newproj")), None);
        assert_eq!(refusal(&disk.at("home/ideas/newproj")), None);
    }

    /// Somebody's work is never taken without saying so, wherever it sits.
    #[test]
    fn a_folder_with_files_in_it_is_refused_unless_it_is_adopted() {
        let disk = Disk::new("occupied");
        let occupied = disk.at("dev/thing");

        let reason = folder_refusal_for(Some(&occupied), None, false, false, &disk.roots());
        assert!(
            reason.is_some_and(|r| r.starts_with(&occupied) && r.contains("adopt")),
            "an occupied folder names itself in the refusal"
        );
        assert_eq!(
            folder_refusal_for(Some(&occupied), None, true, false, &disk.roots()),
            None
        );
    }

    /// A project already at that folder is a reuse, and a reuse asks none of
    /// the questions above, which is why the comparator behind `known` has to
    /// be the filesystem's own idea of one folder and not a looser one.
    #[test]
    fn a_project_already_there_is_reused_rather_than_refused() {
        let disk = Disk::new("known");
        assert_eq!(
            folder_refusal_for(Some(&disk.at("dev/thing")), None, false, true, &disk.roots()),
            None
        );
        assert_eq!(
            folder_refusal_for(
                Some(&disk.at("elsewhere/thing")),
                None,
                false,
                true,
                &disk.roots()
            ),
            None
        );
    }

    /// The path is where the project goes, so it is the one that answers. A
    /// caller who named neither is left to Boite, which puts the folder beside
    /// the projects already there.
    #[test]
    fn the_path_answers_when_both_are_given_and_nothing_does_when_neither_is() {
        let disk = Disk::new("both");
        let roots = disk.roots();

        assert_eq!(
            folder_refusal_for(
                Some(&disk.at("dev/newproj")),
                Some(&disk.at("elsewhere")),
                false,
                false,
                &roots
            ),
            None
        );
        assert_eq!(
            folder_refusal_for(
                Some(&disk.at("elsewhere/newproj")),
                Some(&disk.at("dev")),
                false,
                false,
                &roots
            ),
            wrong_place()
        );
        assert_eq!(folder_refusal_for(None, None, false, false, &roots), None);
        // A field holding nothing but spaces is a field nobody filled.
        assert_eq!(
            folder_refusal_for(spelled(Some("  ")), spelled(Some("")), false, false, &roots),
            None
        );
    }

    fn projects_db(cwds: &[&str]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE projects (id TEXT, cwd TEXT)", [])
            .unwrap();
        for cwd in cwds {
            conn.execute(
                "INSERT INTO projects (id, cwd) VALUES (?1, ?2)",
                rusqlite::params![cwd, cwd],
            )
            .unwrap();
        }
        conn
    }

    #[cfg(windows)]
    const STORED: &str = r"D:\Dev\Perso\thing";
    #[cfg(not(windows))]
    const STORED: &str = "/home/me/dev/thing";

    #[test]
    fn a_project_is_found_at_the_folder_it_was_stored_with() {
        let conn = projects_db(&[STORED]);
        assert!(project_already_at(&conn, STORED));
        assert!(!project_already_at(&conn, &format!("{STORED}-other")));
        // A folder deeper in is another folder, or a project inside a project
        // would read as the one holding it.
        assert!(!project_already_at(&conn, &format!("{STORED}/inner")));
        assert!(!project_already_at(&projects_db(&[]), STORED));
    }

    /// Windows ignores case and takes either separator, so the two spellings
    /// are one folder and the endpoint has to read them as one.
    #[cfg(windows)]
    #[test]
    fn on_windows_a_project_is_found_however_its_folder_is_spelled() {
        let conn = projects_db(&[STORED]);
        assert!(project_already_at(&conn, "d:/dev/perso/thing"));
        assert!(project_already_at(&conn, r"D:\Dev\Perso\thing\"));
    }

    /// Everywhere else `Thing` and `thing` are two folders. Answering yes for
    /// the wrong one skips both the occupied check and the scope check, so a
    /// change of case would be a way past them.
    #[cfg(not(windows))]
    #[test]
    fn off_windows_a_folder_that_differs_in_case_is_not_that_project() {
        let conn = projects_db(&[STORED]);
        assert!(project_already_at(&conn, &format!("{STORED}/")));
        assert!(!project_already_at(&conn, "/home/me/dev/Thing"));
        assert!(!project_already_at(&conn, "/HOME/me/dev/thing"));
    }

    /// A database this cannot read decides nothing: the front end still asks
    /// every question the endpoint asks, which is where the answer came from
    /// before the check existed.
    #[test]
    fn a_database_with_no_projects_table_refuses_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(!project_already_at(&conn, STORED));
    }
}
