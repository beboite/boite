//! Git and worktrees, as the webview asks for them.
//!
//! Twenty-eight commands and not one of them does any work: each names a
//! `boite_core::command::Git` variant and hands over what the webview sent. The
//! boundary is applied once, in `prepare`, and the desktop reads answers bare
//! because the envelopes in `command::Wire` belong to the WebSocket protocol.


use tauri::State;

use serde_json::Value;

use boite_core::capability::Grant;
use boite_core::command::{Command, Git};
use boite_core::scope::ProjectRoots;


use super::bus::{on_bus, through, DesktopHost};

#[tauri::command]
pub async fn git_repo_info(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::RepoInfo { path }.into()).await
}

#[tauri::command]
pub async fn git_find_repos(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::FindRepos { path }.into()).await
}

#[tauri::command]
pub async fn git_branches(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Branches { path }.into()).await
}

#[tauri::command]
pub async fn git_switch_branch(
    scope: State<'_, ProjectRoots>,
    path: String,
    name: String,
    create: bool,
    stash: bool,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Git::SwitchBranch {
            path,
            name,
            create,
            stash,
        }
        .into(),
    )
    .await
}

/// Opens a detached worktree for a thread and hands back its directory, or null
/// when this repository is not one to open a worktree in.
///
/// Traced from end to end, and that is not decoration. A thread waits on this
/// answer before its PTY starts, so an answer that never comes is a black
/// terminal, a reload that does nothing and a thread that cannot be closed —
/// with nothing on screen to say why. Three records tell the three failures
/// apart: no `done` means the work itself is stuck, `done` without the
/// frontend's own line means the reply never crossed back, and a long `done` is
/// simply a large repository being provisioned.
///
/// That is why this one does not go through `on_bus`: the middle record has to
/// be written on the blocking thread, next to the work, rather than after the
/// await where it would say nothing the last record does not.
#[tauri::command]
pub async fn worktree_open(
    app: tauri::AppHandle,
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
) -> Result<Value, String> {
    let traced = thread_id.clone();
    let ready = Command::from(Git::WorktreeOpen { repo, thread_id })
        .prepare(&DesktopHost::new(scope.inner()), Grant::Local)?;
    let handle = app.clone();
    let label = traced.clone();
    let _ = crate::logging::append_app_log(
        &app,
        "info",
        "worktree",
        &format!("{traced}: opening"),
        None,
    );
    let started = std::time::Instant::now();
    let answer = tauri::async_runtime::spawn_blocking(move || {
        let out = ready.run();
        let took = started.elapsed().as_millis();
        // The answer is an object now: a path, or the reason there is none. The
        // reason is the half worth having in a log, since a thread that quietly
        // ran in the project folder is exactly what this line gets read for.
        let said = match &out {
            Ok(value) => match value.get("path").and_then(Value::as_str) {
                Some(path) => format!("{label}: done in {took}ms — {path}"),
                None => {
                    let dirty = value
                        .get("dirty")
                        .and_then(Value::as_array)
                        .map(|names| {
                            names
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    if dirty.is_empty() {
                        format!("{label}: done in {took}ms — no worktree for this repository")
                    } else {
                        format!(
                            "{label}: done in {took}ms — main checkout holds {dirty}, staying in the project folder"
                        )
                    }
                }
            },
            Err(err) => format!("{label}: failed in {took}ms — {err}"),
        };
        let _ = crate::logging::append_app_log(&handle, "info", "worktree", &said, None);
        out
    })
    .await
    .map_err(|e| format!("worktree_open task failed: {e}"))?;
    let _ = crate::logging::append_app_log(
        &app,
        "info",
        "worktree",
        &format!(
            "{traced}: answering after {}ms",
            started.elapsed().as_millis()
        ),
        None,
    );
    answer
}

#[tauri::command]
pub async fn worktree_warm(
    scope: State<'_, ProjectRoots>,
    repo: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeWarm { repo }.into()).await
}

/// Moves a worktree left over from the old layout into its project.
///
/// The legacy base is read here rather than inside the bus because this app is
/// the only thing that knows where its own earlier releases put it, and a data
/// directory it cannot resolve is an error to report rather than a worktree to
/// leave alone.
#[tauri::command]
pub async fn worktree_migrate(
    app: tauri::AppHandle,
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
    from: String,
) -> Result<Value, String> {
    let legacy = crate::app_data::worktree_base(&app)?;
    through(
        DesktopHost::new(scope.inner()).with_legacy_worktree_base(legacy),
        Git::WorktreeMigrate {
            repo,
            thread_id,
            from,
        }
        .into(),
    )
    .await
}

#[tauri::command]
pub async fn worktree_adopt(
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeAdopt { repo, thread_id }.into()).await
}

#[tauri::command]
pub async fn worktree_recognize(
    scope: State<'_, ProjectRoots>,
    repo: String,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeRecognize { repo, path }.into()).await
}

#[tauri::command]
pub async fn worktree_list(
    scope: State<'_, ProjectRoots>,
    repo: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeList { repo }.into()).await
}

#[tauri::command]
pub async fn worktree_claim(
    scope: State<'_, ProjectRoots>,
    path: String,
    name: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeClaim { path, name }.into()).await
}

#[tauri::command]
pub async fn worktree_reserve(
    scope: State<'_, ProjectRoots>,
    path: String,
    name: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeReserve { path, name }.into()).await
}

#[tauri::command]
pub async fn worktree_hold(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeHold { path }.into()).await
}

#[tauri::command]
pub async fn worktree_remove(
    scope: State<'_, ProjectRoots>,
    repo: String,
    path: String,
    force: bool,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeRemove { repo, path, force }.into()).await
}

#[tauri::command]
pub async fn worktree_sizes(
    scope: State<'_, ProjectRoots>,
    paths: Vec<String>,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeSizes { paths }.into()).await
}

#[tauri::command]
pub async fn git_status(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Status { path }.into()).await
}

#[tauri::command]
pub async fn git_changed_paths(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::ChangedPaths { path }.into()).await
}

#[tauri::command]
pub async fn git_commit_state(
    scope: State<'_, ProjectRoots>,
    path: String,
    sha: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::CommitState { path, sha }.into()).await
}

#[tauri::command]
pub async fn git_pull_request(
    scope: State<'_, ProjectRoots>,
    path: String,
    branch: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::PullRequest { path, branch }.into()).await
}

#[tauri::command]
pub async fn git_log(
    scope: State<'_, ProjectRoots>,
    path: String,
    limit: u32,
    skip: u32,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Log { path, limit, skip }.into()).await
}

#[tauri::command]
pub async fn git_stage(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Stage { path, files }.into()).await
}

#[tauri::command]
pub async fn git_unstage(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Unstage { path, files }.into()).await
}

#[tauri::command]
pub async fn git_discard(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
    untracked: Vec<String>,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Git::Discard {
            path,
            files,
            untracked,
        }
        .into(),
    )
    .await
}

#[tauri::command]
pub async fn git_commit(
    scope: State<'_, ProjectRoots>,
    path: String,
    message: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Commit { path, message }.into()).await
}

#[tauri::command]
pub async fn git_fetch(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Fetch { path }.into()).await
}

#[tauri::command]
pub async fn git_push(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Push { path }.into()).await
}

#[tauri::command]
pub async fn git_pull(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Pull { path }.into()).await
}

#[tauri::command]
pub async fn git_init(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Init { path }.into()).await
}

#[tauri::command]
pub async fn git_file_versions(
    scope: State<'_, ProjectRoots>,
    path: String,
    file: String,
    head_file: Option<String>,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Git::FileVersions {
            path,
            file,
            head_file,
        }
        .into(),
    )
    .await
}
