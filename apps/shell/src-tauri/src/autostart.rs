//! Starting Boite when the user signs in, straight into the tray: a machine
//! used for compute gets its core back after a reboot without anyone opening
//! a window. The entry itself is `platform::login`; this decides when it is
//! read, written, and what a start it made looks like.

use tauri::{AppHandle, Manager, Webview};

use crate::browser;
use crate::platform::login::{LoginItem, LOGIN_ARG};
use crate::window::hidden;

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
    use super::{launched_at_login, starts_in_tray};

    fn args(list: &[&str]) -> impl Iterator<Item = std::ffi::OsString> {
        list.iter().map(std::ffi::OsString::from).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn only_the_login_entry_starts_in_the_tray() {
        assert!(launched_at_login(args(&["boite-shell", "--autostart"]), false));
        assert!(!launched_at_login(args(&["boite-shell"]), false), "a launch by hand shows its window");
        assert!(!launched_at_login(args(&["boite-shell", "--autostart"]), true), "the restart after an update shows its window");
        assert!(starts_in_tray(true, true, false));
        assert!(!starts_in_tray(true, false, false), "no tray: a hidden window could never come back");
        assert!(!starts_in_tray(false, true, false));
    }
}
