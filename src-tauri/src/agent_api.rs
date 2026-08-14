//! This app's half of the agent endpoint.
//!
//! The routes and their behaviour live in `boite-agent-api`, shared with the
//! server. What is here is what a desktop app genuinely does differently: it
//! hands a request to its own webview rather than to whatever devices happen to
//! be connected, it pulses the sidebar so the user can see an agent reaching in,
//! and it writes a credentials file per project for agents it cannot hand
//! anything at launch.
//!
//! Bound to loopback. That narrowness is the whole security argument: the
//! dev-only `mcp-bridge` could already do this through `invoke_tauri`, which is
//! exactly why it cannot ship — a door that does everything cannot be defended.
//!
//! Who may ask for what is `boite_agent_api::auth`, and it is the same on both
//! hosts. An agent Boite launched signs with a key minted for its thread; an
//! agent registered from a credentials file presents a token derived for one
//! project and cannot reach another. The desktop used to accept a third thing —
//! a working directory, with the project resolved to whichever one contained it
//! — and that is gone.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use boite_agent_api::{Change, Workspace};
use boite_core::scope::ProjectRoots;
use boite_core::store::Store;

/// Everything an agent asks for that only the app can carry out.
///
/// Moving a thread, creating a project and opening a second terminal all mean
/// killing or spawning a PTY, opening or releasing a worktree, and writing rows
/// the front end owns. None of that belongs behind an HTTP handler holding a
/// second connection to the database — so the endpoint checks what it can see,
/// emits, and lets the app do the work.
const AGENT_REQUEST: &str = "boite://agent-request";

/// The answers the window owes, by request id.
///
/// A browser question (`browser.snapshot`, `browser.click`, ...) is emitted to
/// the webview like any agent request, but its HTTP handler stays on the line:
/// the sender parked here is that handler's, and `agent_answer` is the webview
/// handing the result back. Senders whose handler has given up (timeout, agent
/// gone) are pruned on the next question rather than watched: the map only
/// ever holds a handful, and a closed sender costs nothing but its entry.
#[derive(Default)]
pub struct DeviceAnswers(
    std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<Value>>>,
);

/// Says an agent just reached into Boite itself, and through which door.
///
/// Everything else an agent does happens inside its terminal, where it can be
/// read. This endpoint is the one thing that does not: a todo appears, a
/// worktree takes a branch, a thread moves, and the only trace is the result
/// showing up somewhere with nothing to say who did it. The window is what tells
/// the user, so the window has to be told.
///
/// Mutations only. `todo_list` and `worktree_status` run on most agent turns,
/// and a pulse on every read would be a light that is always on, which is a
/// light that says nothing.
const AGENT_ACTIVITY: &str = "boite://agent-activity";

/// What a spawned terminal is told about the agent endpoint.
///
/// No secret here on purpose, and not even a shared one to point at. Each
/// terminal gets a key of its own, minted into [`AgentApi::keys_dir`] when it
/// spawns; the workspace secret never leaves this process.
#[derive(Clone)]
pub struct AgentApi {
    pub url: String,
    pub keys_dir: std::path::PathBuf,
    /// Private, and it stays private: the only thing anyone may have out of it
    /// is a token for one project, through [`AgentApi::project_token`]. A `pub`
    /// field here would be one autocomplete away from a value in an environment
    /// again.
    secret: String,
    /// The same workspace the routes are served over, so the commands below
    /// answer an approval through `boite_agent_api::decide` rather than through
    /// a second idea of what allowing one does.
    workspace: boite_agent_api::Shared,
}

impl AgentApi {
    /// The token a credentials file for that project carries.
    ///
    /// Derived rather than stored, so a file that names a different project
    /// than the one it was written for carries a token that no longer verifies.
    pub fn project_token(&self, project_id: &str) -> String {
        boite_identity::project_token(&self.secret, project_id)
    }
}

struct DesktopWorkspace {
    /// A second connection to the database the sql plugin owns. Attached rather
    /// than opened: the schema belongs to the plugin, which applies it against
    /// an sqlx checksum ledger, and a second migration mechanism over the same
    /// tables is how an install ends up with a half-applied schema.
    store: Store,
    secret: String,
    app: tauri::AppHandle,
}

impl Workspace for DesktopWorkspace {
    fn store(&self) -> &Store {
        &self.store
    }

    fn roots(&self) -> &ProjectRoots {
        self.app.state::<ProjectRoots>().inner()
    }

    fn secret(&self) -> &str {
        &self.secret
    }

    /// There is one webview and it is this app's own, so there is nobody to be
    /// missing: a request is emitted and the front end acts on it. The server's
    /// answer to this is the one that can say no.
    fn ask(&self, request: Value) -> Result<(), String> {
        let _ = self.app.emit(AGENT_REQUEST, request);
        Ok(())
    }

    fn announce(&self, change: Change) {
        let _ = self.app.emit(
            match change {
                Change::Todos => "boite://todos-changed",
                Change::Worktrees => "boite://worktrees-changed",
                Change::Approvals => "boite://approvals-changed",
            },
            (),
        );
    }

    fn transcripts_dir(&self) -> Option<std::path::PathBuf> {
        self.app
            .path()
            .app_config_dir()
            .ok()
            .map(|dir| dir.join("transcripts"))
    }

    fn live_ptys(&self) -> Vec<boite_core::snapshot::LivePty> {
        let Some(sessions) = self.app.try_state::<crate::local_pty::LocalSessions>() else {
            return Vec::new();
        };
        let manager = self.app.state::<boite_core::pty::PtyManager>();
        sessions
            .all()
            .into_iter()
            .map(|(thread_id, pty_id)| boite_core::snapshot::LivePty {
                child_pid: manager.child_pid(&pty_id),
                thread_id,
                pty_id,
            })
            .collect()
    }

    /// What the window last said was on it. The one question an agent used to
    /// have to ask a human, and the endpoint carries it in the snapshot rather
    /// than behind a call of its own: an agent working out why something looks
    /// wrong should not have to know it exists.
    fn on_screen(&self) -> Option<boite_core::screen::Screen> {
        self.app
            .try_state::<crate::commands::app::LastScreen>()
            .and_then(|last| last.take())
    }

    /// The desktop is the one host that can answer a question about a page:
    /// its own webview draws the pane, and the driver injected into the frame
    /// reads it. The handler's sender waits under the request id; the webview
    /// answers through `agent_answer`.
    fn ask_for_answer(
        &self,
        request: Value,
    ) -> Result<tokio::sync::oneshot::Receiver<Value>, String> {
        let id = request
            .get("requestId")
            .and_then(|v| v.as_str())
            .ok_or("the question carries no request id")?
            .to_string();
        let answers = self.app.state::<DeviceAnswers>();
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = answers.0.lock().unwrap();
            pending.retain(|_, sender| !sender.is_closed());
            pending.insert(id, tx);
        }
        let _ = self.app.emit(AGENT_REQUEST, request);
        Ok(rx)
    }

    /// Attribution is best-effort: an agent registered from a credentials file
    /// presents a project rather than a thread, and there is no row to point at.
    /// The surface still pulses; only the "which of these agents" half is lost.
    fn touched(&self, thread_id: &str, surface: &str) {
        let _ = self.app.emit(
            AGENT_ACTIVITY,
            json!({ "surface": surface, "threadId": thread_id }),
        );
    }
}

/// The key a terminal about to open will sign with.
///
/// Its own database connection, opened per spawn rather than held: the desktop's
/// schema belongs to tauri-plugin-sql and this side only ever attaches. A
/// terminal opens at human speed, so one sqlite open costs nothing measurable,
/// and a second long-lived connection to a file the plugin is writing does.
pub fn mint_thread_key(
    app: &tauri::AppHandle,
    api: &AgentApi,
    thread_id: &str,
) -> Result<std::path::PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    let store = Store::attach(&config_dir.join("boite.db"))?;
    boite_agent_api::keys::mint(&store, &api.keys_dir, thread_id)
}

/// Everything an agent has put in front of the user and nobody has answered.
///
/// Not scoped to the project the window is showing: an agent in another project
/// asking to move is exactly the thing that would otherwise be invisible until
/// somebody happened to stand in the right place.
#[tauri::command]
pub fn approvals_open(app: tauri::AppHandle) -> Result<Vec<boite_core::approval::Pending>, String> {
    let api = app
        .try_state::<AgentApi>()
        .ok_or("the agent endpoint is not running")?;
    api.workspace.store().open_approvals()
}

/// The user's answer.
///
/// Allowing one replays the dispatch that was stored with it, which is why this
/// goes through `boite_agent_api::decide` rather than rebuilding the request
/// from what the card was showing.
#[tauri::command]
pub fn approval_decide(
    app: tauri::AppHandle,
    id: String,
    allow: bool,
) -> Result<Option<boite_core::approval::Pending>, String> {
    use boite_core::approval::Verdict;
    let api = app
        .try_state::<AgentApi>()
        .ok_or("the agent endpoint is not running")?;
    let verdict = if allow { Verdict::Allowed } else { Verdict::Refused };
    boite_agent_api::decide(&*api.workspace, &id, verdict, now_ms())
}

use boite_core::now_ms;

/// The webview handing back the answer to a browser question.
///
/// Quiet about an id nobody is waiting on: the handler that asked may have
/// timed out and told the agent so already, and a second answer has no reader.
#[tauri::command]
pub fn agent_answer(app: tauri::AppHandle, request_id: String, payload: Value) {
    let Some(answers) = app.try_state::<DeviceAnswers>() else {
        return;
    };
    let waiting = answers.0.lock().unwrap().remove(&request_id);
    if let Some(tx) = waiting {
        let _ = tx.send(payload);
    }
}

/// Removes a deleted thread's key file.
///
/// Not a command any more. It used to be one because the front end owned the
/// rows and dropped `thread_keys` itself in a statement batch, leaving this as
/// the half that was not SQL; deleting a thread is one call on the bus now, and
/// this is what that call does afterwards. Quiet about a thread that never had
/// a key.
pub fn forget_thread_key_file(app: &tauri::AppHandle, thread_id: &str) {
    if let Some(api) = app.try_state::<AgentApi>() {
        boite_agent_api::keys::forget(&api.keys_dir, thread_id);
    }
}

/// One credentials file per project, for agents Boite cannot hand anything at
/// launch.
///
/// Rewritten on every start, because the port is ephemeral: a file kept from a
/// previous run would name an address nothing answers on. The token inside dies
/// with the process too, since the secret it is derived from is minted at
/// startup and written nowhere.
fn write_project_credentials(app: &tauri::AppHandle, store: &Store, api: &AgentApi) {
    let projects = match store.load_projects() {
        Ok(p) => p,
        Err(e) => {
            crate::logging::warn_to_log(app, "agent-api", &format!("credentials: {e}"));
            return;
        }
    };
    for project in projects {
        if let Err(e) = write_one(app, api, &project.id) {
            crate::logging::warn_to_log(
                app,
                "agent-api",
                &format!("credentials for {}: {e}", project.id),
            );
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
///
/// Mode 0600 on unix: it grants write access to this one project's todo list,
/// which is modest but not nothing, and there is no reason for it to be readable
/// by anyone else on the machine.
///
/// The token in it opens that project and no other. It used to be the workspace
/// token, the same value in every file, so an agent wired for one project could
/// read and write the lists of the rest by editing the id in its own config.
pub fn write_one(
    app: &tauri::AppHandle,
    api: &AgentApi,
    project_id: &str,
) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    let path = base.join("mcp").join(format!("{project_id}.json"));

    let body = json!({
        "url": api.url,
        "token": api.project_token(project_id),
        "projectId": project_id,
    });
    // Through the shared helper: this file holds a bearer token in the clear and
    // used to be restricted on unix alone, with Windows left to whatever the
    // parent directory happened to allow.
    boite_core::secret_file::write(&path, &body.to_string()).map_err(|e| format!("write: {e}"))?;
    Ok(path)
}

/// Binds on an ephemeral loopback port and stores the address plus token in
/// managed state, where the PTY spawn path picks them up. Never binds anything
/// but 127.0.0.1: this endpoint mutates a workspace, and nothing about it
/// belongs on a LAN or a tailnet.
pub fn start(app: &tauri::AppHandle) {
    let config_dir = match app.path().app_config_dir() {
        Ok(dir) => dir,
        Err(e) => {
            // The one that stays on stderr alone: without a config dir there is
            // no log file to write it to.
            eprintln!("[boite/agent-api] disabled, no config dir: {e}");
            return;
        }
    };
    let store = match Store::attach(&config_dir.join("boite.db")) {
        Ok(store) => store,
        Err(e) => {
            crate::logging::warn_to_log(app, "agent-api", &format!("disabled: {e}"));
            return;
        }
    };

    // In memory for the life of the process and written nowhere. Every
    // credential this workspace issues is derived from it, so a copy on disk
    // would be the one file worth stealing.
    let secret = format!("{:032x}", rand::random::<u128>());

    // Bound here, not inside the task: the address has to be known before the
    // first thread can spawn. Registering it from the task left a window where
    // pty_open found no state and launched an agent with no credentials — the
    // shim then exits, and the agent reports only that its MCP server closed the
    // connection. Small window, but it is exactly the moment someone starts a
    // terminal: right after the app opens.
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            crate::logging::warn_to_log(app, "agent-api", &format!("bind failed: {e}"));
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            crate::logging::warn_to_log(app, "agent-api", &format!("local_addr failed: {e}"));
            return;
        }
    };
    if let Err(e) = listener.set_nonblocking(true) {
        crate::logging::warn_to_log(app, "agent-api", &format!("set_nonblocking failed: {e}"));
        return;
    }
    let url = format!("http://127.0.0.1:{port}");
    // Beside the database rather than under a temp directory: a thread's key
    // file and its row have to be lost together or not at all. See
    // `boite_agent_api::keys::mint`.
    let keys_dir = config_dir.join("thread-keys");
    if let Err(e) = std::fs::create_dir_all(&keys_dir) {
        crate::logging::warn_to_log(
            app,
            "agent-api",
            &format!("cannot make the key directory: {e}"),
        );
        return;
    }
    let workspace: boite_agent_api::Shared = Arc::new(DesktopWorkspace {
        store: match Store::attach(&config_dir.join("boite.db")) {
            Ok(store) => store,
            Err(e) => {
                crate::logging::warn_to_log(app, "agent-api", &format!("disabled: {e}"));
                return;
            }
        },
        secret: secret.clone(),
        app: app.clone(),
    });
    let api = AgentApi {
        url: url.clone(),
        keys_dir,
        secret,
        workspace: workspace.clone(),
    };
    write_project_credentials(app, &store, &api);

    let router = boite_agent_api::router(workspace);
    app.manage(api);

    let served = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                crate::logging::warn_to_log(&served, "agent-api", &format!("listener adoption failed: {e}"));
                return;
            }
        };
        if let Err(e) = axum::serve(listener, router).await {
            crate::logging::warn_to_log(&served, "agent-api", &format!("serve ended: {e}"));
        }
    });
}
