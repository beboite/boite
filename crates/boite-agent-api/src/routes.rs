//! The ten routes, once.
//!
//! Read this next to `crate::Workspace`: everything here is the same on both
//! hosts by construction, and the three things that are not — where a request
//! goes, who is told about a change, and what the host shows about an active
//! agent — are trait calls.
//!
//! Refusals an agent can act on come back `200` carrying an `error`, not a
//! status code. An agent reads a sentence; a 409 with an empty body is a wall.
//! Status codes are kept for the caller being wrong about itself: no token, no
//! thread, a thread this workspace does not have.

use std::path::Path;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use boite_core::git;
use boite_core::journal::{Action, Actor, Entry};
use boite_core::project;

use crate::auth::{
    agent_of_request, authorize, thread_header, thread_of_request, worktree_of_request,
};
use crate::{Change, Shared, Workspace, WRONG_PLACE_FOR_A_PROJECT};

#[cfg(test)]
mod tests;

/// Every route an agent has. Bound by each host to its own listener: the two
/// differ in how they take a port and what they write beside it, and in nothing
/// else.
pub fn router(workspace: Shared) -> Router {
    Router::new()
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
        .route("/v1/snapshot", get(snapshot))
        .with_state(workspace)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The actor behind a request, for the log.
///
/// A thread id is not an identity yet, it is an address the caller presents. It
/// is what the log can honestly say today, and the one place that changes when
/// threads carry a key.
fn actor(headers: &HeaderMap) -> Actor {
    match thread_header(headers) {
        "" => Actor::System,
        id => Actor::Thread(id.to_string()),
    }
}

/// Writes what just happened into the project's log.
///
/// A failed record is a gap in the history, never a failed action: an agent told
/// its work failed when it succeeded does the work twice.
fn record(workspace: &dyn Workspace, entry: Entry) {
    if let Err(e) = workspace.store().record(entry) {
        eprintln!("[boite/agent-api] journal write failed: {e}");
    }
}

/// A refusal the agent is meant to read and act on.
fn refused(reason: impl Into<String>) -> Json<Value> {
    Json(json!({ "error": reason.into() }))
}

/// Says no, and says so in the log too.
///
/// Both halves of one thought: the agent learns why, and "who tried what and
/// was turned away" stays answerable afterwards, which is the question a stuck
/// multi-agent run actually asks.
fn deny(
    workspace: &dyn Workspace,
    headers: &HeaderMap,
    project_id: &str,
    of: &str,
    about: &str,
    reason: &str,
) -> Json<Value> {
    let mut entry = Entry::new(project_id, actor(headers), Action::Denied)
        .with("of", of)
        .with("reason", reason);
    if !about.is_empty() {
        entry = entry.about(about);
    }
    record(workspace, entry);
    refused(reason)
}

// ---------------------------------------------------------------- todos

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

async fn list(
    State(workspace): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    let project_id = authorize(&*workspace, &headers)?;
    let todos = workspace
        .store()
        .todos_for_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({ "todos": todos })))
}

async fn add(
    State(workspace): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<AddIn>,
) -> Result<Json<Value>, StatusCode> {
    let project_id = authorize(&*workspace, &headers)?;
    let title = body.title.trim();
    if title.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    // An empty body and no body are the same thing, and only one of them should
    // reach the column: the panel marks every row that has a description, and
    // `Some("")` would mark a card with nothing in it.
    let description = body
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty());
    let id = workspace
        .store()
        .add_todo(&project_id, title, description, now_ms())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    record(
        &*workspace,
        Entry::new(&project_id, actor(&headers), Action::TodoAdded)
            .about(&id)
            .with("title", title),
    );
    workspace.announce(Change::Todos);
    workspace.touched(thread_header(&headers), "todo");
    Ok(Json(json!({ "id": id })))
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

async fn claim(
    State(workspace): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<ClaimIn>,
) -> Result<Json<Value>, StatusCode> {
    let project_id = authorize(&*workspace, &headers)?;
    // The thread names the agent: Boite spawned it, so it knows what it is.
    let agent = agent_of_request(&*workspace, &headers);
    let changed = workspace
        .store()
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
        let _ = deny(
            &*workspace,
            &headers,
            &project_id,
            "todo.claim",
            &body.id,
            "not open, or not this project",
        );
        return Err(StatusCode::CONFLICT);
    }
    let mut entry = Entry::new(&project_id, actor(&headers), Action::TodoClaimed).about(&body.id);
    if let Some(commit) = body.commit.as_deref() {
        entry = entry.with("commit", commit);
    }
    record(&*workspace, entry);
    workspace.announce(Change::Todos);
    workspace.touched(thread_header(&headers), "todo");
    Ok(Json(json!({ "ok": true })))
}

/// Everything at once, for an agent asked to work out why something is wrong.
///
/// Not scoped to the caller's project, and that is deliberate: the question this
/// answers is "what is this workspace doing", and a thread in another project
/// holding a dead PTY is exactly the kind of thing the caller needs to see. It
/// carries no secret — no token, no environment, no file contents — so it is
/// meant to be pasted into an issue.
async fn snapshot(
    State(workspace): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    authorize(&*workspace, &headers)?;
    let live = workspace.live_ptys();
    let taken = blocking({
        let workspace = workspace.clone();
        move || {
            serde_json::to_value(boite_core::snapshot::take(
                "workspace",
                workspace.store(),
                workspace.roots(),
                live,
            ))
        }
    })
    .await?;
    taken.map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// ------------------------------------------------------------ worktrees

/// The worktree an agent is standing in, and what it could switch to.
///
/// Three `git` processes, off the async runtime. This ran inline on the server
/// and was the one place in that crate that did: with a few agents asking at
/// once — and they ask on most turns — the threads carrying every client's own
/// commands end up inside `CreateProcess` instead.
async fn worktree_status(
    State(workspace): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    let (repo, worktree) = worktree_of_request(&*workspace, &headers)?;
    let read = {
        let (repo, worktree) = (repo.clone(), worktree.clone());
        blocking(move || {
            let hold = git::worktree_hold_blocking(&worktree);
            let branches = git::branches_blocking(&repo).unwrap_or_default();
            let current = git::repo_info_blocking(&worktree).ok().and_then(|i| i.branch);
            (hold, branches, current)
        })
        .await?
    };
    let (hold, branches, current) = read;
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
    State(workspace): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<BranchIn>,
) -> Result<Json<Value>, StatusCode> {
    claim_a_branch(workspace, headers, body, Held::Claimed).await
}

async fn worktree_reserve(
    State(workspace): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<BranchIn>,
) -> Result<Json<Value>, StatusCode> {
    claim_a_branch(workspace, headers, body, Held::Reserved).await
}

/// Claiming and reserving differ in one git call and one log verb.
///
/// They were two handlers, four times over across the two hosts, and the pair
/// on the server had already picked up a different event from the pair on the
/// desktop.
#[derive(Clone, Copy)]
enum Held {
    /// The branch this worktree is on now.
    Claimed,
    /// A name taken so nothing else takes it, without switching to it.
    Reserved,
}

async fn claim_a_branch(
    workspace: Shared,
    headers: HeaderMap,
    body: BranchIn,
    held: Held,
) -> Result<Json<Value>, StatusCode> {
    let project_id = authorize(&*workspace, &headers)?;
    let (_, worktree) = worktree_of_request(&*workspace, &headers)?;
    let name = body.name.clone();
    let done = {
        let (worktree, name) = (worktree.clone(), name.clone());
        blocking(move || match held {
            Held::Claimed => git::claim_worktree_branch_blocking(&worktree, &name),
            Held::Reserved => git::reserve_worktree_branch_blocking(&worktree, &name),
        })
        .await?
    };
    let of = match held {
        Held::Claimed => "worktree_branch",
        Held::Reserved => "worktree_reserve",
    };
    match done {
        Ok(()) => {
            record(
                &*workspace,
                Entry::new(
                    &project_id,
                    actor(&headers),
                    match held {
                        Held::Claimed => Action::WorktreeBranchClaimed,
                        Held::Reserved => Action::WorktreeReserved,
                    },
                )
                .about(&name)
                .with("worktree", &worktree),
            );
            workspace.announce(Change::Worktrees);
            workspace.touched(thread_header(&headers), "worktree");
            Ok(Json(json!({ "branch": name })))
        }
        Err(e) => Ok(deny(&*workspace, &headers, &project_id, of, &name, &e)),
    }
}

/// What this project shares with its worktrees, and whether anyone said so.
async fn artifacts_status(
    State(workspace): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    let (repo, _) = worktree_of_request(&*workspace, &headers)?;
    let policy = blocking(move || {
        let policy = git::effective_artifact_policy(Path::new(&repo));
        (repo, policy)
    })
    .await?;
    let (repo, policy) = policy;
    Ok(Json(json!({
        "repo": repo,
        "file": git::POLICY_FILE,
        "declared": policy.declared,
        "shared": policy.shared,
    })))
}

/// Replaces the policy with the one given. Refusals arrive as a 200 carrying an
/// `error`: a directory name the policy may not hold is the agent's to fix, and
/// it needs to read which one.
async fn artifacts_set(
    State(workspace): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<git::ArtifactPolicy>,
) -> Result<Json<Value>, StatusCode> {
    let (repo, _) = worktree_of_request(&*workspace, &headers)?;
    let shared = body.shared.clone();
    let written = blocking(move || git::write_artifact_policy(Path::new(&repo), &body)).await?;
    Ok(match written {
        Ok(()) => Json(json!({ "file": git::POLICY_FILE, "shared": shared })),
        Err(e) => refused(e),
    })
}

// ------------------------------------------------------------- projects

/// Every project in the workspace, archived ones marked rather than hidden: a
/// project the user put away is still the right place to go back to, and leaving
/// it off the list is how an agent ends up creating a second one on top of the
/// first.
async fn projects(
    State(workspace): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    let current = authorize(&*workspace, &headers)?;
    let projects = workspace
        .store()
        .load_projects()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows: Vec<Value> = projects
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

/// Which project the caller means, from an id, a name or a path.
///
/// A name that matches two projects is refused rather than guessed: picking one
/// would move a conversation into the wrong repository, and the folder it then
/// works in is not something an undo covers.
fn resolve_project(workspace: &dyn Workspace, needle: &str) -> Result<(String, String), String> {
    let needle = needle.trim();
    if needle.is_empty() {
        return Err("name the project to move into".into());
    }
    let projects = workspace.store().load_projects().map_err(|e| e.to_string())?;
    if let Some(p) = projects.iter().find(|p| p.id == needle) {
        return Ok((p.id.clone(), p.name.clone()));
    }
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let target = norm(needle);
    if let Some(p) = projects.iter().find(|p| norm(&p.cwd) == target) {
        return Ok((p.id.clone(), p.name.clone()));
    }
    let by_name: Vec<_> = projects
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

#[derive(Deserialize)]
struct MoveIn {
    project: String,
    note: Option<String>,
}

/// Moves the calling thread into another project.
///
/// Answered as soon as the request is understood, not when it is done: this call
/// kills the process that made it. A thread cannot change project while its PTY
/// is alive, so the reply is written, the terminal goes down, and the agent comes
/// back up in the new folder with its conversation resumed. What the endpoint
/// does own is the refusal — an unknown or ambiguous project is settled here,
/// while the agent is still running to read it.
async fn thread_move(
    State(workspace): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<MoveIn>,
) -> Result<Json<Value>, StatusCode> {
    let thread_id = thread_of_request(&*workspace, &headers)?;
    let (project_id, name) = match resolve_project(&*workspace, &body.project) {
        Ok(found) => found,
        Err(reason) => return Ok(refused(reason)),
    };
    if let Err(reason) = workspace.ask(json!({
        "kind": "thread.move",
        "threadId": thread_id,
        "projectId": project_id,
        "note": body.note,
    })) {
        return Ok(deny(
            &*workspace,
            &headers,
            &project_id,
            "thread.move",
            &thread_id,
            &reason,
        ));
    }
    record(
        &*workspace,
        Entry::new(&project_id, actor(&headers), Action::ThreadMoved)
            .about(&thread_id)
            .with("to", &name),
    );
    workspace.touched(&thread_id, "thread");
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
/// and by default this terminal moved into it. Same fire-and-forget shape as the
/// move, for the same reason.
async fn project_create(
    State(workspace): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<CreateProjectIn>,
) -> Result<Json<Value>, StatusCode> {
    // The log entry belongs to the project the caller is in: the one being
    // created has no history yet, and this is the thread that asked for it.
    let caller_project = authorize(&*workspace, &headers)?;
    let thread_id = thread_header(&headers).to_string();
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Ok(refused("a project needs a name"));
    }
    // Answered here, while the agent is still running to read it. Dispatched,
    // the refusal happens on whichever device carries the request out and the
    // agent has already been told its project was on the way.
    if let Some(reason) = folder_refusal(&*workspace, &body) {
        return Ok(refused(reason));
    }
    if let Err(reason) = workspace.ask(json!({
        "kind": "project.create",
        "threadId": (!thread_id.is_empty()).then(|| thread_id.clone()),
        "name": name,
        "path": body.path,
        "parent": body.parent,
        "adopt": body.adopt.unwrap_or(false),
        "git": body.git.unwrap_or(true),
        // Nothing to move when the caller is not a thread this workspace knows.
        "move": body.r#move.unwrap_or(true) && !thread_id.is_empty(),
        "note": body.note,
    })) {
        return Ok(deny(
            &*workspace,
            &headers,
            &caller_project,
            "project.create",
            &name,
            &reason,
        ));
    }
    record(
        &*workspace,
        Entry::new(&caller_project, actor(&headers), Action::ProjectCreated).about(&name),
    );
    workspace.touched(&thread_id, "project");
    Ok(Json(json!({ "name": name })))
}

/// Why the folder an agent named cannot become a project, if it cannot.
///
/// A caller who named neither a path nor a parent gets no refusal: the folder
/// then goes beside the user's other projects, which is inside the boundary by
/// construction.
fn folder_refusal(workspace: &dyn Workspace, body: &CreateProjectIn) -> Option<String> {
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

    let mut allowed = workspace.roots().new_project_parents();
    allowed.extend(workspace.extra_project_parents());

    let Some(path) = path else {
        let parent = parent?;
        return (!project::may_create_project_in(&parent, &allowed))
            .then(|| WRONG_PLACE_FOR_A_PROJECT.to_string());
    };
    // A project already sitting there is reused, archived or not, and none of
    // the rules about empty folders apply to it.
    let known = workspace
        .store()
        .load_projects()
        .map(|projects| projects.iter().any(|p| project::same_folder(&p.cwd, &path)))
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

// -------------------------------------------------------------- threads

#[derive(Deserialize)]
struct SpawnIn {
    agent: Option<String>,
    project: Option<String>,
    prompt: Option<String>,
}

/// Opens a second agent terminal.
///
/// The caller survives this one, so the answer is real: the request was
/// understood and a terminal is being opened. The new thread's id is not in it —
/// that is minted by the side that spawns it, and an agent has nothing to do
/// with one.
async fn thread_spawn(
    State(workspace): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<SpawnIn>,
) -> Result<Json<Value>, StatusCode> {
    let own_project = authorize(&*workspace, &headers)?;
    let project_id = match &body.project {
        Some(needle) => match resolve_project(&*workspace, needle) {
            Ok((id, _)) => id,
            Err(reason) => return Ok(refused(reason)),
        },
        None => own_project.clone(),
    };
    let caller = thread_header(&headers).to_string();
    if let Err(reason) = workspace.ask(json!({
        "kind": "thread.spawn",
        "projectId": project_id,
        // Who asked, so an unnamed agent defaults to another of the caller
        // rather than to whatever terminal the user happens to be looking at.
        "callerThreadId": (!caller.is_empty()).then(|| caller.clone()),
        "agent": body.agent,
        "prompt": body.prompt,
    })) {
        return Ok(deny(
            &*workspace,
            &headers,
            &own_project,
            "thread.spawn",
            "",
            &reason,
        ));
    }
    record(
        &*workspace,
        Entry::new(&own_project, actor(&headers), Action::ThreadSpawned).with("into", &project_id),
    );
    workspace.touched(&caller, "thread");
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
/// Deliberately the one route that does not pulse the thread's activity dot:
/// opening a pane is the agent showing something, not the agent working, and a
/// dot that lights up for it says the wrong thing.
async fn pane_open(
    State(workspace): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<PaneOpenIn>,
) -> Result<Json<Value>, StatusCode> {
    use boite_core::browser;

    let project_id = authorize(&*workspace, &headers)?;
    let kind = body.kind.trim().to_lowercase();
    if !browser::PANE_KINDS.contains(&kind.as_str()) {
        return Ok(refused(format!(
            "unknown pane kind '{}', expected one of {}",
            kind,
            browser::PANE_KINDS.join(", ")
        )));
    }
    // Settled here rather than on the device: the agent is still running to read
    // a refusal, and a browser pane with no address is a blank frame somebody
    // has to close by hand.
    let (url, external) = match kind.as_str() {
        "browser" => {
            let raw = body.url.as_deref().map(str::trim).unwrap_or("");
            if raw.is_empty() {
                return Ok(refused("browser panes need a url"));
            }
            match browser::classify(raw) {
                Ok(target) => (Some(target.url), target.external),
                Err(reason) => return Ok(refused(reason)),
            }
        }
        _ => (None, false),
    };
    let caller = thread_header(&headers).to_string();
    if let Err(reason) = workspace.ask(json!({
        "kind": "pane.open",
        "projectId": project_id,
        "callerThreadId": (!caller.is_empty()).then(|| caller.clone()),
        "pane": kind,
        "url": url,
        // Off this machine, so the device asks before framing it. It classifies
        // the address again on its side rather than trusting this one.
        "external": external,
        "side": browser::side_or_right(body.side.as_deref()),
    })) {
        return Ok(refused(reason));
    }
    record(
        &*workspace,
        Entry::new(&project_id, actor(&headers), Action::PaneOpened)
            .about(&kind)
            .with("url", url.unwrap_or_default()),
    );
    Ok(Json(json!({ "ok": true })))
}

/// Runs something that spawns processes or touches the disk, off the runtime.
///
/// Both hosts already run on a tokio runtime, so this is the same function
/// through either door. It exists because these handlers spawn `git`, and three
/// processes inline is a runtime worker parked inside `CreateProcess` while every
/// other client's command waits behind it.
async fn blocking<F, T>(f: F) -> Result<T, StatusCode>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
