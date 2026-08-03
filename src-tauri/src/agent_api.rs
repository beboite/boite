//! This app's half of the agent endpoint.
//!
//! The routes and their behaviour live in `boite-agent-api`, shared with the
//! server. What is here is what a desktop app genuinely does differently: it
//! hands a request to its own webview rather than to whatever devices happen to
//! be connected, it pulses the sidebar so the user can see an agent reaching in,
//! and it writes a credentials file per project for agents it cannot hand
//! anything at launch.
//!
//! Bound to loopback, behind a per-session bearer token. That narrowness is the
//! whole security argument: the dev-only `mcp-bridge` could already do this
//! through `invoke_tauri`, which is exactly why it cannot ship — a door that
//! does everything cannot be defended.
//!
//! An agent Boite launched never names a project: it presents the thread id
//! stamped into its environment at spawn, and the project is resolved from that,
//! so it cannot reach another project's list.
//!
//! An agent registered from a credentials file does name one, and the check on
//! it is that the project exists — not that it is the agent's own. Every file
//! carries the same session token, so an agent wired for one project can read
//! and write the lists of the others by editing the id in its own config. That
//! is the price of reaching agents that hand a server process nothing but PATH;
//! it is a scope within one workspace, not across workspaces, and the token dies
//! with the process. `Resolution::ThreadThenCwd` is the same debt named in the
//! shared crate, and phase 3 closes both.

use std::sync::Arc;

use rand::Rng;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use boite_agent_api::{Change, Resolution, Workspace};
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
/// There is no token here on purpose. It used to carry the value, which then
/// went into every child's environment: an agent that types `env` printed its
/// own credential into a scrollback that is kept and replayed, and everything it
/// launched inherited it. A terminal is handed the path now.
#[derive(Clone)]
pub struct AgentApi {
    pub url: String,
    pub token_path: std::path::PathBuf,
}

struct DesktopWorkspace {
    /// A second connection to the database the sql plugin owns. Attached rather
    /// than opened: the schema belongs to the plugin, which applies it against
    /// an sqlx checksum ledger, and a second migration mechanism over the same
    /// tables is how an install ends up with a half-applied schema.
    store: Store,
    token: String,
    app: tauri::AppHandle,
}

impl Workspace for DesktopWorkspace {
    fn store(&self) -> &Store {
        &self.store
    }

    fn roots(&self) -> &ProjectRoots {
        self.app.state::<ProjectRoots>().inner()
    }

    fn token(&self) -> &str {
        &self.token
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
            },
            (),
        );
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

    /// See the enum: a working directory is not an identity, and this is the
    /// only host that still accepts one.
    fn resolution(&self) -> Resolution {
        Resolution::ThreadThenCwd
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

/// One credentials file per project, for agents Boite cannot hand anything at
/// launch.
///
/// Rewritten on every start, because the port is ephemeral: a file kept from a
/// previous run would name an address nothing answers on. That is also why the
/// token inside is the session's own — there is no second secret to manage, and
/// nothing here outlives the app by more than one launch.
fn write_project_credentials(
    app: &tauri::AppHandle,
    store: &Store,
    url: &str,
    token_path: &std::path::Path,
) {
    let projects = match store.load_projects() {
        Ok(p) => p,
        Err(e) => {
            crate::logging::warn_to_log(app, "agent-api", &format!("credentials: {e}"));
            return;
        }
    };
    for project in projects {
        if let Err(e) = write_one(app, url, token_path, &project.id) {
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
/// Mode 0600 on unix: it grants write access to this workspace's todo lists,
/// which is modest but not nothing, and there is no reason for it to be readable
/// by anyone else on the machine.
pub fn write_one(
    app: &tauri::AppHandle,
    url: &str,
    token_path: &std::path::Path,
    project_id: &str,
) -> Result<std::path::PathBuf, String> {
    // Read back rather than passed around: the endpoint's own token file is the
    // single copy, and a second one travelling through call arguments is a
    // second thing to keep in step.
    let token = boite_core::secret_file::read(token_path)
        .map_err(|e| format!("cannot read the agent token: {e}"))?;
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    let path = base.join("mcp").join(format!("{project_id}.json"));

    let body = json!({ "url": url, "token": token, "projectId": project_id });
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

    let token = format!("{:032x}", rand::thread_rng().gen::<u128>());

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
    let token_path = config_dir.join("agent-token");
    // Written before anything can want to read it back.
    if let Err(e) = boite_core::secret_file::write(&token_path, &token) {
        crate::logging::warn_to_log(
            app,
            "agent-api",
            &format!("cannot write the token file: {e}"),
        );
        return;
    }
    write_project_credentials(app, &store, &url, &token_path);

    let router = boite_agent_api::router(Arc::new(DesktopWorkspace {
        store,
        token,
        app: app.clone(),
    }));
    app.manage(AgentApi { url, token_path });

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
