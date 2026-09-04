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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot};

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
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    /// Generated MCP files on this host, when the sidecar was found.
    pub mcp: Option<boite_core::mcp_launch::McpPaths>,
}

impl AgentApi {
    /// Resolve a parked `ask_settled` wait. Quiet when nobody is waiting.
    pub fn answer(&self, request_id: &str, payload: Value) -> bool {
        let waiting = self.pending.lock().unwrap().remove(request_id);
        if let Some(tx) = waiting {
            tx.send(payload).is_ok()
        } else {
            false
        }
    }
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
    /// Oneshots the HTTP handlers wait on, keyed by the request id the device
    /// answers with. Shared with [`AgentApi::answer`] so the RPC can resolve
    /// them without knowing about this struct.
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    /// The same wait registry the RPC's `conduct.record` notifies, so an
    /// orchestrator sleeping on `GET /v1/pulse` wakes on a device's write.
    pulse: Arc<boite_core::pulse::Waiters>,
    /// This server's pilot runtime, the only thing that knows what a chat
    /// thread is doing. The same `Arc` the state holds, so `thread_wait` and
    /// the RPC read one set of sessions.
    pilot: Arc<boite_pilot::Runtime>,
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

    fn ask_settled(
        &self,
        mut request: Value,
    ) -> Result<oneshot::Receiver<Value>, String> {
        if self.devices.load(Ordering::Relaxed) == 0 {
            return Err(NOBODY_TO_CARRY_IT_OUT.to_string());
        }
        let id = request
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        request["requestId"] = json!(id.clone());
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            pending.retain(|_, sender| !sender.is_closed());
            pending.insert(id, tx);
        }
        let _ = self.events.send(AppEvent::AgentRequest(request));
        Ok(rx)
    }

    fn transcripts_dir(&self) -> Option<PathBuf> {
        self.registry.transcripts_dir()
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
            Change::Orchestrator => AppEvent::OrchestratorChanged,
            Change::DispatchQueued {
                to_thread_id,
                dispatch_id,
            } => AppEvent::DispatchQueued {
                thread_id: to_thread_id,
                dispatch_id,
            },
            Change::ThreadDismissed { thread_id } => AppEvent::ThreadDismissed { thread_id },
        });
    }

    fn pulse_waiters(&self) -> Option<Arc<boite_core::pulse::Waiters>> {
        Some(self.pulse.clone())
    }

    fn pilot_status(&self, thread_id: &str) -> Option<String> {
        self.pilot
            .status(thread_id)
            .map(|status| boite_core::pilot::status_word(status).to_string())
    }
}

/// Binds an ephemeral loopback port and returns what the PTY spawn path stamps
/// into each child. Returns None if the listener cannot start: the workspace
/// still works, agents just have no todo access.
/// Eight arguments, and each is a live thing this process already holds rather
/// than configuration: bundling them into a struct would be one more name for
/// the same list, built at the one call site that exists.
#[allow(clippy::too_many_arguments)]
pub async fn start(
    store: Arc<Store>,
    events: broadcast::Sender<AppEvent>,
    roots: Arc<ProjectRoots>,
    config: &crate::config::Config,
    devices: Arc<AtomicUsize>,
    registry: Arc<crate::registry::Registry>,
    pulse: Arc<boite_core::pulse::Waiters>,
    pilot: Arc<boite_pilot::Runtime>,
) -> Option<AgentApi> {
    let workspace_dir = config.workspace_dir.clone();
    let data_dir = config.data_dir.clone();
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
    let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let mcp = sidecar_next_to_server().and_then(|sidecar| {
        boite_core::mcp_launch::write_files(&data_dir.join("mcp"), &sidecar)
            .map_err(|e| {
                tracing::warn!("agent mcp files not written: {e}");
                e
            })
            .ok()
    });
    let workspace: boite_agent_api::Shared = Arc::new(ServerWorkspace {
        store,
        events,
        devices,
        secret,
        roots,
        workspace_dir,
        registry,
        pending: pending.clone(),
        pulse,
        pilot,
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
        pending,
        mcp,
    })
}

/// The shim next to this binary, the same place the desktop looks.
fn sidecar_next_to_server() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let sidecar = dir.join(if cfg!(windows) {
        "boite-mcp.exe"
    } else {
        "boite-mcp"
    });
    sidecar.is_file().then_some(sidecar)
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
