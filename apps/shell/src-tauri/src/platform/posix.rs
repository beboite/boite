use std::process::Command;
use tauri::AppHandle;

pub(crate) fn prepare_command(_command: &mut Command) {}

pub(crate) fn notify(_app: AppHandle, _title: String, _body: String, _thread_id: String) -> Result<(), String> {
    Err("no system toast on this platform yet".to_string())
}
