//! What is on disk, and where a project may go.
//!
//! Codecs over `boite_core::command::Files`, plus the two that register the
//! trust boundary itself. `register_project_roots` is what every other command
//! in this file is checked against, which is why it is here rather than beside
//! the projects.


use tauri::{
    AppHandle, Manager, State,
};

use serde_json::Value;

use boite_core::command::{Files, Sessions};
use boite_core::scope::ProjectRoots;


use super::bus::on_bus;

#[tauri::command]
pub fn register_project_roots(
    app: tauri::AppHandle,
    state: State<'_, ProjectRoots>,
    mut roots: Vec<String>,
) {
    // In scope for the worktrees the old layout left behind. A thread's worktree
    // now lives under its own project, which is already a root, but one not yet
    // migrated still has to be readable to be moved. Created here because
    // `replace` canonicalizes and silently drops what does not exist yet.
    if let Ok(base) = crate::app_data::worktree_base(&app) {
        if std::fs::create_dir_all(&base).is_ok() {
            roots.push(base.to_string_lossy().to_string());
        }
    }
    state.replace(roots);
}

/// Where a thread with no project of its own runs, and the default parent for
/// a project that has no path yet.
#[tauri::command]
pub fn home_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("no home directory: {e}"))
}

/// What is already sitting at a path a new project wants.
///
/// Unscoped through the registered roots, like `inspect_project`, and for the
/// same reason: it runs before the folder is anyone's root. Both boundaries and
/// both refusals live on the bus now, so this side and the server cannot answer
/// the question differently.
#[tauri::command]
pub async fn folder_state(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::FolderState { path }.into()).await
}

/// Makes the folder a new project will live in.
#[tauri::command]
pub async fn create_project_folder(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::CreateFolder { path }.into()).await
}

/// What a folder says about itself before it is a project: a name, an icon, a
/// remote.
///
/// Deliberately NOT scoped through `ProjectRoots`, unlike every other
/// path-taking command here: inspection is what produces the name and icon a
/// project is created WITH, so it necessarily runs before that project is a
/// registered root. The desktop has no outer boundary to apply — the user's own
/// folder dialog is it — so what the command can reveal is capped in
/// `boite_core::project` instead: `.git/config` remotes, plus an image from a
/// fixed list of subdirectories, image extensions only, 2 MB max. Keep it that
/// way.
#[tauri::command]
pub async fn inspect_project(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::Inspect { path }.into()).await
}

#[tauri::command]
pub async fn read_dir(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Files::ReadDir { path }.into()).await
}

#[tauri::command]
pub async fn explorer_search(
    scope: State<'_, ProjectRoots>,
    path: String,
    query: String,
    limit: u32,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::Search { path, query, limit }.into()).await
}

/// A whole file, base64, for the window to draw.
///
/// PDFs and images: `read_text_file` refuses them at the first NUL byte, and
/// there is nowhere else for the bytes to come from. The size ceiling lives with
/// the reader in `boite_core::editor`; it is a memory ceiling on the window, not
/// a disk limit.
#[tauri::command]
pub async fn read_file_base64(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::ReadBase64 { path }.into()).await
}

#[tauri::command]
pub async fn read_text_file(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::Read { path }.into()).await
}

#[tauri::command]
pub async fn write_text_file(
    scope: State<'_, ProjectRoots>,
    path: String,
    content: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::Write { path, content }.into()).await
}

#[tauri::command]
pub async fn default_shell(scope: State<'_, ProjectRoots>) -> Result<Value, String> {
    on_bus(scope.inner(), Sessions::ShellDefault.into()).await
}

#[tauri::command]
pub async fn available_shells(
    scope: State<'_, ProjectRoots>,
    refresh: Option<bool>,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Sessions::ShellAvailable {
            refresh: refresh.unwrap_or(false),
        }
        .into(),
    )
    .await
}
