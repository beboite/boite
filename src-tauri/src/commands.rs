use tauri::{State, ipc::Channel};

use crate::pty::{PtyEvent, PtyInfo, PtyManager, PtySpawnArgs};

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
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    manager.write(&id, &data)
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
pub fn pty_list(manager: State<'_, PtyManager>) -> Vec<PtyInfo> {
    manager.list()
}
