use std::sync::Arc;

use tokio::sync::broadcast;

use boite_core::scope::ProjectRoots;

use crate::auth::Auth;
use crate::events::AppEvent;
use crate::registry::Registry;
use crate::store::Store;

pub struct AppState {
    pub store: Store,
    pub registry: Arc<Registry>,
    pub auth: Auth,
    pub roots: ProjectRoots,
    pub events: broadcast::Sender<AppEvent>,
}

impl AppState {
    /// Rebuild the filesystem trust boundary from the persisted project cwds.
    /// Clients never set roots directly (unlike the desktop webview).
    pub fn refresh_roots(&self) -> Result<(), String> {
        let projects = self.store.load_projects()?;
        let roots = projects.into_iter().map(|p| p.cwd).collect();
        self.roots.replace(roots);
        Ok(())
    }
}
