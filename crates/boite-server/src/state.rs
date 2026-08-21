use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

use tokio::sync::broadcast;

use boite_core::scope::ProjectRoots;

use crate::auth::Auth;
use crate::events::AppEvent;
use crate::notify::Notifier;
use crate::push::PushManager;
use crate::registry::Registry;
use boite_core::store::Store;

pub struct AppState {
    pub store: Arc<Store>,
    /// None when its listener could not bind: the workspace still runs, agents
    /// simply get no todo access.
    pub agent_api: Option<crate::agent_api::AgentApi>,
    pub registry: Arc<Registry>,
    pub auth: Auth,
    /// Shared with the agent endpoint, which applies the same rule about where a
    /// project may be created and has to see every refresh this one makes.
    pub roots: Arc<ProjectRoots>,
    pub events: broadcast::Sender<AppEvent>,
    pub notifier: Notifier,
    pub push: PushManager,
    pub max_threads: usize,
    pub max_connections: usize,
    pub conns: AtomicUsize,
    /// Authenticated clients, which is not the same question as `conns`: that
    /// one counts sockets from the moment they open, this one counts the ones
    /// that got past `auth` and are therefore receiving control events. The
    /// agent endpoint asks it before promising an agent that something it
    /// cannot do itself will happen.
    pub devices: Arc<AtomicUsize>,
    pub workspace_dir: Option<PathBuf>,
    /// Persisted data dir, used to serve `/.well-known/assetlinks.json` (the
    /// Android TWA Digital Asset Links file, dropped here after the APK build).
    pub data_dir: PathBuf,
    /// The name this boite is reached by from outside, when the operator has
    /// said (`BOITE_PUBLIC_URL`).
    ///
    /// Only ever used to build the text of a pairing link. A server behind a
    /// reverse proxy cannot work its own public name out — the `Host` header is
    /// whatever the caller sent — so the choice is this or a client-supplied
    /// origin, and a configured value wins over one. It decides what the link
    /// says, never what the token opens.
    pub public_url: Option<String>,
    /// Agent requests already spoken for. An `AgentRequest` reaches every
    /// connected device and exactly one of them may act on it — two clients
    /// running the same move would kill one PTY twice and leave a second
    /// worktree behind.
    pub claimed_requests: parking_lot::Mutex<std::collections::VecDeque<String>>,
    /// The live `conduct.pulse` waits of this process. Shared with the agent
    /// endpoint, so an orchestrator's long-poll wakes on a moment whichever
    /// door wrote it.
    pub pulse: Arc<boite_core::pulse::Waiters>,
    /// Process-wide telemetry queue. None in tests, which never send.
    pub telemetry: Option<Arc<boite_core::telemetry::TelemetryRuntime>>,
}

/// How many claims are remembered. Each is a uuid a client either took or lost
/// seconds ago; a request older than the last few hundred cannot still be in
/// flight, and the queue exists so a long-lived server does not grow a set that
/// only ever gets bigger.
const CLAIM_MEMORY: usize = 256;

impl AppState {
    /// Whether this caller is the one that carries the request out.
    ///
    /// True exactly once per id. Every other device asking gets false and drops
    /// it, which is the whole point: the event is broadcast because the server
    /// cannot tell which device is watching, not because they should all act.
    pub fn claim_agent_request(&self, request_id: &str) -> bool {
        let mut claimed = self.claimed_requests.lock();
        if claimed.iter().any(|id| id == request_id) {
            return false;
        }
        claimed.push_back(request_id.to_string());
        while claimed.len() > CLAIM_MEMORY {
            claimed.pop_front();
        }
        true
    }

    /// Rebuild the filesystem trust boundary from the persisted project cwds,
    /// plus the workspace base dir so the web folder picker can browse it
    /// before any project exists. Clients never set roots directly.
    pub fn refresh_roots(&self) -> Result<(), String> {
        let projects = self.store.load_projects()?;
        let mut roots: Vec<String> = projects
            .into_iter()
            .filter(|p| !p.archived)
            .map(|p| p.cwd)
            .collect();
        if let Some(dir) = &self.workspace_dir {
            roots.push(dir.to_string_lossy().to_string());
        }
        // One root for every worktree the old layout left behind. A thread's
        // worktree now lives under its own project, which is already a root, but
        // one not yet migrated still has to be readable to be moved. Created
        // here because `replace` canonicalizes and drops what does not exist.
        let worktrees = self.worktree_base();
        if std::fs::create_dir_all(&worktrees).is_ok() {
            roots.push(worktrees.to_string_lossy().to_string());
        }
        self.roots.replace(roots);
        Ok(())
    }

    /// Where thread worktrees used to live, beside the database.
    ///
    /// They live in their own project now, under `worktree_base_for`. This is
    /// what a worktree is migrated *out of*, and what a source path is checked
    /// against before anything is moved, so it stays for as long as an install
    /// can still be carrying one. `BOITE_WORKTREE_BASE` moves it, which matters
    /// here only for finding worktrees an earlier run put somewhere else.
    pub fn worktree_base(&self) -> PathBuf {
        std::env::var("BOITE_WORKTREE_BASE")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.data_dir.join("worktrees"))
    }

    /// Boundary for adding/browsing projects. When BOITE_WORKSPACE_DIR is set,
    /// clients may only add projects below it. Without that env var the server
    /// keeps the old "authenticated local operator" behavior and accepts any
    /// existing directory as a project root.
    pub fn ensure_project_path(&self, path: &str) -> Result<(), String> {
        let Some(workspace) = &self.workspace_dir else {
            let canonical = std::fs::canonicalize(path)
                .map_err(|e| format!("invalid path: {e}"))?;
            if canonical.is_dir() {
                return Ok(());
            }
            return Err("not a directory".into());
        };
        ensure_under(workspace, path)
    }

    /// Boundary for operations after a project exists.
    pub fn ensure_registered_path(&self, path: &str) -> Result<(), String> {
        self.roots.ensure_allowed(path)
    }

    /// What a command on the bus is allowed to reach on this side.
    ///
    /// Cheap enough to build per call, and built per call on purpose — a host
    /// held somewhere would be a second place for the boundary to go stale after
    /// `refresh_roots`.
    pub fn command_host(&self) -> ServerHost<'_> {
        ServerHost { state: self }
    }
}

/// The server's answer to what a command may reach.
///
/// It differs from a desktop's in one way: a server can be bound to a workspace
/// directory, and then a folder outside it may not become a project however the
/// caller spells it. A desktop has no equivalent — the user's own folder dialog
/// is the gate.
pub struct ServerHost<'a> {
    state: &'a AppState,
}

impl boite_core::command::Host for ServerHost<'_> {
    fn roots(&self) -> &ProjectRoots {
        self.state.roots.as_ref()
    }

    fn legacy_worktree_base(&self) -> Option<PathBuf> {
        Some(self.state.worktree_base())
    }

    /// Checked without requiring the path to exist.
    ///
    /// The folder a project is about to go in does not exist yet, and asking
    /// about it is the whole point of `project.folderState`. This walks up to
    /// the nearest ancestor that is really there and checks that one, so a
    /// caller cannot climb out with `..` and cannot be refused for asking about
    /// a folder it is allowed to create.
    fn ensure_new_project_path(&self, path: &str) -> Result<(), String> {
        let Some(workspace) = &self.state.workspace_dir else {
            return Ok(());
        };
        let workspace = std::fs::canonicalize(workspace)
            .map_err(|e| format!("invalid workspace root: {e}"))?;
        let mut candidate = Path::new(path);
        let resolved = loop {
            if let Ok(real) = std::fs::canonicalize(candidate) {
                break real;
            }
            match candidate.parent() {
                Some(parent) => candidate = parent,
                None => return Err("invalid path".into()),
            }
        };
        if resolved.starts_with(&workspace) {
            return Ok(());
        }
        Err("path is outside workspace root".into())
    }

    fn extra_project_parents(&self) -> Vec<String> {
        let mut allowed: Vec<String> = dirs::home_dir()
            .map(|home| vec![home.to_string_lossy().to_string()])
            .unwrap_or_default();
        if let Some(workspace) = &self.state.workspace_dir {
            allowed.push(workspace.to_string_lossy().to_string());
        }
        allowed
    }

    /// This server owns the database, so the record commands read and write the
    /// same rows every other part of it does.
    fn store(&self) -> Option<Arc<boite_core::store::Store>> {
        Some(self.state.store.clone())
    }

    fn pulse_waiters(&self) -> Option<Arc<boite_core::pulse::Waiters>> {
        Some(self.state.pulse.clone())
    }

    /// Which process one of this server's PTYs is running right now, so the
    /// session it holds open is not mistaken for someone else's live one.
    fn child_pid(&self, pty_id: &str) -> Option<u32> {
        self.state.registry.pty_manager().child_pid(pty_id)
    }

    fn transcripts_dir(&self) -> Option<PathBuf> {
        self.state.registry.transcripts_dir()
    }

    fn telemetry(&self) -> Option<Arc<boite_core::telemetry::TelemetryRuntime>> {
        self.state.telemetry.clone()
    }
}

fn ensure_under(root: &Path, path: &str) -> Result<(), String> {
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("invalid workspace root: {e}"))?;
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("invalid path: {e}"))?;
    if canonical.starts_with(root) {
        return Ok(());
    }
    Err("path is outside workspace root".into())
}

/// An `AppState` on a scratch directory, for the tests that drive the real
/// dispatcher rather than a socket.
///
/// Nothing is mocked: a real store, a real registry, a real trust boundary. The
/// point of an in-process test here is that it goes through the same code a
/// client reaches, minus the WebSocket.
#[cfg(test)]
pub fn state_for_test(dir: &Path) -> AppState {
    use std::sync::atomic::AtomicUsize;

    std::fs::create_dir_all(dir).unwrap();
    // The receiver is dropped on purpose: `send` returning Err with no receiver
    // is the ordinary case here and never a failure.
    let (events, _) = tokio::sync::broadcast::channel::<AppEvent>(64);
    let state = AppState {
        store: Arc::new(boite_core::store::Store::open(&dir.join("boite.db")).unwrap()),
        agent_api: None,
        registry: crate::registry::Registry::new_without_ticker(1024, Arc::new(|_| {})),
        auth: crate::auth::Auth::new("test".into()),
        roots: Arc::new(ProjectRoots::default()),
        events,
        notifier: crate::notify::Notifier::from_env(),
        push: crate::push::PushManager::load(dir),
        max_threads: 4,
        max_connections: 4,
        conns: AtomicUsize::new(0),
        devices: Arc::new(AtomicUsize::new(0)),
        workspace_dir: None,
        data_dir: dir.to_path_buf(),
        public_url: None,
        claimed_requests: Default::default(),
        pulse: boite_core::pulse::Waiters::new(),
        telemetry: None,
    };
    // The dispatcher tests drive real calls, and a real call reads the pairing
    // row behind the session that sent it. `Session::for_test` names this one.
    state
        .store
        .add_pairing(
            &boite_core::pairing::Pairing {
                id: "test".into(),
                label: "test".into(),
                kind: "cli".into(),
                scopes: boite_core::pairing::ScopeSet::full(),
                created_at: 1,
                last_seen_at: None,
                revoked_at: None,
            },
            "not-a-secret",
        )
        .unwrap();
    state
}

#[cfg(test)]
mod tests {
    use super::*;
    use boite_core::model::Project;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::broadcast;

    #[test]
    fn refresh_roots_excludes_archived_projects() {
        let dir = std::env::temp_dir().join(format!(
            "boite-state-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let active = dir.join("active");
        let archived = dir.join("archived");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&archived).unwrap();

        let store = Arc::new(Store::open(&dir.join("boite.db")).unwrap());
        store
            .save_project(
                &Project {
                    id: "active".into(),
                    name: "active".into(),
                    cwd: active.to_string_lossy().to_string(),
                    icon: None,
                    archived: false,
                    git_root: None,
                    worktrees: None,
                },
                1,
            )
            .unwrap();
        store
            .save_project(
                &Project {
                    id: "archived".into(),
                    name: "archived".into(),
                    cwd: archived.to_string_lossy().to_string(),
                    icon: None,
                    archived: true,
                    git_root: None,
                    worktrees: None,
                },
                2,
            )
            .unwrap();

        let (events, _) = broadcast::channel::<AppEvent>(1);
        let state = AppState {
            store,
            agent_api: None,
            registry: Registry::new_without_ticker(1024, Arc::new(|_| {})),
            auth: Auth::new("test".into()),
            roots: Arc::new(ProjectRoots::default()),
            events,
            notifier: Notifier::from_env(),
            push: PushManager::load(&dir),
            max_threads: 1,
            max_connections: 1,
            conns: AtomicUsize::new(0),
            devices: Arc::new(AtomicUsize::new(0)),
            workspace_dir: None,
            data_dir: dir.clone(),
            public_url: None,
            claimed_requests: Default::default(),
        pulse: boite_core::pulse::Waiters::new(),
            telemetry: None,
        };

        state.refresh_roots().unwrap();
        assert!(state.roots.ensure_allowed(active.to_str().unwrap()).is_ok());
        assert!(state.roots.ensure_allowed(archived.to_str().unwrap()).is_err());
    }

    #[test]
    fn project_paths_must_stay_under_workspace_root_when_configured() {
        let dir = std::env::temp_dir().join(format!(
            "boite-workspace-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let inside = dir.join("inside");
        let outside = std::env::temp_dir().join(format!("boite-outside-{}", std::process::id()));
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let (events, _) = broadcast::channel::<AppEvent>(1);
        let state = AppState {
            store: Arc::new(Store::open(&dir.join("boite.db")).unwrap()),
            // The path-scope tests spawn nothing, so no agent listener is
            // needed; the None branch is also what a failed bind produces.
            agent_api: None,
            registry: Registry::new_without_ticker(1024, Arc::new(|_| {})),
            auth: Auth::new("test".into()),
            roots: Arc::new(ProjectRoots::default()),
            events,
            notifier: Notifier::from_env(),
            push: PushManager::load(&dir),
            max_threads: 1,
            max_connections: 1,
            conns: AtomicUsize::new(0),
            devices: Arc::new(AtomicUsize::new(0)),
            workspace_dir: Some(dir.clone()),
            data_dir: dir.clone(),
            public_url: None,
            claimed_requests: Default::default(),
        pulse: boite_core::pulse::Waiters::new(),
            telemetry: None,
        };

        assert!(state.ensure_project_path(inside.to_str().unwrap()).is_ok());
        assert!(state.ensure_project_path(outside.to_str().unwrap()).is_err());
    }
}
