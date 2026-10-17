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
/// WebView2 needs nothing set before its first webview.
pub(crate) fn before_webview() {}

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

/// How long the interactive session has gone without a key or a mouse move.
/// The lock screen gives no input to this session, so a locked PC counts up.
pub(crate) fn idle_ms() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: cbSize names the structure the call fills, which outlives it.
    if unsafe { GetLastInputInfo(&mut info) } == 0 { return None; }
    // SAFETY: no arguments. Both clocks wrap after 49.7 days, the difference does not.
    Some(u64::from(unsafe { GetTickCount() }.wrapping_sub(info.dwTime)))
}

/// Whether the window in front belongs to `window`: itself or a dialog it owns.
/// A webview's own focus can stay true behind other windows; this cannot.
pub(crate) fn foreground(window: &tauri::Window) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOTOWNER};
    let Ok(hwnd) = window.hwnd() else { return false };
    // SAFETY: neither call takes a pointer it keeps; a null foreground (the lock screen) is handled.
    let front = unsafe { GetForegroundWindow() };
    !front.is_null() && unsafe { GetAncestor(front, GA_ROOTOWNER) } == hwnd.0
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

/// Asks WebView2 to trim a page's memory while it is out of sight (`low`):
/// the main page in the tray, a hidden page the user browses. It holds the
/// normal level again before it is shown. Scripts keep running at the low
/// level, so the main page still raises toasts and keeps its connection. A runtime too old for `ICoreWebView2_19` keeps the normal level.
pub(crate) fn memory_level<R: tauri::Runtime>(webview: &tauri::Webview<R>, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;
    let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
    let name = if low { "low" } else { "normal" };
    let queued = webview.with_webview(move |platform| {
        let set = || -> windows::core::Result<()> { unsafe {
            platform.controller().CoreWebView2()?.cast::<ICoreWebView2_19>()?.SetMemoryUsageTargetLevel(level)
        }};
        if let Err(error) = set() {
            crate::shell_log::debug("webview", "shell.webview.memory-level",
                format!("the page's memory level stays as it was, not {name}: {error}"), serde_json::json!({ "level": name }));
        }
    });
    if let Err(error) = queued {
        crate::shell_log::debug("webview", "shell.webview.memory-level",
            format!("the page's memory level stays as it was, not {name}: {error}"), serde_json::json!({ "level": name }));
    }
}

/// Puts a hidden page to sleep, as a sleeping tab: its timers and animations
/// stop and its renderer uses no CPU. The caller lowers its memory level too. WebView2 refuses a visible webview, and
/// wakes the page by itself when it is shown again or navigated; every other
/// call still reaches it asleep. A page that cannot sleep (one playing audio,
/// for instance) keeps running, which is logged.
pub(crate) fn suspend<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    use webview2_com::{Microsoft::Web::WebView2::Win32::ICoreWebView2_3, TrySuspendCompletedHandler};
    use windows::core::Interface;
    let label = webview.label().to_owned();
    let queued = webview.with_webview(move |platform| {
        let failed = label.clone();
        let handler = TrySuspendCompletedHandler::create(Box::new(move |result, slept| {
            if result.is_err() || !slept {
                crate::shell_log::debug("webview", "shell.webview.suspend",
                    format!("the hidden page {label} keeps running: WebView2 did not suspend it ({result:?})"), serde_json::json!({ "label": label }));
            }
            Ok(())
        }));
        let asked = unsafe { platform.controller().CoreWebView2().and_then(|view| view.cast::<ICoreWebView2_3>()).and_then(|view| view.TrySuspend(&handler)) };
        if let Err(error) = asked {
            // Shown again before this ran: a visible webview is not suspended.
            crate::shell_log::debug("webview", "shell.webview.suspend",
                format!("the hidden page {failed} keeps running: {error}"), serde_json::json!({ "label": failed }));
        }
    });
    if let Err(error) = queued {
        crate::shell_log::debug("webview", "shell.webview.suspend", format!("the hidden page could not be suspended: {error}"), serde_json::json!({}));
    }
}
