//! This server's half of the agent endpoint.
//!
//! The routes and their behaviour live in `boite-agent-api`, shared with the
//! desktop. What is here is what a server genuinely does differently: it hands a
//! request to whatever devices are connected rather than to a webview it owns,
//! it knows there may be none, and it takes its port from the OS on loopback.
//!
//! It gets its own listener rather than routes on the main router, and its own
//! secret. The main server may be bound to a routable interface — that is the
//! whole point of a remote workspace — and nothing here belongs on a network.
//! The client token and this secret are also different things: a device that can
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
/// No secret here on purpose, and not even a shared one to point at any more:
/// each terminal gets a key of its own, minted into [`AgentApi::keys_dir`] when
/// it spawns. The workspace secret never leaves this process; the only thing
/// derived from it is a per-project token in a credentials file.
#[derive(Clone)]
pub struct AgentApi {
    pub url: String,
    pub keys_dir: PathBuf,
    /// The same workspace the routes are served over.
    ///
    /// Held so the RPC can answer an approval without a second implementation
    /// of what allowing one does: the interesting half is replaying the stored
    /// dispatch, and two copies of that would be two ideas of what the user
    /// agreed to.
    pub workspace: boite_agent_api::Shared,
}

struct ServerWorkspace {
    store: Arc<Store>,
    events: broadcast::Sender<AppEvent>,
    /// Authenticated clients right now. Zero means nothing on the other side
    /// can carry out a request, and saying so beats answering `200`.
    devices: Arc<AtomicUsize>,
    secret: String,
    /// The same boundary the RPC applies, so where a project may be created is
    /// one rule rather than two that drift.
    roots: Arc<ProjectRoots>,
    workspace_dir: Option<PathBuf>,
    /// Only ever read for the snapshot: what the rows claim about a thread and
    /// what this process actually has a PTY for are two different questions.
    registry: Arc<crate::registry::Registry>,
}

impl Workspace for ServerWorkspace {
    fn store(&self) -> &Store {
        &self.store
    }

    fn roots(&self) -> &ProjectRoots {
        &self.roots
    }

    fn secret(&self) -> &str {
        &self.secret
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

    fn live_ptys(&self) -> Vec<boite_core::snapshot::LivePty> {
        let manager = self.registry.pty_manager();
        self.registry
            .live_snapshot()
            .into_iter()
            .map(|(thread_id, (pty_id, _, _))| boite_core::snapshot::LivePty {
                child_pid: manager.child_pid(&pty_id),
                thread_id,
                pty_id,
            })
            .collect()
    }

    /// Tells every device to re-read.
    ///
    /// Todos and worktrees share an event, which is not right and is not new:
    /// no client redraws worktree state on a push today, so a claimed branch is
    /// announced as a todo change and the panel that would care refreshes
    /// anyway. The event to add there is a client-side change, not a server one.
    ///
    /// An approval is not in that bucket. Nothing else makes a card appear, and
    /// a request the user never sees is a request that never gets answered.
    fn announce(&self, change: Change) {
        let _ = self.events.send(match change {
            Change::Approvals => AppEvent::ApprovalsChanged,
            Change::Todos | Change::Worktrees => AppEvent::TodosChanged,
        });
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
    registry: Arc<crate::registry::Registry>,
) -> Option<AgentApi> {
    // In memory for the life of the process and written nowhere. Every
    // credential this workspace issues is derived from it, so a copy on disk
    // would be the one file worth stealing.
    let secret = format!("{:032x}", rand::random::<u128>());
    let keys_dir = data_dir.join("thread-keys");
    // Beside the database rather than under a temp directory: a thread's key
    // file and its row have to be lost together or not at all. See
    // `boite_agent_api::keys::mint`.
    if let Err(e) = std::fs::create_dir_all(&keys_dir) {
        tracing::warn!("agent api disabled, cannot make the key directory: {e}");
        return None;
    }
    let workspace: boite_agent_api::Shared = Arc::new(ServerWorkspace {
        store,
        events,
        devices,
        secret,
        roots,
        workspace_dir,
        registry,
    });
    let router = boite_agent_api::router(workspace.clone());

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
        keys_dir,
        workspace,
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
