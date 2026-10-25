//! Starting Boite when the user signs in, straight into the tray: a machine
//! used for compute gets its core back after a reboot without anyone opening
//! a window. The entry itself is `platform::login`; this decides when it is
//! read, written, and what a start it made looks like.

use tauri::{AppHandle, Manager, Webview};

use crate::browser;
use crate::platform::login::{LoginItem, LOGIN_ARG};
use crate::window::hidden;

/// What the Windows installer adds to the shell's arguments when it starts
/// the shell again after an update (`installer.nsi`, `.onInstSuccess`). The
/// updater hands it the arguments the old shell had, `LOGIN_ARG` included, and
/// Windows has no other way to tell the new shell that the restart is the
/// one the user asked for from the window.
pub(crate) const AFTER_UPDATE_ARG: &str = "--after-update";

/// Whether the Windows installer started this process after an update.
pub(crate) fn restarted_by_installer(mut args: impl Iterator<Item = std::ffi::OsString>) -> bool {
    args.any(|arg| arg == AFTER_UPDATE_ARG)
}

/// The file an automatic update leaves in the data directory for the shell it
/// restarts: that shell starts in the tray, as a login start does, since
/// nobody asked for the restart. Written just before the installer runs.
pub(crate) const QUIET_RESTART_FILE: &str = "update-quiet-restart";

/// Whether an automatic update restarted this process. Reading it consumes the
/// file; one older than 15 minutes, left by an install that never restarted,
/// counts for nothing.
pub(crate) fn quiet_restart(directory: &std::path::Path, restarted_after_update: bool) -> bool {
    let path = directory.join(QUIET_RESTART_FILE);
    let fresh = std::fs::metadata(&path).and_then(|meta| meta.modified()).ok()
        .and_then(|written| written.elapsed().ok())
        .is_some_and(|age| age < std::time::Duration::from_secs(15 * 60));
    let _ = std::fs::remove_file(&path);
    restarted_after_update && fresh
}

/// Whether this shell starts in the tray: the login entry started it, or an
/// automatic update restarted it. The marker is read, and so cleared, either way.
pub(crate) fn starts_unasked(args: impl Iterator<Item = std::ffi::OsString>, directory: &std::path::Path, restarted_after_update: bool) -> bool {
    let quiet = quiet_restart(directory, restarted_after_update);
    launched_at_login(args, restarted_after_update) || quiet
}

/// Whether this process is the one the login entry started. A restart after
/// an update keeps the original arguments, and that one is the user's own
/// action: its window comes back.
pub(crate) fn launched_at_login(mut args: impl Iterator<Item = std::ffi::OsString>, restarted_after_update: bool) -> bool {
    !restarted_after_update && args.any(|arg| arg == LOGIN_ARG)
}

/// The window stays in the tray only where the tray can bring it back. A test
/// shell never shows a window in the first place.
pub(crate) fn starts_in_tray(launched_at_login: bool, has_tray: bool, test_shell: bool) -> bool {
    launched_at_login && has_tray && !test_shell
}

/// Reads, and with `enabled`, sets whether this executable starts at login.
/// A test shell (`BOITE_SHELL_HIDDEN=1`) reads but never writes: its entry
/// would replace the installed app's under the same name.
#[tauri::command]
pub(crate) fn launch_at_login(app: AppHandle, webview: Webview, enabled: Option<bool>) -> Result<bool, String> {
    browser::only_main(&webview)?;
    let item = app.try_state::<LoginItem>()
        .ok_or("the shell's own executable path is unknown, so it cannot start at login")?;
    if let Some(enabled) = enabled {
        if hidden() {
            return Err("a test shell (BOITE_SHELL_HIDDEN=1) does not change the login entry".into());
        }
        item.set(enabled)?;
    }
    item.enabled()
}

#[cfg(test)]
mod tests {
    use super::{launched_at_login, quiet_restart, restarted_by_installer, starts_in_tray, starts_unasked, QUIET_RESTART_FILE};

    fn args(list: &[&str]) -> impl Iterator<Item = std::ffi::OsString> {
        list.iter().map(std::ffi::OsString::from).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn only_the_login_entry_starts_in_the_tray() {
        assert!(launched_at_login(args(&["boite-shell", "--autostart"]), false));
        assert!(!launched_at_login(args(&["boite-shell"]), false), "a launch by hand shows its window");
        assert!(!launched_at_login(args(&["boite-shell", "--autostart"]), true), "the restart after an update shows its window");
        assert!(starts_in_tray(true, true, false));
        assert!(restarted_by_installer(args(&["boite-shell", "--autostart", "--after-update"])),
            "Windows restarts with the login argument still there");
        assert!(!restarted_by_installer(args(&["boite-shell", "--autostart"])));
        assert!(!starts_in_tray(true, false, false), "no tray: a hidden window could never come back");
        assert!(!starts_in_tray(false, true, false));
    }

    #[test]
    fn an_automatic_update_restarts_into_the_tray_once() {
        let directory = std::env::temp_dir().join(format!("boite-quiet-restart-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        assert!(!quiet_restart(&directory, true), "an update the user asked for shows its window");
        std::fs::write(directory.join(QUIET_RESTART_FILE), "").unwrap();
        assert!(!quiet_restart(&directory, false), "a launch by hand is not the restart");
        assert!(!directory.join(QUIET_RESTART_FILE).exists(), "a launch by hand still clears it");
        std::fs::write(directory.join(QUIET_RESTART_FILE), "").unwrap();
        assert!(quiet_restart(&directory, true));
        assert!(!quiet_restart(&directory, true), "only the first restart reads it");
        // A login start clears a marker left by an install that never restarted.
        std::fs::write(directory.join(QUIET_RESTART_FILE), "").unwrap();
        assert!(starts_unasked([std::ffi::OsString::from(super::LOGIN_ARG)].into_iter(), &directory, false));
        assert!(!directory.join(QUIET_RESTART_FILE).exists(), "a login start leaves no marker behind");
        let _ = std::fs::remove_dir_all(&directory);
    }
}
