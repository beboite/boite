//! Linux and macOS have no hung-window flag or WebView2 process events: the
//! watchdog's own timing is the whole report there.

pub(crate) fn remember_main_window(_window: &tauri::WebviewWindow) {}

pub(crate) fn main_window_hung() -> Option<bool> { None }

pub(crate) fn remember_main_thread() {}

pub(crate) fn main_thread_id() -> Option<u32> { None }

pub(crate) fn foreign_child_windows() -> Option<Vec<(u32, bool)>> { None }

/// Never called: only a window Windows reports hung asks for a dump.
pub(crate) fn write_dump(_path: &std::path::Path) -> Result<u64, String> {
    Err("hang dumps are written on Windows only".into())
}

pub(crate) fn watch_webview(_window: &tauri::WebviewWindow) {}

/// The OS and, on Linux, the kernel release, for the startup record.
pub(crate) fn os_build() -> (&'static str, String) {
    let release = std::fs::read_to_string("/proc/sys/kernel/osrelease").map(|text| text.trim().to_string()).unwrap_or_default();
    (std::env::consts::OS, release)
}
