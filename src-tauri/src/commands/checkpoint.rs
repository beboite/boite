//! Per-turn checkpoints, as the webview asks for them.
//!
//! Codecs, like the git file beside it: the boundary, the work and the refusals
//! are all `boite_core::command::Checkpoints`.

use serde_json::Value;
use tauri::State;

use boite_core::checkpoint::Edge;
use boite_core::command::Checkpoints;
use boite_core::scope::ProjectRoots;

use super::bus::on_bus;

fn edge(raw: &str) -> Result<Edge, String> {
    match raw {
        "start" => Ok(Edge::Start),
        "end" => Ok(Edge::End),
        other => Err(format!("a turn has no {other} edge")),
    }
}

#[tauri::command]
pub async fn checkpoint_capture(
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
    edge_name: String,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Checkpoints::Capture {
            repo,
            thread_id,
            edge: edge(&edge_name)?,
        }
        .into(),
    )
    .await
}

#[tauri::command]
pub async fn checkpoint_list(
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Checkpoints::List { repo, thread_id }.into()).await
}

#[tauri::command]
pub async fn checkpoint_diff(
    scope: State<'_, ProjectRoots>,
    repo: String,
    from: String,
    to: String,
    patch: bool,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Checkpoints::Diff {
            repo,
            from,
            to,
            patch,
        }
        .into(),
    )
    .await
}

#[tauri::command]
pub async fn checkpoint_file_versions(
    scope: State<'_, ProjectRoots>,
    repo: String,
    from: String,
    to: String,
    file: String,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Checkpoints::FileVersions {
            repo,
            from,
            to,
            file,
        }
        .into(),
    )
    .await
}

#[tauri::command]
pub async fn checkpoint_restore(
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
    sha: String,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Checkpoints::Restore {
            repo,
            thread_id,
            sha,
        }
        .into(),
    )
    .await
}

#[tauri::command]
pub async fn checkpoint_forget(
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Checkpoints::Forget { repo, thread_id }.into()).await
}
