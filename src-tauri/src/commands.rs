use tauri::{AppHandle, Manager, State, ipc::{Channel, InvokeBody, Request}};

use crate::BootState;
use crate::pty::{PtyEvent, PtyManager, PtySpawnArgs};

#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    on_event: Channel<PtyEvent>,
    spec: PtySpawnArgs,
) -> Result<String, String> {
    manager.spawn(on_event, spec)
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
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.kill(&id)
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
