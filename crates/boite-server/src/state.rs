use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

use tokio::sync::broadcast;

use boite_core::scope::ProjectRoots;

use crate::auth::Auth;
use crate::events::AppEvent;
use crate::notify::Notifier;
use crate::registry::Registry;
use crate::store::Store;

pub struct AppState {
    pub store: Store,
    pub registry: Arc<Registry>,
    pub auth: Auth,
    pub roots: ProjectRoots,
    pub events: broadcast::Sender<AppEvent>,
    pub notifier: Notifier,
    pub max_threads: usize,
    pub max_connections: usize,
    pub conns: AtomicUsize,
    pub workspace_dir: Option<PathBuf>,
}

impl AppState {
    /// Rebuild the filesystem trust boundary from the persisted project cwds,
    /// plus the workspace base dir so the web folder picker can browse it
    /// before any project exists. Clients never set roots directly.
    pub fn refresh_roots(&self) -> Result<(), String> {
        let projects = self.store.load_projects()?;
        let mut roots: Vec<String> = projects.into_iter().map(|p| p.cwd).collect();
        if let Some(dir) = &self.workspace_dir {
            roots.push(dir.to_string_lossy().to_string());
        }
        self.roots.replace(roots);
        Ok(())
    }
}
