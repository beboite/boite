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

/// A message box, the only thing a process with no window and no console can
/// still show. It blocks until the user closes it.
pub(crate) fn alert(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let wide = |value: &str| value.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (title, text) = (wide(title), wide(text));
    // SAFETY: both buffers are NUL-terminated and outlive the call.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
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
            crate::window::show_main(&handle);
            let _ = handle.emit("notification://open", &thread_id);
            Ok(())
        })
        .show()
        .map_err(|error| format!("the toast {title:?} was refused: {error}"))
}

#[cfg(test)]
mod tests {
    use super::toast_app_id;
    use std::path::Path;

    #[test]
    fn a_toast_carries_the_identifier_once_installed_and_powershells_id_under_target() {
        let id = "com.boite.two";
        assert_eq!(toast_app_id(Path::new(r"C:\Users\x\AppData\Local\Boite"), id), id);
        assert_eq!(toast_app_id(Path::new(r"D:\src\boite\apps\shell\src-tauri\target\release"), id).contains("powershell.exe"), true);
        assert_eq!(toast_app_id(Path::new(r"D:\src\boite\apps\shell\src-tauri\target\debug"), id).contains("powershell.exe"), true);
        // A directory merely named release, not under target, is an install.
        assert_eq!(toast_app_id(Path::new(r"D:\apps\release"), id), id);
    }
}
