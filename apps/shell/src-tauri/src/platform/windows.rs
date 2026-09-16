use std::path::Path;
use std::process::Command;
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter};

pub(crate) fn prepare_command(command: &mut Command) {
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

/// The AppUserModelID a toast is shown under. An installed Boite has a Start
/// menu shortcut carrying the bundle identifier, which is what Windows needs
/// to show a toast at all; an executable still under `target/` has none, and
/// PowerShell's id is the one that works there, at the cost of the toast
/// naming PowerShell as its source.
pub(crate) fn toast_app_id(exe_dir: &Path, identifier: &str) -> String {
    let profile = matches!(exe_dir.file_name().and_then(|name| name.to_str()), Some("debug" | "release"));
    let under_target = exe_dir.parent().and_then(|parent| parent.file_name()) == Some(std::ffi::OsStr::new("target"));
    if profile && under_target {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
    } else {
        identifier.to_string()
    }
}

pub(crate) fn notify(app: AppHandle, title: String, body: String, thread_id: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| format!("the shell executable is unknown: {error}"))?;
    let exe_dir = exe.parent().ok_or_else(|| "the shell executable has no directory".to_string())?;
    let app_id = toast_app_id(exe_dir, &app.config().identifier);
    let handle = app.clone();
    tauri_winrt_notification::Toast::new(&app_id)
        .title(&title)
        .text1(&body)
        .on_activated(move |_| {
            crate::show_main(&handle);
            let _ = handle.emit("notification://open", &thread_id);
            Ok(())
        })
        .show()
        .map_err(|error| format!("the toast {title:?} was refused: {error}"))
}
