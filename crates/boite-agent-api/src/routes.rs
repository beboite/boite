//! The ten routes, once.
//!
//! Read this next to `crate::Workspace`: everything here is the same on both
//! hosts by construction, and the three things that are not — where a request
//! goes, who is told about a change, and what the host shows about an active
//! agent — are trait calls.
//!
//! Refusals an agent can act on come back `200` carrying an `error`, not a
//! status code. An agent reads a sentence; a 409 with an empty body is a wall.
//! Status codes are kept for the caller being wrong about itself: no
//! credential, no terminal, a thread this workspace does not have.
//!
//! No handler here checks who is calling. `crate::auth::identify` runs before
//! the router picks one and attaches a [`Caller`] that could not have been built
//! without proof, so the question a handler asks is what this caller may do, not
//! whether it is real.

use std::path::Path;
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use boite_core::capability::Capability;
use boite_core::git;
use boite_core::journal::{Action, Actor, Entry};
use boite_core::project;

use crate::auth::Caller;
use crate::{Change, Shared, Workspace, WRONG_PLACE_FOR_A_PROJECT};

#[cfg(test)]
mod tests;

/// The verb-and-route pairs themselves, with no identity attached yet.
///
/// Split out of [`router`] because the `/mcp` endpoint dispatches into these
/// same handlers in-process: its caller proved itself once at `/mcp`, and
/// running the proof again on a request this process wrote to itself would
/// need a signature nobody holds the key for.
fn verbs() -> Router<Shared> {
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
        .route("/v1/thread/wait", get(thread_wait))
        .route("/v1/whereami", get(whereami))
        .route("/v1/finish", get(finish))
        .route("/v1/pane/open", post(pane_open))
        .route("/v1/browser", get(browser_status))
        .route("/v1/browser/wait", get(browser_wait))
        .route("/v1/browser/navigate", post(browser_navigate))
        .route("/v1/browser/reload", post(browser_reload))
        .route("/v1/browser/close", post(browser_close))
        .route("/v1/browser/snapshot", get(browser_snapshot))
        .route("/v1/browser/screenshot", get(browser_screenshot))
        .route("/v1/browser/click", post(browser_click))
        .route("/v1/browser/type", post(browser_type))
        .route("/v1/browser/press", post(browser_press))
        .route("/v1/browser/scroll", post(browser_scroll))
        .route("/v1/snapshot", get(snapshot))
        .route("/v1/transcript", get(transcript))
        .route("/v1/search", get(search))
        .route("/v1/timeline", get(timeline))
}

/// Every route an agent has. Bound by each host to its own listener: the two
/// differ in how they take a port and what they write beside it, and in nothing
/// else.
///
/// The identity check is a layer rather than a line in each handler: eleven
/// handlers each beginning with the same call is eleven chances for the twelfth
/// to be written without it. `/mcp` sits under the same layer: it is the same
/// door for a caller that speaks MCP over HTTP instead of running the stdio
/// shim.
pub fn router(workspace: Shared) -> Router {
    verbs()
        .route("/mcp", post(crate::mcp::endpoint))
        .layer(axum::middleware::from_fn_with_state(
            workspace.clone(),
            crate::auth::identify,
        ))
        .with_state(workspace)
}

/// The same handlers with the caller already settled, for in-process dispatch.
pub(crate) fn open(workspace: Shared) -> Router {
    verbs().with_state(workspace)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// How long a device has to claim and answer a request the agent will read.
const SETTLE_MS: u64 = 8_000;

/// Dispatch and wait for the device, so an unclaimed request is not success.
async fn settle(workspace: &dyn Workspace, request: Value) -> Result<Value, String> {
    let rx = workspace.ask_settled(request)?;
    match tokio::time::timeout(Duration::from_millis(SETTLE_MS), rx).await {
        Ok(Ok(v)) => {
            if let Some(err) = v
                .get("error")
                .and_then(|e| e.as_str())
                .filter(|s| !s.is_empty())
            {
                Err(err.to_string())
            } else {
                Ok(v)
            }
        }
        Ok(Err(_)) => Err("the device dropped the request before answering".into()),
        Err(_) => Err(
            "no Boite device carried this out in time. Open Boite and ask again.".into(),
        ),
    }
}

/// The actor behind a request, for the log.
///
/// A thread here is a thread that proved itself with its own key, so the log
/// can name it rather than repeat what a caller claimed. A credentials file has
/// no terminal behind it and is recorded as the system acting on its behalf,
/// which is what it is.
fn actor(caller: &Caller) -> Actor {
    match caller.thread_id.as_deref() {
        Some(id) if !id.is_empty() => Actor::Thread(id.to_string()),
        _ => Actor::System,
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
    caller: &Caller,
    project_id: &str,
    of: &str,
    about: &str,
    reason: &str,
) -> Json<Value> {
    let mut entry = Entry::new(project_id, actor(caller), Action::Denied)
        .with("of", of)
        .with("reason", reason);
    if !about.is_empty() {
        entry = entry.about(about);
    }
    record(workspace, entry);
    refused(reason)
}

/// Refuses a call this credential may not make, and says so in the log.
///
/// Every route that reaches past the caller's own project goes through it. The
/// answer is a `200` carrying an `error` and a `retryable: false`, because the
/// agent is meant to read it and stop rather than try again with the same
/// credential: nothing about it will be different next time.
fn permitted(
    workspace: &dyn Workspace,
    caller: &Caller,
    capability: Capability,
    of: &str,
    about: &str,
) -> Result<(), Json<Value>> {
    let Err(reason) = caller.ensure(capability) else {
        return Ok(());
    };
    let Json(mut body) = deny(workspace, caller, &caller.project_id, of, about, &reason);
    // Nothing about asking again changes the answer: the grant is a property of
    // the credential, not of the moment. Taken from Buzz, which is right that a
    // refusal an agent cannot tell apart from a hiccup is a refusal it retries.
    body["retryable"] = json!(false);
    Err(Json(body))
}

/// Puts a dispatch in front of the user instead of carrying it out, and answers
/// the agent.
///
/// The three calls that reach past the project an agent is in go through here.
/// A credential with no terminal never gets this far — `permitted` refused it
/// already — so what is left is the agent in a terminal the user opened, and the
/// question is not whether it may ask but whether the user agrees.
///
/// The agent does not wait for the answer. It is told the request is with the
/// user and told not to retry, which is `retryable: false` in the body: a tool
/// call that blocks on a human is a turn that stalls until somebody looks at the
/// window, and an agent that gets no answer retries.
///
/// The answer carries no `error`. It used to, and every client on the far side
/// reads that field as "the call failed": agents said sorry for a call that had
/// worked and went hunting for a way round the gate. What it carries instead is
/// a `status`, which is `awaiting-user` here and `auto-allowed` under yolo.
fn ask_the_user(
    workspace: &dyn Workspace,
    caller: &Caller,
    action: &str,
    detail: &str,
    request: Value,
) -> Json<Value> {
    let pending = boite_core::approval::Pending {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: caller.project_id.clone(),
        thread_id: caller.thread_or_empty().to_string(),
        action: action.to_string(),
        detail: detail.to_string(),
        created_at: now_ms(),
    };
    if let Err(e) = workspace.store().open_approval(&pending, &request) {
        // A request that cannot be recorded is not carried out either. Falling
        // through to the dispatch would mean the gate is off whenever the
        // database is unhappy, which is exactly when it should not be.
        return refused(format!("cannot ask the user right now: {e}"));
    }
    record(
        workspace,
        Entry::new(&caller.project_id, actor(caller), Action::ApprovalOpened)
            .about(&pending.id)
            .with("of", action)
            .with("detail", detail),
    );
    if yolo(workspace) {
        // Opened and journalled first, then answered: yolo leaves the same trail
        // as a card somebody clicked, so the timeline still shows what was asked
        // for and who said yes. Going straight to the dispatch would make the
        // one mode with nothing holding it back the one mode with no record.
        return match crate::decide(
            workspace,
            &pending.id,
            boite_core::approval::Verdict::Allowed,
            now_ms(),
        ) {
            Ok(_) => Json(json!({
                "ok": true,
                "status": boite_core::approval::AUTO_ALLOWED,
                "note": boite_core::approval::answered_by_yolo(action),
            })),
            // The row is open and the user will see it. Answering the agent as
            // if it had run would be the one lie this whole file exists to
            // avoid, so it falls back to what happens without yolo.
            Err(_) => {
                workspace.announce(Change::Approvals);
                awaiting(action, &pending.id)
            }
        };
    }
    workspace.announce(Change::Approvals);
    awaiting(action, &pending.id)
}

/// The body for a call that is now the user's to answer.
fn awaiting(action: &str, approval_id: &str) -> Json<Value> {
    Json(json!({
        "status": boite_core::approval::AWAITING,
        "pending": true,
        "retryable": false,
        "approvalId": approval_id,
        "note": boite_core::approval::waiting_on_a_human(action),
    }))
}

/// Whether this workspace answers for the user on the calls that would wait.
///
/// Read out of the settings blob the window writes, on every call rather than
/// held in memory: the toggle exists to be turned off in the middle of a
/// session, and a cached copy would keep saying yes after it was.
///
/// Unreadable settings mean no. A workspace that cannot say whether the user
/// asked for yolo has not asked for it.
fn yolo(workspace: &dyn Workspace) -> bool {
    workspace
        .store()
        .load_settings()
        .ok()
        .and_then(|s| s.get("mcpYolo").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// The repository and worktree behind this caller's thread.
///
/// CONFLICT when the thread runs in the project folder: it exists, it simply
/// has no worktree, and the agent should be told that rather than given a
/// not-found.
fn worktree_of(
    workspace: &dyn Workspace,
    caller: &Caller,
) -> Result<(String, String), StatusCode> {
    workspace
        .store()
        .worktree_of_thread(caller.thread()?)
        .ok_or(StatusCode::CONFLICT)
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
    Extension(caller): Extension<Caller>,
) -> Result<Json<Value>, StatusCode> {
    let project_id = caller.project_id.clone();
    let todos = workspace
        .store()
        .todos_for_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({ "todos": todos })))
}

async fn add(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<AddIn>,
) -> Result<Json<Value>, StatusCode> {
    let project_id = caller.project_id.clone();
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
        Entry::new(&project_id, actor(&caller), Action::TodoAdded)
            .about(&id)
            .with("title", title),
    );
    workspace.announce(Change::Todos);
    workspace.touched(caller.thread_or_empty(), "todo");
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
    Extension(caller): Extension<Caller>,
    Json(body): Json<ClaimIn>,
) -> Result<Json<Value>, StatusCode> {
    let project_id = caller.project_id.clone();
    // The thread names the agent: Boite spawned it, so it knows what it is.
    let agent = caller.agent.clone();
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
            &caller,
            &project_id,
            "todo.claim",
            &body.id,
            "not open, or not this project",
        );
        return Err(StatusCode::CONFLICT);
    }
    let mut entry = Entry::new(&project_id, actor(&caller), Action::TodoClaimed).about(&body.id);
    if let Some(commit) = body.commit.as_deref() {
        entry = entry.with("commit", commit);
    }
    record(&*workspace, entry);
    workspace.announce(Change::Todos);
    workspace.touched(caller.thread_or_empty(), "todo");
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
    Extension(_caller): Extension<Caller>,
) -> Result<Json<Value>, StatusCode> {
    let live = workspace.live_ptys();
    // Read here rather than inside the blocking closure: it is a lock on this
    // process's own state, and the point of that closure is the database.
    let screen = workspace.on_screen();
    let taken = blocking({
        let workspace = workspace.clone();
        move || {
            serde_json::to_value(boite_core::snapshot::take(
                "workspace",
                workspace.store(),
                workspace.roots(),
                live,
                screen,
            ))
        }
    })
    .await?;
    taken.map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize)]
struct TranscriptIn {
    /// Which terminal. Any thread in the workspace, not only the caller's.
    #[serde(rename = "threadId")]
    thread_id: Option<String>,
    bytes: Option<u32>,
}

/// What a terminal printed, read back from the end.
///
/// Not scoped to the caller's own thread, and that is the point: an agent asked
/// why another one stopped had nothing to read, because a PTY's output died
/// with the process. It carries no credential — the key files are not in the
/// workspace and a transcript is what was on somebody's screen — and it is the
/// single most useful thing an agent can be handed when something is wrong.
///
/// Defaults to the caller's own terminal, which is the other half of it: an
/// agent that lost track of what it printed can re-read itself.
async fn transcript(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    axum::extract::Query(query): axum::extract::Query<TranscriptIn>,
) -> Result<Json<Value>, StatusCode> {
    let Some(dir) = workspace.transcripts_dir() else {
        return Ok(refused(
            "this Boite keeps no transcripts, so there is nothing to read back",
        ));
    };
    let thread_id = match query.thread_id.filter(|id| !id.is_empty()) {
        Some(id) => id,
        None => caller.thread()?.to_string(),
    };
    // A terminal prints more in a minute than anybody reads, and this answer
    // goes into a context window.
    let bytes = query.bytes.unwrap_or(16_384).min(1024 * 1024) as usize;
    let read = blocking(move || boite_core::transcript::tail(&dir, &thread_id, bytes)).await?;
    Ok(match read {
        Ok(text) => Json(json!({ "text": text })),
        Err(reason) => refused(reason),
    })
}

#[derive(Deserialize)]
struct SearchIn {
    q: Option<String>,
    limit: Option<u32>,
}

/// Anything in this workspace with that text in it.
///
/// Three sources and one answer: todos, the project's log, and what the
/// terminals printed. An agent looking for where an error came from should not
/// have to know which of the three it is in, and until this existed the answer
/// was "none of them, because nothing was written down".
async fn search(
    State(workspace): State<Shared>,
    Extension(_caller): Extension<Caller>,
    axum::extract::Query(query): axum::extract::Query<SearchIn>,
) -> Result<Json<Value>, StatusCode> {
    let needle = query.q.unwrap_or_default().trim().to_string();
    if needle.is_empty() {
        return Ok(refused("say what to look for"));
    }
    let limit = query.limit.unwrap_or(20).clamp(1, 100) as usize;
    let dir = workspace.transcripts_dir();
    let hits = blocking({
        let workspace = workspace.clone();
        move || {
            let mut hits = workspace.store().search(&needle, limit);
            if let Some(dir) = dir {
                // The rows first: a todo or a refusal is a shorter answer than
                // a line of terminal output, and a caller reading a list wants
                // the short ones at the top.
                hits.extend(boite_core::search::transcripts(
                    &dir,
                    &needle,
                    limit.saturating_sub(hits.len()),
                ));
            }
            hits
        }
    })
    .await?;
    Ok(Json(json!({ "hits": hits })))
}

#[derive(Deserialize)]
struct TimelineIn {
    /// Scoped to one project, or the whole workspace when absent.
    project: Option<String>,
    limit: Option<u32>,
}

/// What happened here, newest first.
///
/// `search` answers where something is; this answers when, and next to what.
/// Three sources on one clock, because each misses what the others have: an
/// agent's work is in the journal, a user ticking a box is only on the todo
/// row, and a terminal being opened is only on the thread.
async fn timeline(
    State(workspace): State<Shared>,
    Extension(_caller): Extension<Caller>,
    axum::extract::Query(query): axum::extract::Query<TimelineIn>,
) -> Result<Json<Value>, StatusCode> {
    let limit = query.limit.unwrap_or(40).clamp(1, 200) as usize;
    let project = query.project.filter(|p| !p.is_empty());
    let moments = blocking({
        let workspace = workspace.clone();
        move || workspace.store().timeline(project.as_deref(), limit)
    })
    .await?;
    Ok(Json(json!({ "moments": moments })))
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
    Extension(caller): Extension<Caller>,
) -> Result<Json<Value>, StatusCode> {
    let (repo, worktree) = worktree_of(&*workspace, &caller)?;
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
    Extension(caller): Extension<Caller>,
    Json(body): Json<BranchIn>,
) -> Result<Json<Value>, StatusCode> {
    claim_a_branch(workspace, caller, body, Held::Claimed).await
}

async fn worktree_reserve(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<BranchIn>,
) -> Result<Json<Value>, StatusCode> {
    claim_a_branch(workspace, caller, body, Held::Reserved).await
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
    caller: Caller,
    body: BranchIn,
    held: Held,
) -> Result<Json<Value>, StatusCode> {
    let project_id = caller.project_id.clone();
    let (_, worktree) = worktree_of(&*workspace, &caller)?;
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
                    actor(&caller),
                    match held {
                        Held::Claimed => Action::WorktreeBranchClaimed,
                        Held::Reserved => Action::WorktreeReserved,
                    },
                )
                .about(&name)
                .with("worktree", &worktree),
            );
            workspace.announce(Change::Worktrees);
            workspace.touched(caller.thread_or_empty(), "worktree");
            Ok(Json(json!({ "branch": name })))
        }
        Err(e) => Ok(deny(&*workspace, &caller, &project_id, of, &name, &e)),
    }
}

/// What this project shares with its worktrees, and whether anyone said so.
async fn artifacts_status(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
) -> Result<Json<Value>, StatusCode> {
    let (repo, _) = worktree_of(&*workspace, &caller)?;
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
    Extension(caller): Extension<Caller>,
    Json(body): Json<git::ArtifactPolicy>,
) -> Result<Json<Value>, StatusCode> {
    let (repo, _) = worktree_of(&*workspace, &caller)?;
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
    Extension(caller): Extension<Caller>,
) -> Result<Json<Value>, StatusCode> {
    let current = caller.project_id.clone();
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
    Extension(caller): Extension<Caller>,
    Json(body): Json<MoveIn>,
) -> Result<Json<Value>, StatusCode> {
    let thread_id = caller.thread()?.to_string();
    // The call this capability exists for. Changing files in a repository is
    // what an agent is there to do; deciding on its own to go and work in a
    // different one is not, and a credential Boite handed to a process it never
    // launched has no terminal for anyone to notice it happening in.
    if let Err(refusal) = permitted(
        &*workspace,
        &caller,
        Capability::MutateAcross,
        "thread.move",
        &thread_id,
    ) {
        return Ok(refusal);
    }
    let (project_id, name) = match resolve_project(&*workspace, &body.project) {
        Ok(found) => found,
        Err(reason) => return Ok(refused(reason)),
    };
    Ok(ask_the_user(
        &*workspace,
        &caller,
        "thread.move",
        &name,
        json!({
            "kind": "thread.move",
            "threadId": thread_id,
            "projectId": project_id,
            "note": body.note,
        }),
    ))
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
    Extension(caller): Extension<Caller>,
    Json(body): Json<CreateProjectIn>,
) -> Result<Json<Value>, StatusCode> {
    // The log entry belongs to the project the caller is in: the one being
    // created has no history yet, and this is the thread that asked for it.
    let caller_project = caller.project_id.clone();
    let thread_id = caller.thread_or_empty().to_string();
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Ok(refused("a project needs a name"));
    }
    // A new project is a new place for work to happen, and by default this
    // terminal moves into it. Both halves are across.
    if let Err(refusal) = permitted(
        &*workspace,
        &caller,
        Capability::MutateAcross,
        "project.create",
        &name,
    ) {
        return Ok(refusal);
    }
    // Answered here, while the agent is still running to read it. Dispatched,
    // the refusal happens on whichever device carries the request out and the
    // agent has already been told its project was on the way.
    if let Some(reason) = folder_refusal(&*workspace, &body) {
        return Ok(refused(reason));
    }
    let _ = caller_project;
    Ok(ask_the_user(
        &*workspace,
        &caller,
        "project.create",
        &name,
        json!({
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
        }),
    ))
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
/// The caller survives this one, so the answer is real and carries the new
/// thread id: the device mints it, and this waits for that rather than
/// answering success before anyone has a row to name.
async fn thread_spawn(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<SpawnIn>,
) -> Result<Json<Value>, StatusCode> {
    let own_project = caller.project_id.clone();
    let project_id = match &body.project {
        Some(needle) => match resolve_project(&*workspace, needle) {
            Ok((id, _)) => id,
            Err(reason) => return Ok(refused(reason)),
        },
        None => own_project.clone(),
    };
    let elsewhere = project_id != own_project;
    // Only when it lands somewhere else. Opening a second terminal beside your
    // own is what an agent splitting a job does, and asking for a wider grant
    // for it would make the capability mean "spawn", not "across".
    if elsewhere {
        if let Err(refusal) = permitted(
            &*workspace,
            &caller,
            Capability::MutateAcross,
            "thread.spawn",
            &project_id,
        ) {
            return Ok(refusal);
        }
    }
    let asking_thread = caller.thread_or_empty().to_string();
    let request = json!({
        "kind": "thread.spawn",
        "projectId": project_id,
        // Who asked, so an unnamed agent defaults to another of the caller
        // rather than to whatever terminal the user happens to be looking at.
        "callerThreadId": (!asking_thread.is_empty()).then(|| asking_thread.clone()),
        "agent": body.agent,
        "prompt": body.prompt,
    });
    if elsewhere {
        return Ok(ask_the_user(
            &*workspace,
            &caller,
            "thread.spawn",
            &project_id,
            request,
        ));
    }
    let out = match settle(&*workspace, request).await {
        Ok(out) => out,
        Err(reason) => {
            return Ok(deny(
                &*workspace,
                &caller,
                &own_project,
                "thread.spawn",
                "",
                &reason,
            ));
        }
    };
    record(
        &*workspace,
        Entry::new(&own_project, actor(&caller), Action::ThreadSpawned).with("into", &project_id),
    );
    workspace.touched(&asking_thread, "thread");
    let thread_id = out
        .get("threadId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Ok(Json(json!({ "ok": true, "threadId": thread_id })))
}

#[derive(Deserialize)]
struct ThreadWaitIn {
    #[serde(rename = "threadId")]
    thread_id: String,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

/// A sibling's status, optionally waited on until it is no longer live.
async fn thread_wait(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    axum::extract::Query(query): axum::extract::Query<ThreadWaitIn>,
) -> Result<Json<Value>, StatusCode> {
    let id = query.thread_id.trim().to_string();
    if id.is_empty() {
        return Ok(refused("thread_wait needs a threadId"));
    }
    let timeout = query.timeout_ms.unwrap_or(0).min(30_000);
    let started = Instant::now();
    loop {
        let thread = workspace
            .store()
            .load_thread(&id)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let Some(thread) = thread else {
            return Ok(refused(format!("no thread '{id}' in this workspace")));
        };
        if thread.project_id != caller.project_id {
            return Ok(refused("that thread is in another project"));
        }
        let live = workspace
            .live_ptys()
            .iter()
            .any(|p| p.thread_id == id);
        let waited = started.elapsed().as_millis() as u64;
        let done = !live
            || matches!(
                thread.status.as_str(),
                "ready" | "idle" | "stopped"
            );
        if done || waited >= timeout {
            return Ok(Json(json!({
                "threadId": id,
                "status": thread.status,
                "live": live,
                "waitedMs": waited,
            })));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// This terminal, this project, this worktree. The cheap first picture.
async fn whereami(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
) -> Result<Json<Value>, StatusCode> {
    let thread_id = caller.thread_or_empty().to_string();
    let project = workspace
        .store()
        .load_projects()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_iter()
        .find(|p| p.id == caller.project_id);
    let (name, project_id) = match &project {
        Some(p) => (p.name.clone(), p.id.clone()),
        None => ("-".into(), caller.project_id.clone()),
    };
    let located = if thread_id.is_empty() {
        None
    } else {
        workspace.store().worktree_of_thread(&thread_id)
    };
    let (repo, worktree, branch, detached) = match located {
        Some((repo, path)) => {
            let current = blocking({
                let path = path.clone();
                move || git::repo_info_blocking(&path).ok().and_then(|i| i.branch)
            })
            .await?;
            (repo, path, current.clone(), current.is_none())
        }
        None => (String::from("-"), String::from("-"), None, false),
    };
    Ok(Json(json!({
        "thread": thread_id,
        "project": name,
        "projectId": project_id,
        "worktree": worktree,
        "repo": repo,
        "branch": branch,
        "detached": detached,
    })))
}

#[derive(Deserialize)]
struct FinishIn {
    #[serde(rename = "stopHookActive")]
    stop_hook_active: Option<bool>,
}

/// Whether this turn may stop without throwing the worktree's work away.
async fn finish(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    axum::extract::Query(query): axum::extract::Query<FinishIn>,
) -> Result<Json<Value>, StatusCode> {
    let already = query.stop_hook_active.unwrap_or(false);
    let worktree = caller
        .thread()
        .ok()
        .and_then(|id| workspace.store().worktree_of_thread(id))
        .map(|(_, path)| path);
    let out = blocking(move || boite_core::finish::decide(worktree.as_deref(), already)).await?;
    Ok(Json(
        serde_json::to_value(out).unwrap_or_else(|_| json!({ "allow": true })),
    ))
}

#[derive(Deserialize)]
struct PaneOpenIn {
    kind: String,
    #[serde(default)]
    url: Option<String>,
    /// A file or folder to open in the editor or explorer.
    #[serde(default)]
    path: Option<String>,
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
    Extension(caller): Extension<Caller>,
    Json(body): Json<PaneOpenIn>,
) -> Result<Json<Value>, StatusCode> {
    use boite_core::browser;

    let project_id = caller.project_id.clone();
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
    let asking_thread = caller.thread_or_empty().to_string();
    let path = body
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    if let Err(reason) = settle(
        &*workspace,
        json!({
            "kind": "pane.open",
            "projectId": project_id,
            "callerThreadId": (!asking_thread.is_empty()).then(|| asking_thread.clone()),
            "pane": kind,
            "url": url,
            "path": path,
            // Off this machine, so the device asks before framing it. It classifies
            // the address again on its side rather than trusting this one.
            "external": external,
            "side": browser::side_or_right(body.side.as_deref()),
        }),
    )
    .await
    {
        return Ok(refused(reason));
    }
    record(
        &*workspace,
        Entry::new(&project_id, actor(&caller), Action::PaneOpened)
            .about(&kind)
            .with("url", url.unwrap_or_default()),
    );
    Ok(Json(json!({ "ok": true })))
}

// ------------------------------------------------------------ the browser pane

/// What a browser tool is told when this host cannot see a window.
///
/// The server has none, and a desktop whose webview has not described itself yet
/// is the same answer. Said in full rather than as an empty list, because "no
/// browser pane is open" and "I cannot see whether one is" send an agent to two
/// different places — the same reason `transcripts_dir` answers `None` instead
/// of pretending.
const NO_WINDOW_TO_LOOK_AT: &str = "this Boite has no window of its own to look at, so it cannot \
                                    say what is on the pane. The device drawing it can: navigate, \
                                    reload and close still reach it, they just cannot be checked \
                                    from here first.";

/// What an agent is told when it reaches for a pane it is not driving.
const NOT_YOURS: &str = "the user has taken that pane back, so it is theirs to point now. Open one \
                         of your own with pane_open kind=browser.";

/// The window's description, or the sentence saying why there is none to read.
///
/// **Not scoped to the project the window happens to be showing.** It was, and
/// that made a pane an agent owned unreachable for as long as the user was
/// reading another project: every browser tool answered "the window is showing
/// another project right now", including for the agent that had just opened the
/// pane. The window mounts every group at once, so that pane is loaded, driven
/// and answering the whole time. Where the user is looking says nothing about
/// whose pane it is. [`which_pane`] holds the rule that does: the mark the pane
/// carries, and nothing else.
fn window_showing(workspace: &dyn Workspace) -> Result<boite_core::screen::Screen, String> {
    workspace.on_screen().ok_or(NO_WINDOW_TO_LOOK_AT.to_string())
}

/// Which pane the call meant, settled against what the window says is on it.
///
/// Three refusals rather than one, because an agent acts on each differently:
/// nothing to point, an id that is not there, and one it is not allowed to
/// point. All three are sentences: this runs while the agent is still alive to
/// read one.
///
/// **Naming nothing means the caller's own pane**, not the only pane on the
/// window. The description carries every group's panes, so an agent working
/// beside a user who has two other pages framed would otherwise be told to pick
/// between panes it does not own and cannot touch. It still picks between its
/// own two, which is a real ambiguity: they are usually a dev server and a docs
/// page, and guessing is guessing at the user's screen.
fn which_pane(
    screen: &boite_core::screen::Screen,
    caller: &Caller,
    asked: Option<&str>,
) -> Result<String, String> {
    let panes = screen.browsers();
    if panes.is_empty() {
        return Err(
            "no browser pane is open; pane_open kind=browser url=<address> opens one".to_string(),
        );
    }
    // An empty thread id is a credentials file: no terminal behind it, and
    // nothing it opened, so it drives nothing. Written as its own case because
    // `"" == ""` would otherwise hand it every pane the user owns.
    let mine = caller.thread_or_empty();
    let owned: Vec<&boite_core::screen::Pane> = if mine.is_empty() {
        Vec::new()
    } else {
        panes
            .iter()
            .copied()
            .filter(|p| p.driven_by.as_deref() == Some(mine))
            .collect()
    };
    let pane = match asked.filter(|id| !id.is_empty()) {
        Some(id) => panes
            .iter()
            .copied()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("no browser pane called '{id}'; browser_status lists them"))?,
        None => match owned.as_slice() {
            [only] => *only,
            [] => return Err(NOT_YOURS.to_string()),
            many => {
                return Err(format!(
                    "{} browser panes of yours are open; say which with paneId, from \
                     browser_status",
                    many.len()
                ))
            }
        },
    };
    if mine.is_empty() || pane.driven_by.as_deref() != Some(mine) {
        return Err(NOT_YOURS.to_string());
    }
    Ok(pane.id.clone())
}

/// The browser panes on the window, and what the window can honestly say about
/// them.
///
/// Read off the window's own description rather than asked for: see
/// `boite_core::screen` for why the window pushes. That description is also the
/// whole of what this endpoint can know about a page, which is why there are
/// five browser routes and not fourteen — `screen::PAGE_IS_OPAQUE` is the
/// reason, and it goes out with every answer so an agent never has to guess at
/// it.
async fn browser_status(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
) -> Result<Json<Value>, StatusCode> {
    let screen = match window_showing(&*workspace) {
        Ok(screen) => screen,
        Err(reason) => return Ok(refused(reason)),
    };
    Ok(Json(json!({
        "panes": describe(&screen, &caller),
        "describedAt": screen.at,
        "opaque": boite_core::screen::PAGE_IS_OPAQUE,
    })))
}

fn describe(screen: &boite_core::screen::Screen, caller: &Caller) -> Vec<Value> {
    let mine = caller.thread_or_empty();
    screen
        .browsers()
        .iter()
        .map(|p| {
            json!({
                "paneId": p.id,
                "url": p.url,
                "page": p.page,
                // Whose it is, rather than which thread id it names: the id
                // means nothing to an agent that is not that thread.
                "yours": !mine.is_empty() && p.driven_by.as_deref() == Some(mine),
                "focused": p.focused,
                "width": p.rect.w.round(),
                "height": p.rect.h.round(),
                // A pane laid out at no width is open and not on the screen,
                // which is a difference a list of open panes cannot show.
                "visible": p.rect.shows(),
            })
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitIn {
    pane_id: Option<String>,
    timeout_ms: Option<u64>,
}

/// How long a wait may run.
///
/// Under the shim's own 20 s socket timeout, so a wait that runs out comes back
/// as an answer the agent can read rather than as a dead connection it has to
/// interpret.
const MAX_WAIT_MS: u64 = 12_000;
/// The window describes itself on a five second beat, so a page that settles
/// just after one is seen at the next. Polling faster costs nothing and is not
/// the bound here; that is worth knowing before anyone tunes this.
const POLL_MS: u64 = 250;

/// Waits for the page to stop loading, and says which way it went.
///
/// `loaded` is the frame's own `load` event. `stalled` is the honest name for
/// the other outcome: a frame that never fires one is either slow or refused by
/// `X-Frame-Options`, and the error is delivered to the console of a document
/// nothing on this side may touch. An agent that started a dev server and wants
/// to know whether it is up reads the first; one that framed a public site and
/// got the second should open it outside.
async fn browser_wait(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    axum::extract::Query(query): axum::extract::Query<WaitIn>,
) -> Result<Json<Value>, StatusCode> {
    let budget = query.timeout_ms.unwrap_or(MAX_WAIT_MS).min(MAX_WAIT_MS);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget);
    // Settled once, before the loop: an agent that named a pane it does not
    // drive should be told so now, not in twelve seconds.
    let pane_id = match window_showing(&*workspace)
        .and_then(|s| which_pane(&s, &caller, query.pane_id.as_deref()))
    {
        Ok(id) => id,
        Err(reason) => return Ok(refused(reason)),
    };
    loop {
        // One read per turn round the loop, so "still loading" and "gone" are
        // decided from the same description rather than from two.
        let screen = workspace.on_screen();
        let pane = screen
            .as_ref()
            .and_then(|s| s.browsers().into_iter().find(|p| p.id == pane_id).cloned());
        match pane {
            Some(pane) => {
                if let Some(state) = pane.page.filter(|s| s != "loading") {
                    return Ok(Json(json!({
                        "paneId": pane_id,
                        "page": state,
                        "opaque": boite_core::screen::PAGE_IS_OPAQUE,
                    })));
                }
            }
            // The pane went away while waiting, which is an answer. Only when
            // the window did speak: a description that stopped arriving is not
            // a pane that closed.
            None if screen.is_some() => {
                return Ok(refused("that pane closed while you were waiting for it"))
            }
            None => {}
        }
        if std::time::Instant::now() >= deadline {
            return Ok(Json(json!({
                "paneId": pane_id,
                "page": "loading",
                "timedOut": true,
                "opaque": boite_core::screen::PAGE_IS_OPAQUE,
            })));
        }
        tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NavigateIn {
    url: String,
    pane_id: Option<String>,
}

/// Points a browser pane the agent is already driving at another address.
///
/// It exists because `pane_open` cannot do this: two browser panes are told
/// apart by their address (`features/panes/types.ts`), so opening the same pane
/// at a second url opens a second pane, and an agent following a dev server
/// through three routes would leave three frames behind on the user's screen.
///
/// The address goes through `boite_core::browser::classify`, the same call
/// `pane_open` makes and the only rule there is. The device classifies it again
/// on its side, which is not a duplicate: this request also reaches a device
/// from a remote boite whose loopback is not the device's.
async fn browser_navigate(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<NavigateIn>,
) -> Result<Json<Value>, StatusCode> {
    let target = match boite_core::browser::classify(body.url.trim()) {
        Ok(target) => target,
        Err(reason) => return Ok(refused(reason)),
    };
    drive(
        &workspace,
        &caller,
        "navigate",
        body.pane_id.as_deref(),
        json!({ "url": target.url, "external": target.external }),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneIn {
    pane_id: Option<String>,
}

/// Fetches the page again, for an agent that just restarted what serves it.
async fn browser_reload(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<PaneIn>,
) -> Result<Json<Value>, StatusCode> {
    drive(&workspace, &caller, "reload", body.pane_id.as_deref(), json!({}))
}

/// Takes the pane back off the user's screen once it has served its purpose.
///
/// Only a pane the agent is driving, which is the point: an agent tidying up
/// after itself is housekeeping, and an agent closing a pane the user opened is
/// taking something away from them.
async fn browser_close(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<PaneIn>,
) -> Result<Json<Value>, StatusCode> {
    drive(&workspace, &caller, "close", body.pane_id.as_deref(), json!({}))
}

/// The half the three of them share: settle what can be settled here, hand the
/// rest to whoever is drawing the pane, and write down either way.
///
/// The pane is resolved here **when the window can be seen**, and dispatched
/// unresolved when it cannot. That is not a gap left open — the device applies
/// the same three checks before it touches anything, so a host with no window
/// costs a round trip and never a wrong pane. Sending it anyway is what keeps
/// these usable on a headless boite, where the pane is on somebody's phone.
fn drive(
    workspace: &Shared,
    caller: &Caller,
    what: &str,
    asked: Option<&str>,
    detail: Value,
) -> Result<Json<Value>, StatusCode> {
    let project_id = caller.project_id.clone();
    let mut request = json!({
        "kind": format!("browser.{what}"),
        "projectId": project_id,
        "callerThreadId": caller.thread_id.clone().filter(|id| !id.is_empty()),
        "paneId": asked,
    });
    if let (Some(base), Some(extra)) = (request.as_object_mut(), detail.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }

    let seen = workspace.on_screen().is_some();
    if seen {
        match window_showing(&**workspace).and_then(|s| which_pane(&s, caller, asked)) {
            Ok(pane_id) => request["paneId"] = json!(pane_id),
            Err(reason) => {
                return Ok(deny(
                    &**workspace,
                    caller,
                    &project_id,
                    &format!("browser.{what}"),
                    asked.unwrap_or_default(),
                    &reason,
                ))
            }
        }
    }
    if let Err(reason) = workspace.ask(request) {
        return Ok(deny(
            &**workspace,
            caller,
            &project_id,
            &format!("browser.{what}"),
            asked.unwrap_or_default(),
            &reason,
        ));
    }
    record(
        &**workspace,
        Entry::new(&project_id, actor(caller), Action::BrowserDriven)
            .about(what)
            .with("url", detail.get("url").and_then(|v| v.as_str()).unwrap_or_default()),
    );
    Ok(Json(json!({
        "ok": true,
        // A device that has not described itself is the one case where this
        // answer is an intention rather than an outcome, and an agent that
        // knows which it is asks browser_status instead of assuming.
        "checked": seen,
    })))
}

// ------------------------------------------------- reading and driving a page

/// How long a page has to describe itself before the agent is told to retry.
/// Under the shim's 20 s socket timeout, so a slow page comes back as a
/// sentence rather than as a dead connection.
const SNAPSHOT_WAIT_MS: u64 = 8_000;
/// Acting on one element is quicker than walking all of them.
const ACT_WAIT_MS: u64 = 5_000;

/// Asks the device drawing the pane and waits for what it says.
///
/// The strict half of [`drive`]: pointing a pane blind is fine because the
/// device re-checks everything, but a question dispatched blind has no answer
/// channel to come back on, so these routes require the window to be visible
/// from here and refuse with the reason when it is not. The device still
/// re-checks the pane and the mark; its refusal comes back as the `error`
/// field and is passed through to the agent verbatim.
async fn ask_the_pane(
    workspace: &Shared,
    caller: &Caller,
    what: &str,
    asked: Option<&str>,
    detail: Value,
    wait_ms: u64,
    journaled: bool,
) -> Result<Json<Value>, StatusCode> {
    let project_id = caller.project_id.clone();
    let pane_id = match window_showing(&**workspace)
        .and_then(|s| which_pane(&s, caller, asked))
    {
        Ok(id) => id,
        Err(reason) => {
            return Ok(deny(
                &**workspace,
                caller,
                &project_id,
                &format!("browser.{what}"),
                asked.unwrap_or_default(),
                &reason,
            ))
        }
    };

    let mut request = json!({
        "kind": format!("browser.{what}"),
        "requestId": uuid::Uuid::new_v4().to_string(),
        "projectId": project_id,
        "callerThreadId": caller.thread_id.clone().filter(|id| !id.is_empty()),
        "paneId": pane_id,
    });
    if let (Some(base), Some(extra)) = (request.as_object_mut(), detail.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }

    let waiting = match workspace.ask_for_answer(request) {
        Ok(rx) => rx,
        Err(reason) => {
            return Ok(deny(
                &**workspace,
                caller,
                &project_id,
                &format!("browser.{what}"),
                &pane_id,
                &reason,
            ))
        }
    };
    let answer = match tokio::time::timeout(std::time::Duration::from_millis(wait_ms), waiting)
        .await
    {
        Err(_) => {
            return Ok(refused(
                "the device drawing the pane did not answer in time; the page may be busy or \
                 mid-navigation, and asking again is safe",
            ))
        }
        Ok(Err(_)) => return Ok(refused("the device went away while answering")),
        Ok(Ok(answer)) => answer,
    };
    // The device's own refusal, passed through: it re-ran the checks with a
    // fresher view of the screen than this side had.
    if answer.get("error").and_then(|v| v.as_str()).is_some() {
        return Ok(Json(answer));
    }
    if journaled {
        record(
            &**workspace,
            Entry::new(&project_id, actor(caller), Action::BrowserDriven)
                .about(what)
                .with("pane", &pane_id),
        );
    }
    let mut out = answer;
    if let Some(base) = out.as_object_mut() {
        base.insert("paneId".into(), json!(pane_id));
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotIn {
    pane_id: Option<String>,
    /// `elements` (the default), `diff` for what changed since the last one,
    /// or `text` for the page's readable prose.
    mode: Option<String>,
    /// For `text`: how many characters are worth carrying back.
    max_chars: Option<u64>,
}

/// What is in the page, as rows an agent can act on.
///
/// Answered by the driver Boite injects into the frame, which is why this
/// works on a desktop window and nowhere else: a browser-drawn device has no
/// way in, and says so. Each interactive element carries a `uid` that stays
/// stable for the life of the document, which is what `browser_click` and
/// `browser_type` take.
async fn browser_snapshot(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    axum::extract::Query(query): axum::extract::Query<SnapshotIn>,
) -> Result<Json<Value>, StatusCode> {
    let mode = query.mode.as_deref().unwrap_or("elements");
    if !["elements", "diff", "text"].contains(&mode) {
        return Ok(refused("mode is elements, diff or text"));
    }
    ask_the_pane(
        &workspace,
        &caller,
        "snapshot",
        query.pane_id.as_deref(),
        json!({ "mode": mode, "maxChars": query.max_chars }),
        SNAPSHOT_WAIT_MS,
        false,
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotIn {
    pane_id: Option<String>,
    /// Crop to this element from the last snapshot, instead of the whole pane.
    uid: Option<String>,
}

/// The pane as pixels, when the host can photograph one.
///
/// Today that is the desktop app on Windows; everywhere else the device
/// answers with the sentence saying so, and `browser_snapshot` remains the
/// cross-platform way to read a page. Not journaled: it is a look, not a
/// touch.
async fn browser_screenshot(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    axum::extract::Query(query): axum::extract::Query<ScreenshotIn>,
) -> Result<Json<Value>, StatusCode> {
    ask_the_pane(
        &workspace,
        &caller,
        "screenshot",
        query.pane_id.as_deref(),
        json!({ "uid": query.uid }),
        SNAPSHOT_WAIT_MS,
        false,
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickIn {
    pane_id: Option<String>,
    uid: String,
    double: Option<bool>,
}

async fn browser_click(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<ClickIn>,
) -> Result<Json<Value>, StatusCode> {
    ask_the_pane(
        &workspace,
        &caller,
        "click",
        body.pane_id.as_deref(),
        json!({ "uid": body.uid, "double": body.double }),
        ACT_WAIT_MS,
        true,
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeIn {
    pane_id: Option<String>,
    uid: String,
    text: String,
    /// Replace what is there rather than appending to it. On by default,
    /// because "type into the search box" almost never means "after whatever
    /// was left in it".
    clear: Option<bool>,
    /// Press Enter afterwards, for the field-and-submit shape.
    submit: Option<bool>,
}

async fn browser_type(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<TypeIn>,
) -> Result<Json<Value>, StatusCode> {
    ask_the_pane(
        &workspace,
        &caller,
        "type",
        body.pane_id.as_deref(),
        json!({ "uid": body.uid, "text": body.text, "clear": body.clear, "submit": body.submit }),
        ACT_WAIT_MS,
        true,
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PressIn {
    pane_id: Option<String>,
    key: String,
}

async fn browser_press(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<PressIn>,
) -> Result<Json<Value>, StatusCode> {
    ask_the_pane(
        &workspace,
        &caller,
        "press",
        body.pane_id.as_deref(),
        json!({ "key": body.key }),
        ACT_WAIT_MS,
        true,
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScrollIn {
    pane_id: Option<String>,
    /// Scroll this element into view; without it the page scrolls by `dy`.
    uid: Option<String>,
    dy: Option<f64>,
}

async fn browser_scroll(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<ScrollIn>,
) -> Result<Json<Value>, StatusCode> {
    ask_the_pane(
        &workspace,
        &caller,
        "scroll",
        body.pane_id.as_deref(),
        json!({ "uid": body.uid, "dy": body.dy }),
        ACT_WAIT_MS,
        true,
    )
    .await
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
