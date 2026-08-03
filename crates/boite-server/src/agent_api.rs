//! The server-side twin of the desktop `agent_api`: the door an agent running
//! in a remote workspace uses to reach its own todo list.
//!
//! It gets its own listener on loopback rather than routes on the main router,
//! and its own token. The main server may be bound to a routable interface —
//! that is the whole point of a remote workspace — and nothing here belongs on
//! a network. The client token and this one are also different secrets: a
//! device that can drive the workspace is not the same principal as an agent
//! that may append to a checklist.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;

use boite_core::browser;
use boite_core::journal::{Action, Actor, Entry};
use boite_core::project;
use boite_core::scope::ProjectRoots;

use crate::events::AppEvent;
use boite_core::store::Store;

/// What a spawned terminal is told about the agent endpoint.
///
/// There is no token here on purpose. It used to carry the value, which then
/// went into every child's environment; a terminal is handed the path now, and
/// the only copy of the secret outside this process is a file only its user can
/// read.
#[derive(Clone)]
pub struct AgentApi {
    pub url: String,
    pub token_path: PathBuf,
}

struct Inner {
    store: Arc<Store>,
    events: broadcast::Sender<AppEvent>,
    /// Authenticated clients right now. Zero means nothing on the other side
    /// can carry out a request, and saying so beats answering `200`.
    devices: Arc<std::sync::atomic::AtomicUsize>,
    token: String,
    /// The same boundary the RPC applies, so where a project may be created is
    /// one rule rather than two that drift.
    roots: Arc<ProjectRoots>,
    workspace_dir: Option<PathBuf>,
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
    // Constant time, like every other token check here: a byte-by-byte `!=`
    // short-circuits, and a local process that can call this in a loop reads the
    // token out of the timing rather than guessing it.
    let ok: bool = bearer.as_bytes().ct_eq(inner.token.as_bytes()).into();
    if !ok {
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
    let by_name: Vec<&boite_core::model::Project> = projects
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

/// The actor behind a request, for the log.
///
/// A thread id is not an identity yet, it is an address the caller presents.
/// It is what the log can honestly say today, and the one place that will
/// change when threads carry a key.
fn actor(headers: &HeaderMap) -> Actor {
    match headers.get("x-boite-thread").and_then(|v| v.to_str().ok()) {
        Some(id) if !id.is_empty() => Actor::Thread(id.to_string()),
        _ => Actor::System,
    }
}

/// Writes what just happened into the project's log.
///
/// A failed record is a gap in the history, never a failed action: an agent
/// told its work failed when it succeeded does the work twice.
fn record(inner: &Inner, entry: Entry) {
    if let Err(e) = inner.store.record(entry) {
        tracing::warn!("journal write failed: {e}");
    }
}

/// Hands a request to the connected devices, tagged so exactly one acts on it.
///
/// The server cannot carry any of these out: moving a thread means killing a
/// PTY and opening a worktree, and the client is what drives both. It also
/// cannot know which device is looking, so the request goes to all of them and
/// `agent.claimRequest` settles who takes it.
fn dispatch(inner: &Inner, mut request: serde_json::Value) -> Result<(), String> {
    if inner.devices.load(std::sync::atomic::Ordering::Relaxed) == 0 {
        return Err(NOBODY_TO_CARRY_IT_OUT.to_string());
    }
    request["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    let _ = inner.events.send(AppEvent::AgentRequest(request));
    Ok(())
}

/// What an agent is told when it asks for something no device is there to do.
///
/// It used to be told nothing: the send failed with no receiver, the error was
/// dropped on the floor and the handler answered success anyway. On a headless
/// boite with nobody connected — which is the deployment this crate exists for
/// — the agent read `moving to <project>`, carried on as if it had moved, and
/// no PTY had been touched.
pub const NOBODY_TO_CARRY_IT_OUT: &str =
    "no Boite device is connected, and the server cannot do this on its own: it means killing a      PTY and rearranging rows a client owns. Open Boite on a device and ask again.";

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
    if let Err(reason) = dispatch(
        &inner,
        json!({
            "kind": "thread.move",
            "threadId": thread_id,
            "projectId": project_id,
            "note": body.note,
        }),
    ) {
        record(
            &inner,
            Entry::new(&project_id, actor(&headers), Action::Denied)
                .about(&thread_id)
                .with("of", "thread.move")
                .with("reason", &reason),
        );
        return Ok(Json(json!({ "error": reason })));
    }
    record(
        &inner,
        Entry::new(&project_id, actor(&headers), Action::ThreadMoved)
            .about(&thread_id)
            .with("to", &name),
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
    // The log entry belongs to the project the caller is in: the one being
    // created has no history yet, and this is the thread that asked for it.
    let caller_project = authorize(&inner, &headers)?;
    let thread_id = thread_of_request(&inner, &headers)?;
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Ok(Json(json!({ "error": "a project needs a name" })));
    }
    // Answered here, while the agent is still running to read it. Dispatched,
    // the refusal happens on whichever device carries the request out and the
    // agent has already been told its project was on the way.
    if let Some(reason) = folder_refusal(&inner, &body) {
        return Ok(Json(json!({ "error": reason })));
    }
    if let Err(reason) = dispatch(
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
    ) {
        record(
            &inner,
            Entry::new(&caller_project, actor(&headers), Action::Denied)
                .about(&name)
                .with("of", "project.create")
                .with("reason", &reason),
        );
        return Ok(Json(json!({ "error": reason })));
    }
    record(
        &inner,
        Entry::new(&caller_project, actor(&headers), Action::ProjectCreated).about(&name),
    );
    Ok(Json(json!({ "name": name })))
}

/// What the RPC says when a folder sits outside every place a project may go.
/// One wording for both endpoints; see the constant's own comment for why.
pub use boite_core::project::WRONG_PLACE_FOR_A_PROJECT;

/// Why the folder an agent named cannot become a project, if it cannot.
///
/// The desktop twin of this endpoint answers the same two questions before it
/// emits anything, and this one used to answer neither: a path outside every
/// root, or one with somebody's files already in it, was dispatched and reported
/// as `{"name": ...}` all the same. That is the failure the desktop side was
/// fixed for, reached through the deployed server instead.
///
/// A caller who named neither a path nor a parent gets no refusal: the folder
/// then goes beside the user's other projects, which is inside the boundary by
/// construction.
fn folder_refusal(inner: &Inner, body: &CreateProjectIn) -> Option<String> {
    let spelled = |value: Option<&str>| -> Option<String> {
        value
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string())
    };
    let path = spelled(body.path.as_deref());
    let parent = spelled(body.parent.as_deref());
    if path.is_none() && parent.is_none() {
        return None;
    }

    let mut allowed = inner.roots.new_project_parents();
    if let Some(home) = dirs::home_dir() {
        allowed.push(home.to_string_lossy().to_string());
    }
    if let Some(workspace) = &inner.workspace_dir {
        allowed.push(workspace.to_string_lossy().to_string());
    }

    let Some(path) = path else {
        let parent = parent?;
        return (!project::may_create_project_in(&parent, &allowed))
            .then(|| WRONG_PLACE_FOR_A_PROJECT.to_string());
    };
    // A project already sitting there is reused, archived or not, and none of
    // the rules about empty folders apply to it.
    let known = inner
        .store
        .load_projects()
        .map(|projects| {
            projects
                .iter()
                .any(|p| project::same_folder(&p.cwd, &path))
        })
        .unwrap_or(false);
    if known {
        return None;
    }
    match project::folder_state_blocking(&path) {
        project::FolderState::Occupied if !body.adopt.unwrap_or(false) => Some(format!(
            "{path} already has files in it. Pass adopt to take it over, or pick another path."
        )),
        // Where it may go is only asked when there is a folder to make. One
        // already sitting there empty is taken as it is.
        project::FolderState::Missing => (!project::may_create_project_at(&path, &allowed))
            .then(|| WRONG_PLACE_FOR_A_PROJECT.to_string()),
        _ => None,
    }
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
        None => own_project.clone(),
    };
    if let Err(reason) = dispatch(
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
    ) {
        record(
            &inner,
            Entry::new(&own_project, actor(&headers), Action::Denied)
                .with("of", "thread.spawn")
                .with("reason", &reason),
        );
        return Ok(Json(json!({ "error": reason })));
    }
    record(
        &inner,
        Entry::new(&own_project, actor(&headers), Action::ThreadSpawned).with("into", &project_id),
    );
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct PaneOpenIn {
    kind: String,
    #[serde(default)]
    url: Option<String>,
    /// left, right, top or bottom. Defaults to right.
    #[serde(default)]
    side: Option<String>,
}

/// Shows the user something, beside the terminal the agent is talking in.
///
/// The MCP has advertised `pane_open` since it was written and this route did
/// not exist, so every call against a boite-server came back 404 and the agent
/// read an opaque failure for a verb the tool list told it it had. What it does
/// is the desktop handler's job, decided by the same shared rules: which pane
/// kinds exist, and what a browser pane may point at.
async fn pane_open(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<PaneOpenIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let kind = body.kind.trim().to_lowercase();
    if !browser::PANE_KINDS.contains(&kind.as_str()) {
        return Ok(Json(json!({
            "error": format!(
                "unknown pane kind '{}', expected one of {}",
                kind,
                browser::PANE_KINDS.join(", ")
            )
        })));
    }
    // Settled here rather than on the device: the agent is still running to
    // read a refusal, and a browser pane with no address is a blank frame
    // somebody has to close by hand.
    let (url, external) = match kind.as_str() {
        "browser" => {
            let raw = body.url.as_deref().map(str::trim).unwrap_or("");
            if raw.is_empty() {
                return Ok(Json(json!({ "error": "browser panes need a url" })));
            }
            match browser::classify(raw) {
                Ok(target) => (Some(target.url), target.external),
                Err(reason) => return Ok(Json(json!({ "error": reason }))),
            }
        }
        _ => (None, false),
    };
    if let Err(reason) = dispatch(
        &inner,
        json!({
            "kind": "pane.open",
            "projectId": project_id,
            "callerThreadId": thread_of_request(&inner, &headers).ok(),
            "pane": kind,
            "url": url,
            // Off this machine, so the device asks before framing it. It
            // classifies the address again on its side rather than trusting
            // this one.
            "external": external,
            "side": browser::side_or_right(body.side.as_deref()),
        }),
    ) {
        return Ok(Json(json!({ "error": reason })));
    }
    record(
        &inner,
        Entry::new(&project_id, actor(&headers), Action::PaneOpened)
            .about(&kind)
            .with("url", url.unwrap_or_default()),
    );
    Ok(Json(json!({ "ok": true })))
}

/// The worktree an agent is standing in, and what it could switch to.
///
/// Three `git` processes, off the async runtime. This ran inline and was the
/// one place in the crate that did: with a few agents asking at once — and
/// they ask on most turns — the threads carrying every client's own commands
/// end up inside `CreateProcess` instead. The desktop twin says the same thing
/// above its own `off_thread`, which is where this was missed when the handler
/// was retyped here.
async fn worktree_status(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (repo, worktree) = worktree_of_request(&inner, &headers)?;
    let (hold, branches, current) = {
        let (repo, worktree) = (repo.clone(), worktree.clone());
        tokio::task::spawn_blocking(move || {
            let hold = boite_core::git::worktree_hold_blocking(&worktree);
            let branches = boite_core::git::branches_blocking(&repo).unwrap_or_default();
            let current = boite_core::git::repo_info_blocking(&worktree)
                .ok()
                .and_then(|i| i.branch);
            (hold, branches, current)
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
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

async fn worktree_branch(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<BranchIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let (_, worktree) = worktree_of_request(&inner, &headers)?;
    match boite_core::git::claim_worktree_branch_blocking(&worktree, &body.name) {
        Ok(()) => {
            record(
                &inner,
                Entry::new(&project_id, actor(&headers), Action::WorktreeBranchClaimed)
                    .about(&body.name)
                    .with("worktree", &worktree),
            );
            let _ = inner.events.send(AppEvent::TodosChanged);
            Ok(Json(json!({ "branch": body.name })))
        }
        Err(e) => {
            record(
                &inner,
                Entry::new(&project_id, actor(&headers), Action::Denied)
                    .about(&body.name)
                    .with("of", "worktree_branch")
                    .with("reason", &e),
            );
            Ok(Json(json!({ "error": e })))
        }
    }
}

async fn worktree_reserve(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<BranchIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let (_, worktree) = worktree_of_request(&inner, &headers)?;
    match boite_core::git::reserve_worktree_branch_blocking(&worktree, &body.name) {
        Ok(()) => {
            record(
                &inner,
                Entry::new(&project_id, actor(&headers), Action::WorktreeReserved)
                    .about(&body.name)
                    .with("worktree", &worktree),
            );
            let _ = inner.events.send(AppEvent::TodosChanged);
            Ok(Json(json!({ "branch": body.name })))
        }
        Err(e) => {
            record(
                &inner,
                Entry::new(&project_id, actor(&headers), Action::Denied)
                    .about(&body.name)
                    .with("of", "worktree_reserve")
                    .with("reason", &e),
            );
            Ok(Json(json!({ "error": e })))
        }
    }
}

/// What this project shares with its worktrees, and whether anyone said so.
async fn artifacts_status(
    State(inner): State<Arc<Inner>>,
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
    State(inner): State<Arc<Inner>>,
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
    record(
        &inner,
        Entry::new(&project_id, actor(&headers), Action::TodoAdded)
            .about(&id)
            .with("title", title),
    );
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
        // agent does not get to learn which. The log keeps both, because "who
        // tried to claim what and was turned away" is the question a stuck
        // multi-agent run actually asks.
        record(
            &inner,
            Entry::new(&project_id, actor(&headers), Action::Denied)
                .about(&body.id)
                .with("of", "todo.claim")
                .with("reason", "not open, or not this project"),
        );
        return Err(StatusCode::CONFLICT);
    }
    let mut entry = Entry::new(&project_id, actor(&headers), Action::TodoClaimed).about(&body.id);
    if let Some(commit) = body.commit.as_deref() {
        entry = entry.with("commit", commit);
    }
    record(&inner, entry);
    let _ = inner.events.send(AppEvent::TodosChanged);
    Ok(Json(json!({ "ok": true })))
}

/// Binds an ephemeral loopback port and returns what the PTY spawn path stamps
/// into each child. Returns None if the listener cannot start: the workspace
/// still works, agents just have no todo access.
pub async fn start(
    store: Arc<Store>,
    events: broadcast::Sender<AppEvent>,
    roots: Arc<ProjectRoots>,
    workspace_dir: Option<PathBuf>,
    devices: Arc<std::sync::atomic::AtomicUsize>,
    data_dir: PathBuf,
) -> Option<AgentApi> {
    let token = format!("{:032x}", rand::random::<u128>());
    let token_path = data_dir.join("agent-token");
    if let Err(e) = boite_core::secret_file::write(&token_path, &token) {
        tracing::warn!("agent api disabled, cannot write the token file: {e}");
        return None;
    }
    let inner = Arc::new(Inner {
        store,
        events,
        devices,
        token: token.clone(),
        roots,
        workspace_dir,
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
        token_path,
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
