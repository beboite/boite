use std::collections::HashSet;
use std::path::PathBuf;

use tauri::{
    AppHandle, Manager, State,
    ipc::{Channel, InvokeBody, Request},
};

use crate::BootState;
use crate::logging::{self, LogEntry};
use crate::pty::{PtyEvent, PtyManager, PtySpawnArgs};

fn scrollback_path(app: &AppHandle, thread_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir failed: {e}"))?;
    Ok(dir.join("scrollback").join(format!("{thread_id}.bin")))
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    on_event: Channel<PtyEvent>,
    spec: PtySpawnArgs,
) -> Result<String, String> {
    let path = scrollback_path(&app, &spec.thread_id).ok();
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.spawn(on_event, spec, path))
        .await
        .map_err(|e| format!("pty spawn task failed: {e}"))?
}

#[tauri::command]
pub fn pty_write(
    manager: State<'_, PtyManager>,
    request: Request<'_>,
) -> Result<(), String> {
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
    id: String,
    wait: Option<bool>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    let wait = wait.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || manager.kill(&id, wait))
        .await
        .map_err(|e| format!("pty kill task failed: {e}"))?
}

#[tauri::command]
pub fn pty_snapshot(
    manager: State<'_, PtyManager>,
    id: String,
) -> Result<Vec<u8>, String> {
    Ok(manager.snapshot_scrollback(&id).unwrap_or_default())
}

#[tauri::command]
pub async fn load_scrollback(
    app: AppHandle,
    thread_id: String,
) -> Result<Vec<u8>, String> {
    let path = scrollback_path(&app, &thread_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    std::fs::read(&path).map_err(|e| format!("read scrollback: {e}"))
}

#[tauri::command]
pub async fn delete_scrollback(
    app: AppHandle,
    thread_id: String,
) -> Result<(), String> {
    let path = scrollback_path(&app, &thread_id)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("delete scrollback: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn prune_orphan_scrollbacks(
    app: AppHandle,
    keep_thread_ids: Vec<String>,
) -> Result<u32, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir failed: {e}"))?
        .join("scrollback");
    if !dir.is_dir() {
        return Ok(0);
    }
    let keep: HashSet<String> = keep_thread_ids.into_iter().collect();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read scrollback dir: {e}"))?;
    let mut pruned = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !keep.contains(stem) {
            if std::fs::remove_file(&path).is_ok() {
                pruned += 1;
            }
        }
    }
    Ok(pruned)
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
