//! Where the dev instance keeps its things, and the one identifier this mode
//! is allowed to name.
//!
//! `DEV_IDENTIFIER` is a constant and is never taken from an argument. That is
//! the whole guard: the user's real database, scrollback and window state sit
//! under `com.boite.legacy` and are open while an agent works, so no call
//! reaching this module can be pointed at them.
//!
//! The layout is Tauri's own, the same rule `boite_core::log::desktop_log_dir`
//! states for the release install: `%APPDATA%\<id>` for app data and
//! `%LOCALAPPDATA%\<id>\logs` for the log on Windows, `~/Library/Application
//! Support/<id>` and `~/Library/Logs/<id>` on macOS, the XDG directories
//! elsewhere.

use std::path::PathBuf;

/// The identifier in `src-tauri/tauri.dev-isolated.conf.json`.
pub const DEV_IDENTIFIER: &str = "dev.boite.dev";

/// The file `tauri-plugin-sql` opens for `sqlite:boite.db`, which it resolves
/// against the app data directory.
pub const DEV_DATABASE_FILE: &str = "boite.db";

/// `%APPDATA%\dev.boite.dev` and its equivalents.
pub fn dev_data_dir() -> Result<PathBuf, String> {
    if cfg!(target_os = "macos") {
        return dirs::home_dir()
            .map(|home| home.join("Library/Application Support").join(DEV_IDENTIFIER))
            .ok_or_else(|| "this machine has no home directory".to_string());
    }
    dirs::data_dir()
        .map(|dir| dir.join(DEV_IDENTIFIER))
        .ok_or_else(|| "this machine has no application data directory".to_string())
}

/// The dev instance's SQLite file.
pub fn dev_database() -> Result<PathBuf, String> {
    Ok(dev_data_dir()?.join(DEV_DATABASE_FILE))
}

/// `%LOCALAPPDATA%\dev.boite.dev\logs` and its equivalents.
pub fn dev_log_dir() -> Result<PathBuf, String> {
    if cfg!(target_os = "macos") {
        return dirs::home_dir()
            .map(|home| home.join("Library/Logs").join(DEV_IDENTIFIER))
            .ok_or_else(|| "this machine has no home directory".to_string());
    }
    dirs::data_local_dir()
        .map(|dir| dir.join(DEV_IDENTIFIER).join("logs"))
        .ok_or_else(|| "this machine has no local application data directory".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule this module exists for, asserted rather than trusted to
    /// review: every path it answers is under the dev identifier, and none is
    /// under the user's live install.
    #[test]
    fn every_path_is_the_dev_instances_and_never_the_release_ones() {
        for path in [
            dev_data_dir().expect("data"),
            dev_database().expect("db"),
            dev_log_dir().expect("logs"),
        ] {
            let shown = path.display().to_string();
            assert!(shown.contains(DEV_IDENTIFIER), "{shown}");
            // The identifier the release install ships under today, and the
            // one it shipped under until 1.3.4: a machine can be holding
            // either, and neither is this mode's to touch.
            for release in ["com.boite.legacy", "com.boite.desktop"] {
                assert!(!shown.contains(release), "{shown}");
            }
        }
    }

    #[test]
    fn the_database_is_the_file_the_sql_plugin_opens() {
        let db = dev_database().expect("db");
        assert_eq!(db.file_name().and_then(|n| n.to_str()), Some("boite.db"));
    }
}
