use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use tauri::{
    AppHandle, Manager, State,
    ipc::{Channel, InvokeBody, Request},
};

use boite_core::editor::TextFile;
use boite_core::explorer::{DirEntry, SearchHit};
use boite_core::git::{ChangeEntry, Commit, FileVersions, PathStatus, RepoInfo};
use boite_core::project::ProjectInspection;
use boite_core::pty::{EventSink, PtyEvent, PtyManager, PtySpawnArgs};
use boite_core::scope::ProjectRoots;
use boite_core::session::{ClaudeSessionHit, CodexSessionHit};
use boite_core::shell::ShellOption;
use boite_core::{editor, explorer, git, project, session, shell};

use crate::BootState;
use crate::local_pty::{LocalSessions, LocalSink};
use crate::logging::{self, LogEntry};

// Wire shape consumed by the webview xterm bridge. Output is base64-encoded
// here (not in core): a Vec<u8> would serialize as a JSON number array,
// ~4x the payload plus an expensive per-chunk parse webview-side.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WirePtyEvent {
    Output { data: String },
    Title { value: String },
    Exit { code: Option<i32> },
    Error { message: String },
}

// Adapts the core EventSink onto a Tauri IPC channel.
struct ChannelSink {
    channel: Channel<WirePtyEvent>,
}

impl EventSink for ChannelSink {
    fn send(&self, event: PtyEvent) -> bool {
        let wire = match event {
            PtyEvent::Output(bytes) => WirePtyEvent::Output {
                data: BASE64.encode(&bytes),
            },
            PtyEvent::Title(value) => WirePtyEvent::Title { value },
            PtyEvent::Exit(code) => WirePtyEvent::Exit { code },
            PtyEvent::Error(message) => WirePtyEvent::Error { message },
        };
        self.channel.send(wire).is_ok()
    }
}

#[tauri::command]
pub async fn pty_spawn(
    manager: State<'_, PtyManager>,
    on_event: Channel<WirePtyEvent>,
    spec: PtySpawnArgs,
) -> Result<String, String> {
    let manager = manager.inner().clone();
    let sink: Arc<dyn EventSink> = Arc::new(ChannelSink { channel: on_event });
    tauri::async_runtime::spawn_blocking(move || manager.spawn(sink, spec))
        .await
        .map_err(|e| format!("pty spawn task failed: {e}"))?
}

// Attach-or-spawn keyed by thread id. Reattaches to a still-alive detached PTY
// (replaying its scrollback ring and resizing to repaint) so local processes
// survive a workspace switch; otherwise spawns a fresh process.
#[tauri::command]
pub async fn pty_open(
    manager: State<'_, PtyManager>,
    sessions: State<'_, LocalSessions>,
    thread_id: String,
    on_event: Channel<WirePtyEvent>,
    spec: PtySpawnArgs,
) -> Result<String, String> {
    let manager = manager.inner().clone();
    let sessions = sessions.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some((pty_id, sink)) = sessions.get(&thread_id) {
            if manager.is_alive(&pty_id) {
                sink.set_channel(Some(on_event));
                sink.replay();
                let _ = manager.resize(&pty_id, spec.cols, spec.rows);
                return Ok(pty_id);
            }
            sessions.remove_by_pty(&pty_id);
        }
        let sink = Arc::new(LocalSink::new(on_event));
        let pty_id = manager.spawn(sink.clone(), spec)?;
        sessions.insert(thread_id, pty_id.clone(), sink);
        Ok(pty_id)
    })
    .await
    .map_err(|e| format!("pty open task failed: {e}"))?
}

// Detach (do not kill): drop the channel but keep the child + reader alive and
// buffering, so a later pty_open reattaches.
#[tauri::command]
pub fn pty_detach(sessions: State<'_, LocalSessions>, id: String) -> Result<(), String> {
    sessions.detach_by_pty(&id);
    Ok(())
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-pty-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing x-pty-id header".to_string())?;
    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(b) => b.as_slice(),
        InvokeBody::Json(_) => return Err("expected raw body".into()),
    };
    manager.write(id, bytes)
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&id, cols, rows)
}

#[tauri::command]
pub async fn pty_kill(
    manager: State<'_, PtyManager>,
    sessions: State<'_, LocalSessions>,
    id: String,
    wait: Option<bool>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    let sessions = sessions.inner().clone();
    let wait = wait.unwrap_or(true);
    let pty_id = id.clone();
    let res = tauri::async_runtime::spawn_blocking(move || manager.kill(&id, wait))
        .await
        .map_err(|e| format!("pty kill task failed: {e}"))?;
    sessions.remove_by_pty(&pty_id);
    res
}

#[tauri::command]
pub fn register_project_roots(state: State<'_, ProjectRoots>, roots: Vec<String>) {
    state.replace(roots);
}

#[tauri::command]
pub async fn inspect_project(path: String) -> Result<ProjectInspection, String> {
    tauri::async_runtime::spawn_blocking(move || project::inspect_project_blocking(path))
        .await
        .map_err(|e| format!("inspect_project task failed: {e}"))?
}

#[tauri::command]
pub async fn read_dir(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || explorer::read_dir_blocking(path))
        .await
        .map_err(|e| format!("read_dir task failed: {e}"))?
}

#[tauri::command]
pub async fn explorer_search(
    scope: State<'_, ProjectRoots>,
    path: String,
    query: String,
    limit: u32,
) -> Result<Vec<SearchHit>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || explorer::search_blocking(&path, &query, limit))
        .await
        .map_err(|e| format!("explorer_search task failed: {e}"))?
}

#[tauri::command]
pub async fn read_text_file(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<TextFile, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || editor::read_blocking(&path))
        .await
        .map_err(|e| format!("read_text_file task failed: {e}"))?
}

#[tauri::command]
pub async fn write_text_file(
    scope: State<'_, ProjectRoots>,
    path: String,
    content: String,
) -> Result<u64, String> {
    scope.ensure_allowed_for_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || editor::write_blocking(&path, &content))
        .await
        .map_err(|e| format!("write_text_file task failed: {e}"))?
}

#[tauri::command]
pub async fn default_shell() -> String {
    tauri::async_runtime::spawn_blocking(shell::default_shell_blocking)
        .await
        .unwrap_or_else(|_| shell::fallback_shell())
}

#[tauri::command]
pub async fn available_shells() -> Vec<ShellOption> {
    tauri::async_runtime::spawn_blocking(shell::available_shells_blocking)
        .await
        .unwrap_or_default()
}

async fn run_lookup<F>(f: F) -> Option<String>
where
    F: FnOnce() -> Option<String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.ok().flatten()
}

#[tauri::command]
pub async fn find_claude_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<ClaudeSessionHit> {
    let exclude = session::build_exclude(exclude_ids);
    tauri::async_runtime::spawn_blocking(move || {
        session::find_claude_session_blocking(cwd, after_unix_ms, &exclude)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn find_codex_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<CodexSessionHit> {
    let exclude = session::build_exclude(exclude_ids);
    tauri::async_runtime::spawn_blocking(move || {
        session::find_codex_session_blocking(cwd, after_unix_ms, &exclude)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn find_opencode_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_opencode_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_cursor_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_cursor_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_antigravity_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_antigravity_session_blocking(cwd, after_unix_ms, &exclude))
        .await
}

#[tauri::command]
pub async fn find_copilot_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_copilot_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_grok_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_grok_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_hermes_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_hermes_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn git_repo_info(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<RepoInfo, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::repo_info_blocking(&path))
        .await
        .map_err(|e| format!("git_repo_info task failed: {e}"))?
}

#[tauri::command]
pub async fn git_status(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Vec<ChangeEntry>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::status_blocking(&path))
        .await
        .map_err(|e| format!("git_status task failed: {e}"))?
}

#[tauri::command]
pub async fn git_changed_paths(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Vec<PathStatus>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::changed_paths_blocking(&path))
        .await
        .map_err(|e| format!("git_changed_paths task failed: {e}"))?
}

#[tauri::command]
pub async fn git_log(
    scope: State<'_, ProjectRoots>,
    path: String,
    limit: u32,
    skip: u32,
) -> Result<Vec<Commit>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::log_blocking(&path, limit, skip))
        .await
        .map_err(|e| format!("git_log task failed: {e}"))?
}

#[tauri::command]
pub async fn git_stage(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::run_files(&path, "add", &files, true))
        .await
        .map_err(|e| format!("git_stage task failed: {e}"))?
}

#[tauri::command]
pub async fn git_unstage(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::unstage_blocking(&path, files))
        .await
        .map_err(|e| format!("git_unstage task failed: {e}"))?
}

#[tauri::command]
pub async fn git_discard(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::discard_blocking(&path, files, untracked))
        .await
        .map_err(|e| format!("git_discard task failed: {e}"))?
}

#[tauri::command]
pub async fn git_commit(
    scope: State<'_, ProjectRoots>,
    path: String,
    message: String,
) -> Result<String, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::commit_blocking(&path, &message))
        .await
        .map_err(|e| format!("git_commit task failed: {e}"))?
}

#[tauri::command]
pub async fn git_fetch(scope: State<'_, ProjectRoots>, path: String) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::fetch_blocking(&path))
        .await
        .map_err(|e| format!("git_fetch task failed: {e}"))?
}

#[tauri::command]
pub async fn git_push(scope: State<'_, ProjectRoots>, path: String) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::push_blocking(&path))
        .await
        .map_err(|e| format!("git_push task failed: {e}"))?
}

#[tauri::command]
pub async fn git_pull(scope: State<'_, ProjectRoots>, path: String) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::pull_blocking(&path))
        .await
        .map_err(|e| format!("git_pull task failed: {e}"))?
}

#[tauri::command]
pub async fn git_init(scope: State<'_, ProjectRoots>, path: String) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::init_blocking(&path))
        .await
        .map_err(|e| format!("git_init task failed: {e}"))?
}

#[tauri::command]
pub async fn git_file_versions(
    scope: State<'_, ProjectRoots>,
    path: String,
    file: String,
    head_file: Option<String>,
) -> Result<FileVersions, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::file_versions_blocking(&path, &file, head_file.as_deref())
    })
    .await
    .map_err(|e| format!("git_file_versions task failed: {e}"))?
}

#[tauri::command]
pub fn finish_boot(app: AppHandle, boot: State<'_, BootState>) {
    if !boot.mark_completed() {
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
pub fn log_app_event(
    app: AppHandle,
    level: String,
    source: String,
    message: String,
    details: Option<String>,
) -> Result<(), String> {
    logging::append_app_log(&app, &level, &source, &message, details.as_deref())
}

#[tauri::command]
pub fn read_app_log(app: AppHandle, scope: String) -> Result<Vec<LogEntry>, String> {
    let path = match scope.as_str() {
        "previous" => logging::previous_log_file_path(&app)?,
        _ => logging::log_file_path(&app)?,
    };
    logging::read_log_file(&path)
}

#[tauri::command]
pub fn clear_app_log(app: AppHandle) -> Result<(), String> {
    logging::clear_log(&app)
}

#[tauri::command]
pub fn log_file_path(app: AppHandle) -> Result<String, String> {
    let path = logging::log_file_path(&app)?;
    Ok(path.to_string_lossy().to_string())
}
