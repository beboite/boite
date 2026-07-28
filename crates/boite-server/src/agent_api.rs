//! The server-side twin of the desktop `agent_api`: the door an agent running
//! in a remote workspace uses to reach its own todo list.
//!
//! It gets its own listener on loopback rather than routes on the main router,
//! and its own token. The main server may be bound to a routable interface —
//! that is the whole point of a remote workspace — and nothing here belongs on
//! a network. The client token and this one are also different secrets: a
//! device that can drive the workspace is not the same principal as an agent
//! that may append to a checklist.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;

use crate::events::AppEvent;
use crate::store::Store;

#[derive(Clone)]
pub struct AgentApi {
    pub url: String,
    pub token: String,
}

struct Inner {
    store: Arc<Store>,
    events: broadcast::Sender<AppEvent>,
    token: String,
}

#[derive(Deserialize)]
struct AddIn {
    /// `text` stays accepted: it is what every shim built before the title and
    /// the body were split sends, and refusing it would read to the agent as a
    /// broken endpoint rather than as an old binary.
    #[serde(alias = "text")]
    title: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct ClaimIn {
    id: String,
    note: Option<String>,
    /// The commit the work landed in, if it landed in one. Stored as given: the
    /// client resolves it against this machine's repository before showing it,
    /// so a sha nothing backs reads as unknown rather than as done.
    commit: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Token proves the caller came from us; the thread decides what it may see.
/// A leaked token with no thread id reaches nothing.
fn authorize(inner: &Inner, headers: &HeaderMap) -> Result<String, StatusCode> {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if bearer.len() != inner.token.len() || bearer != inner.token {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let thread_id = headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if thread_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    inner
        .store
        .project_of_thread(thread_id)
        .map_err(|_| StatusCode::NOT_FOUND)
}

/// The repository and worktree behind this caller's thread. CONFLICT when the
/// thread runs in the project folder: it exists, it simply has no worktree, and
/// the agent should be told that rather than given a not-found.
fn worktree_of_request(
    inner: &Inner,
    headers: &HeaderMap,
) -> Result<(String, String), StatusCode> {
    // Goes through authorize first: the token still has to be right, and the
    // thread still has to belong to a project this server knows.
    authorize(inner, headers)?;
    let thread_id = headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    inner
        .store
        .worktree_of_thread(thread_id)
        .ok_or(StatusCode::CONFLICT)
}

/// The thread this caller runs in, once it is known to belong to a project
/// here. Everything that acts on the terminal itself needs it.
fn thread_of_request(inner: &Inner, headers: &HeaderMap) -> Result<String, StatusCode> {
    authorize(inner, headers)?;
    Ok(headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string())
}

/// Every project in the workspace, archived ones marked rather than hidden: a
/// project the user put away is still the right place to go back to, and
/// leaving it off the list is how an agent ends up creating a second one on top
/// of the first.
async fn projects(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let current = authorize(&inner, &headers)?;
    let projects = inner
        .store
        .load_projects()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows: Vec<serde_json::Value> = projects
        .into_iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "path": p.cwd,
                "archived": p.archived,
                "current": p.id == current,
            })
        })
        .collect();
    Ok(Json(json!({ "projects": rows })))
}

/// Which project the caller means, from an id, a name or a path. A name that
/// matches two projects is refused rather than guessed: picking one would move
/// a conversation into the wrong repository, and the folder it then works in is
/// not something an undo covers.
fn resolve_project(inner: &Inner, needle: &str) -> Result<(String, String), String> {
    let needle = needle.trim();
    if needle.is_empty() {
        return Err("name the project to move into".into());
    }
    let projects = inner.store.load_projects().map_err(|e| e.to_string())?;
    if let Some(p) = projects.iter().find(|p| p.id == needle) {
        return Ok((p.id.clone(), p.name.clone()));
    }
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let target = norm(needle);
    if let Some(p) = projects.iter().find(|p| norm(&p.cwd) == target) {
        return Ok((p.id.clone(), p.name.clone()));
    }
    let by_name: Vec<&crate::models::Project> = projects
        .iter()
        .filter(|p| p.name.to_lowercase() == target)
        .collect();
    if by_name.len() == 1 {
        return Ok((by_name[0].id.clone(), by_name[0].name.clone()));
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

/// Hands a request to the connected devices, tagged so exactly one acts on it.
///
/// The server cannot carry any of these out: moving a thread means killing a
/// PTY and opening a worktree, and the client is what drives both. It also
/// cannot know which device is looking, so the request goes to all of them and
/// `agent.claimRequest` settles who takes it.
fn dispatch(inner: &Inner, mut request: serde_json::Value) {
    request["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    let _ = inner.events.send(AppEvent::AgentRequest(request));
}

#[derive(Deserialize)]
struct MoveIn {
    project: String,
    note: Option<String>,
}

/// Moves the calling thread into another project.
///
/// Answered as soon as the request is understood, not when it is done: this
/// call kills the process that made it. A thread cannot change project while
/// its PTY is alive, so the reply is written, the terminal goes down, and the
/// agent comes back up in the new folder with its conversation resumed. What
/// the endpoint does own is the refusal — an unknown or ambiguous project is
/// settled here, while the agent is still running to read it.
async fn thread_move(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<MoveIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let thread_id = thread_of_request(&inner, &headers)?;
    let (project_id, name) = match resolve_project(&inner, &body.project) {
        Ok(found) => found,
        Err(reason) => return Ok(Json(json!({ "error": reason }))),
    };
    dispatch(
        &inner,
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
    adopt: Option<bool>,
    git: Option<bool>,
    r#move: Option<bool>,
    note: Option<String>,
}

/// Gives a conversation somewhere to live: a folder, a repository, a project,
/// and by default this terminal moved into it. Same fire-and-forget shape as
/// the move, for the same reason.
async fn project_create(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<CreateProjectIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let thread_id = thread_of_request(&inner, &headers)?;
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Ok(Json(json!({ "error": "a project needs a name" })));
    }
    dispatch(
        &inner,
        json!({
            "kind": "project.create",
            "threadId": thread_id,
            "name": name,
            "path": body.path,
            "parent": body.parent,
            "adopt": body.adopt.unwrap_or(false),
            "git": body.git.unwrap_or(true),
            "move": body.r#move.unwrap_or(true),
            "note": body.note,
        }),
    );
    Ok(Json(json!({ "name": name })))
}

#[derive(Deserialize)]
struct SpawnIn {
    agent: Option<String>,
    project: Option<String>,
    prompt: Option<String>,
}

/// Opens a second agent terminal. The caller survives this one, so the answer
/// is real: the request was understood and a terminal is being opened. The new
/// thread's id is not in it — that is minted by the side that spawns it, and an
/// agent has nothing to do with one.
async fn thread_spawn(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<SpawnIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let own_project = authorize(&inner, &headers)?;
    let project_id = match &body.project {
        Some(needle) => match resolve_project(&inner, needle) {
            Ok((id, _)) => id,
            Err(reason) => return Ok(Json(json!({ "error": reason }))),
        },
        None => own_project,
    };
    dispatch(
        &inner,
        json!({
            "kind": "thread.spawn",
            "projectId": project_id,
            // Who asked, so an unnamed agent defaults to another of the caller
            // rather than to whatever terminal the user happens to be looking
            // at.
            "callerThreadId": thread_of_request(&inner, &headers).ok(),
            "agent": body.agent,
            "prompt": body.prompt,
        }),
    );
    Ok(Json(json!({ "ok": true })))
}

async fn worktree_status(
    State(inner): State<Arc<Inner>>,
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

async fn worktree_branch(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<BranchIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (_, worktree) = worktree_of_request(&inner, &headers)?;
    match boite_core::git::claim_worktree_branch_blocking(&worktree, &body.name) {
        Ok(()) => {
            let _ = inner.events.send(AppEvent::TodosChanged);
            Ok(Json(json!({ "branch": body.name })))
        }
        Err(e) => Ok(Json(json!({ "error": e }))),
    }
}

async fn worktree_reserve(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<BranchIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (_, worktree) = worktree_of_request(&inner, &headers)?;
    match boite_core::git::reserve_worktree_branch_blocking(&worktree, &body.name) {
        Ok(()) => {
            let _ = inner.events.send(AppEvent::TodosChanged);
            Ok(Json(json!({ "branch": body.name })))
        }
        Err(e) => Ok(Json(json!({ "error": e }))),
    }
}

async fn list(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let todos = inner
        .store
        .todos_for_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({ "todos": todos })))
}

async fn add(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<AddIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let title = body.title.trim();
    if title.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    // An empty body and no body are the same thing, and only one of them
    // should reach the column: the panel marks every row that has a
    // description, and `Some("")` would mark a card with nothing in it.
    let description = body
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty());
    let id = inner
        .store
        .add_todo(&project_id, title, description, now_ms())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = inner.events.send(AppEvent::TodosChanged);
    Ok(Json(json!({ "id": id })))
}

async fn claim(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<ClaimIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    // The thread names the agent: this server spawned it, so it knows what it
    // is. Nothing the caller sends decides this.
    let agent = headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .and_then(|id| inner.store.agent_of_thread(id));
    let changed = inner
        .store
        .claim_todo(
            &body.id,
            &project_id,
            body.note.as_deref(),
            body.commit.as_deref(),
            agent.as_deref(),
            now_ms(),
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !changed {
        // Not this project's row, or no longer open. Both are refusals, and the
        // agent does not get to learn which.
        return Err(StatusCode::CONFLICT);
    }
    let _ = inner.events.send(AppEvent::TodosChanged);
    Ok(Json(json!({ "ok": true })))
}

/// Says no, in one place, rather than letting the router answer 404.
///
/// Chats are a local-workspace feature: `caps.chat` is false on the remote
/// backend, there is no `chats` table here, and the shim that reaches this is
/// the same binary the desktop uses. Without this route the agent would be told
/// the call was refused and left to guess whether it lacked permission or
/// spelled the tool wrong. The refusal is the answer, so it is worth stating.
async fn chat_handover() -> Result<Json<serde_json::Value>, StatusCode> {
    Err(StatusCode::NOT_IMPLEMENTED)
}

/// Binds an ephemeral loopback port and returns what the PTY spawn path stamps
/// into each child. Returns None if the listener cannot start: the workspace
/// still works, agents just have no todo access.
pub async fn start(store: Arc<Store>, events: broadcast::Sender<AppEvent>) -> Option<AgentApi> {
    let token = format!("{:032x}", rand::random::<u128>());
    let inner = Arc::new(Inner {
        store,
        events,
        token: token.clone(),
    });

    let router = Router::new()
        .route("/v1/todos", get(list).post(add))
        .route("/v1/todos/claim", post(claim))
        .route("/v1/worktree", get(worktree_status))
        .route("/v1/worktree/branch", post(worktree_branch))
        .route("/v1/worktree/reserve", post(worktree_reserve))
        .route("/v1/chat/handover", post(chat_handover))
        .route("/v1/projects", get(projects).post(project_create))
        .route("/v1/thread/move", post(thread_move))
        .route("/v1/threads", post(thread_spawn))
        .with_state(inner);

    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!("agent api disabled, bind failed: {e}");
            return None;
        }
    };
    let port = listener.ok_port()?;

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::warn!("agent api ended: {e}");
        }
    });

    Some(AgentApi {
        url: format!("http://127.0.0.1:{port}"),
        token,
    })
}

/// Small helper so the bind path stays a single expression chain.
trait LocalPort {
    fn ok_port(&self) -> Option<u16>;
}

impl LocalPort for tokio::net::TcpListener {
    fn ok_port(&self) -> Option<u16> {
        self.local_addr().ok().map(|a| a.port())
    }
}
