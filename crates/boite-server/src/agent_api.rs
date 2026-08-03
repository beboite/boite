//! This server's half of the agent endpoint.
//!
//! The routes and their behaviour live in `boite-agent-api`, shared with the
//! desktop. What is here is what a server genuinely does differently: it hands a
//! request to whatever devices are connected rather than to a webview it owns,
//! it knows there may be none, and it takes its port from the OS on loopback.
//!
//! It gets its own listener rather than routes on the main router, and its own
//! token. The main server may be bound to a routable interface — that is the
//! whole point of a remote workspace — and nothing here belongs on a network.
//! The client token and this one are also different secrets: a device that can
//! drive the workspace is not the same principal as an agent that may append to
//! a checklist.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::broadcast;

use boite_agent_api::{Change, Workspace, NOBODY_TO_CARRY_IT_OUT};
use boite_core::scope::ProjectRoots;
use boite_core::store::Store;

use crate::events::AppEvent;

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

struct ServerWorkspace {
    store: Arc<Store>,
    events: broadcast::Sender<AppEvent>,
    /// Authenticated clients right now. Zero means nothing on the other side
    /// can carry out a request, and saying so beats answering `200`.
    devices: Arc<AtomicUsize>,
    token: String,
    /// The same boundary the RPC applies, so where a project may be created is
    /// one rule rather than two that drift.
    roots: Arc<ProjectRoots>,
    workspace_dir: Option<PathBuf>,
}

impl Workspace for ServerWorkspace {
    fn store(&self) -> &Store {
        &self.store
    }

    fn roots(&self) -> &ProjectRoots {
        &self.roots
    }

    fn token(&self) -> &str {
        &self.token
    }

    fn extra_project_parents(&self) -> Vec<String> {
        let mut allowed: Vec<String> = dirs::home_dir()
            .map(|home| vec![home.to_string_lossy().to_string()])
            .unwrap_or_default();
        if let Some(workspace) = &self.workspace_dir {
            allowed.push(workspace.to_string_lossy().to_string());
        }
        allowed
    }

    /// Hands a request to the connected devices, tagged so exactly one acts.
    ///
    /// The server can carry out none of these: moving a thread means killing a
    /// PTY and opening a worktree, and a client drives both. It also cannot know
    /// which device is looking, so the request goes to all of them and
    /// `agent.claimRequest` settles who takes it.
    fn ask(&self, mut request: Value) -> Result<(), String> {
        if self.devices.load(Ordering::Relaxed) == 0 {
            return Err(NOBODY_TO_CARRY_IT_OUT.to_string());
        }
        request["requestId"] = json!(uuid::Uuid::new_v4().to_string());
        let _ = self.events.send(AppEvent::AgentRequest(request));
        Ok(())
    }

    /// Tells every device to re-read.
    ///
    /// One event for both kinds, which is not right and is not new: no client
    /// redraws worktree state on a push today, so a claimed branch is announced
    /// as a todo change and the panel that would care refreshes anyway. The
    /// event to add is a client-side change, not a server one.
    fn announce(&self, _change: Change) {
        let _ = self.events.send(AppEvent::TodosChanged);
    }
}

/// Binds an ephemeral loopback port and returns what the PTY spawn path stamps
/// into each child. Returns None if the listener cannot start: the workspace
/// still works, agents just have no todo access.
pub async fn start(
    store: Arc<Store>,
    events: broadcast::Sender<AppEvent>,
    roots: Arc<ProjectRoots>,
    workspace_dir: Option<PathBuf>,
    devices: Arc<AtomicUsize>,
    data_dir: PathBuf,
) -> Option<AgentApi> {
    let token = format!("{:032x}", rand::random::<u128>());
    let token_path = data_dir.join("agent-token");
    if let Err(e) = boite_core::secret_file::write(&token_path, &token) {
        tracing::warn!("agent api disabled, cannot write the token file: {e}");
        return None;
    }
    let router = boite_agent_api::router(Arc::new(ServerWorkspace {
        store,
        events,
        devices,
        token,
        roots,
        workspace_dir,
    }));

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
