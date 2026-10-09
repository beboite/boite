//! OS integration. The shell's orchestration and IPC authorization stay outside it.
mod paths;
mod local_paths;
pub(crate) use local_paths::require_local_path;
pub(crate) use paths::default_data_dir;

#[cfg(target_os = "macos")]
pub(crate) mod macos_window;

#[cfg(windows)]
#[path = "windows_job.rs"]
pub(crate) mod job;
#[cfg(not(windows))]
#[path = "posix_job.rs"]
pub(crate) mod job;

#[cfg(windows)]
#[path = "windows_process.rs"]
pub(crate) mod process;
#[cfg(not(windows))]
#[path = "posix_process.rs"]
pub(crate) mod process;

#[cfg(windows)]
pub(crate) mod dwm;
#[cfg(windows)]
pub(crate) mod windows;
#[cfg(windows)]
pub(crate) use windows::{alert, before_webview, foreground, idle_ms, notify, prepare_command};
#[cfg(not(windows))]
mod posix;
#[cfg(not(windows))]
pub(crate) use posix::{alert, before_webview, foreground, idle_ms, notify, prepare_command};

pub(crate) mod appbars;
pub(crate) mod media;
#[cfg(windows)]
pub(crate) mod browser_control;
#[cfg(windows)]
pub(crate) mod browser_diagnostics;
#[cfg(windows)]
pub(crate) mod browser_page;
#[cfg(windows)]
pub(crate) mod browser_screencast;
#[cfg(windows)]
pub(crate) mod webview_profiles;
pub(crate) mod login;
pub(crate) mod region;

pub(crate) fn open_file(path: &std::path::Path) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|error| format!("path {}: {error}", path.display()))
}
