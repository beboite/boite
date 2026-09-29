//! What closing the main window does: hide it to the tray or quit, as
//! `shell-settings.json` says.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{State, Webview};

use crate::browser;

#[derive(Default, Serialize, Deserialize)]
struct ShellPreferences { close_to_tray: bool }

pub(crate) struct CloseBehavior { pub(crate) enabled: AtomicBool, pub(crate) path: PathBuf }

fn read_close_behavior(path: &Path) -> Result<bool, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<ShellPreferences>(&text).map(|p| p.close_to_tray)
            .map_err(|e| format!("{} must contain a boolean close_to_tray: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{} could not be read: {e}", path.display())),
    }
}

/// `read_close_behavior` for `run()`, which starts before any window exists: a
/// malformed `shell-settings.json` must never take the app down with it. The
/// same default `read_close_behavior` already uses for a missing file, logged
/// rather than turned into a panic, exactly what `read_core_file`'s caller
/// already does for a corrupt `core.json`.
pub(crate) fn close_to_tray_or_default(path: &Path) -> bool {
    match read_close_behavior(path) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[shell] {error}; using the default close behavior (close_to_tray: false)");
            false
        }
    }
}

#[tauri::command]
pub(crate) fn close_behavior(webview: Webview, state: State<'_, CloseBehavior>, enabled: Option<bool>) -> Result<bool, String> {
    browser::only_main(&webview)?;
    if let Some(enabled) = enabled {
        let text = serde_json::to_string(&ShellPreferences { close_to_tray: enabled }).map_err(|e| e.to_string())?;
        let temporary = state.path.with_extension("tmp");
        std::fs::write(&temporary, text).map_err(|e| format!("close behavior could not be saved: {e}"))?;
        std::fs::rename(&temporary, &state.path).map_err(|e| format!("close behavior could not be saved: {e}"))?;
        state.enabled.store(enabled, Ordering::Release);
    }
    Ok(state.enabled.load(Ordering::Acquire))
}

/// Closing the window hides it only where something can bring it back: the
/// tray icon. Without one, a hidden window is a running app nobody can reach.
/// A test shell has no tray and hides anyway, since nobody sees it either way.
pub(crate) fn hides_on_close(close_to_tray: bool, has_tray: bool, test_shell: bool) -> bool {
    close_to_tray && (has_tray || test_shell)
}

#[cfg(test)]
mod tests {
    use super::hides_on_close;

    #[test]
    fn closing_hides_only_where_a_tray_can_bring_the_window_back() {
        assert!(hides_on_close(true, true, false));
        assert!(!hides_on_close(true, false, false), "no tray: a hidden window could never come back");
        assert!(hides_on_close(true, false, true));
        assert!(!hides_on_close(false, true, false));
    }

    // -----------------------------------------------------------------------
    // Finding 6 (security audit) / finding 2 (platform audit, 2026-09-12): a
    // malformed `shell-settings.json` used to panic `run()` before any window
    // existed. `close_to_tray_or_default` must answer a plain bool for all
    // four shapes the file can be in, never an `Err` that only `.expect()` was
    // there to turn into a crash.
    // -----------------------------------------------------------------------

    fn settings_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "boite-shell-settings-{}-{name}.json",
            std::process::id()
        ))
    }

    #[test]
    fn close_behavior_reads_a_valid_file() {
        let path = settings_path("valid");
        std::fs::write(&path, r#"{"close_to_tray":true}"#).unwrap();
        assert_eq!(super::close_to_tray_or_default(&path), true);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn close_behavior_falls_back_to_the_default_on_malformed_json() {
        let path = settings_path("malformed");
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(super::close_to_tray_or_default(&path), false);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn close_behavior_falls_back_to_the_default_on_the_wrong_type() {
        let path = settings_path("wrong-type");
        std::fs::write(&path, r#"{"close_to_tray":"yes"}"#).unwrap();
        assert_eq!(super::close_to_tray_or_default(&path), false);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn close_behavior_falls_back_to_the_default_on_a_missing_file() {
        let path = settings_path("missing");
        let _ = std::fs::remove_file(&path);
        assert_eq!(super::close_to_tray_or_default(&path), false);
    }
}
