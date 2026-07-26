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
use crate::store::Store;

pub struct AppState {
    pub store: Arc<Store>,
    /// None when its listener could not bind: the workspace still runs, agents
    /// simply get no todo access.
    pub agent_api: Option<crate::agent_api::AgentApi>,
    pub registry: Arc<Registry>,
    pub auth: Auth,
    pub roots: ProjectRoots,
    pub events: broadcast::Sender<AppEvent>,
    pub notifier: Notifier,
    pub push: PushManager,
    pub max_threads: usize,
    pub max_connections: usize,
    pub conns: AtomicUsize,
    pub workspace_dir: Option<PathBuf>,
    /// Persisted data dir, used to serve `/.well-known/assetlinks.json` (the
    /// Android TWA Digital Asset Links file, dropped here after the APK build).
    pub data_dir: PathBuf,
}

impl AppState {
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
        self.roots.replace(roots);
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Project;
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
            roots: ProjectRoots::default(),
            events,
            notifier: Notifier::from_env(),
            push: PushManager::load(&dir),
            max_threads: 1,
            max_connections: 1,
            conns: AtomicUsize::new(0),
            workspace_dir: None,
            data_dir: dir.clone(),
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
            roots: ProjectRoots::default(),
            events,
            notifier: Notifier::from_env(),
            push: PushManager::load(&dir),
            max_threads: 1,
            max_connections: 1,
            conns: AtomicUsize::new(0),
            workspace_dir: Some(dir.clone()),
            data_dir: dir.clone(),
        };

        assert!(state.ensure_project_path(inside.to_str().unwrap()).is_ok());
        assert!(state.ensure_project_path(outside.to_str().unwrap()).is_err());
    }
}
