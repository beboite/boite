use tauri::{AppHandle, Manager, State, ipc::{Channel, InvokeBody, Request}};

use crate::BootState;
use crate::logging::{self, LogEntry};
use crate::pty::{PtyEvent, PtyManager, PtySpawnArgs};

#[tauri::command]
pub async fn pty_spawn(
    manager: State<'_, PtyManager>,
    on_event: Channel<PtyEvent>,
    spec: PtySpawnArgs,
) -> Result<String, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.spawn(on_event, spec))
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

#[tauri::command]
pub fn toggle_devtools(app: AppHandle) {
    #[cfg(debug_assertions)]
    if let Some(win) = app.get_webview_window("main") {
        if win.is_devtools_open() {
            win.close_devtools();
        } else {
            win.open_devtools();
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
}
