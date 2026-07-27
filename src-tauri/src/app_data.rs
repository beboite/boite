//! Moves the app data directory left behind when the bundle identifier changed.
//!
//! The identifier decides `app_data_dir()`, so renaming it orphans every
//! existing install's database, scrollback and window state in the old folder.
//! This runs before anything opens the database, moves what is there, and never
//! deletes anything it did not successfully move.

use std::path::{Path, PathBuf};

/// The identifier shipped up to 1.0.0. `dev.` was the scaffolding placeholder
/// from `create-tauri-app`, and a trailing `.app` is the extension macOS gives
/// application bundles, which is a poor last component for a bundle id.
pub const LEGACY_IDENTIFIER: &str = "dev.boite.app";

/// The identifier that replaced it, and the only one allowed to inherit its
/// data. Without this check the migration keys on "is there a sibling called
/// `dev.boite.app`", which is true for every build sharing that parent
/// directory — including `dev.boite.dev`, the isolated dev build, whose entire
/// purpose is to not touch the real install.
pub const CURRENT_IDENTIFIER: &str = "com.boite.desktop";

/// What a migration attempt did, so the caller can log it without re-deriving.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No legacy directory: a fresh install, or a migration that already ran.
    Nothing,
    /// Both directories hold a database. The new one wins and the old one is
    /// left untouched for the user to delete, because guessing which of two
    /// real databases to destroy is not a call this code gets to make.
    KeptBoth { legacy: PathBuf },
    Moved { entries: usize, from: PathBuf },
}

/// Moves every entry of `legacy` into `current`, creating `current` if needed.
///
/// Entry by entry rather than renaming the directory itself: `current` may
/// already exist (the log session opens before this on a cold start), and a
/// directory rename onto an existing path fails on every platform.
///
/// Rename only, never copy. Both directories are siblings under one parent, so
/// a rename can never cross a volume here, which leaves exactly one reason for
/// it to fail: something else holds the file open. Copying in that case is the
/// wrong answer — see `move_database_first`.
fn move_entries(legacy: &Path, current: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(current)
        .map_err(|e| format!("could not create {}: {e}", current.display()))?;

    let mut moved = move_database_first(legacy, current)?;
    for entry in std::fs::read_dir(legacy)
        .map_err(|e| format!("could not read {}: {e}", legacy.display()))?
    {
        let entry = entry.map_err(|e| format!("could not read an entry: {e}"))?;
        let to = current.join(entry.file_name());
        // Never clobber: whatever the new directory already has is newer than
        // anything the old one carries.
        if to.exists() {
            continue;
        }
        if std::fs::rename(entry.path(), &to).is_ok() {
            moved += 1;
        }
    }
    // Only ever succeeds when every entry moved, which makes it a check rather
    // than a cleanup: anything left behind keeps the directory alive.
    let _ = std::fs::remove_dir(legacy);
    Ok(moved)
}

/// Moves the three files that make up the database, before anything else and as
/// a unit.
///
/// The rename is also the lock check. Renaming the old identifier changed the
/// single-instance mutex name too, so a 1.0.0 build and this one can run at the
/// same time, and that older build holds `boite.db` open. Windows refuses to
/// rename an open file; copying it instead would duplicate a database being
/// written to and produce a torn snapshot. Failing here and leaving everything
/// where it is costs the user one restart. The alternative costs them data.
fn move_database_first(legacy: &Path, current: &Path) -> Result<usize, String> {
    let db = legacy.join(DB_FILE);
    if !db.exists() {
        return Ok(0);
    }
    std::fs::rename(&db, current.join(DB_FILE)).map_err(|e| {
        format!("could not move {DB_FILE} (is an older Boite still running?): {e}")
    })?;
    let mut moved = 1;
    // The -wal holds committed transactions the .db does not have yet, so it
    // travels with it or the move loses them. The -shm is a rebuildable index;
    // it comes along for tidiness and is not worth failing over.
    for suffix in ["-wal", "-shm"] {
        let name = format!("{DB_FILE}{suffix}");
        let from = legacy.join(&name);
        if from.exists() && std::fs::rename(&from, current.join(&name)).is_ok() {
            moved += 1;
        }
    }
    Ok(moved)
}

/// The database file whose presence marks a directory as a real install.
const DB_FILE: &str = "boite.db";

/// Decides what to do with `legacy` given `current`, then does it.
pub fn migrate(legacy: &Path, current: &Path) -> Result<Outcome, String> {
    if !legacy.is_dir() {
        return Ok(Outcome::Nothing);
    }
    if current.join(DB_FILE).exists() {
        return Ok(Outcome::KeptBoth { legacy: legacy.to_path_buf() });
    }
    let entries = move_entries(legacy, current)?;
    Ok(Outcome::Moved { entries, from: legacy.to_path_buf() })
}

/// Resolves both directories from the running app and migrates between them.
///
/// The legacy directory is the sibling of the current one, since the only thing
/// that changed is the identifier that names it.
pub fn migrate_from_legacy_identifier(app: &tauri::AppHandle) -> Result<Outcome, String> {
    use tauri::Manager;
    let current = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    if current.file_name().and_then(|n| n.to_str()) != Some(CURRENT_IDENTIFIER) {
        return Ok(Outcome::Nothing);
    }
    let Some(parent) = current.parent() else {
        return Ok(Outcome::Nothing);
    };
    migrate(&parent.join(LEGACY_IDENTIFIER), &current)
}

/// Where thread worktrees live: beside the database, never inside a project.
///
/// One directory for all of them, so the filesystem trust boundary gains a
/// single registered root instead of one per worktree read back from storage.
pub fn worktree_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("worktrees"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "boite-appdata-{}-{}-{:?}",
            name,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn a_fresh_install_has_nothing_to_migrate() {
        let root = scratch("fresh");
        let outcome = migrate(&root.join("dev.boite.app"), &root.join("com.boite.desktop"));
        assert_eq!(outcome.unwrap(), Outcome::Nothing);
    }

    #[test]
    fn the_whole_directory_moves_wal_files_included() {
        let root = scratch("move");
        let legacy = root.join("dev.boite.app");
        let current = root.join("com.boite.desktop");
        // A WAL database is three files. Carrying only boite.db across would
        // drop every committed transaction still sitting in the -wal.
        write(&legacy.join("boite.db"), "main");
        write(&legacy.join("boite.db-wal"), "pending");
        write(&legacy.join("boite.db-shm"), "index");
        write(&legacy.join(".window-state.json"), "{}");
        write(&legacy.join("scrollback/thread-1.log"), "hello");

        let outcome = migrate(&legacy, &current).unwrap();
        assert_eq!(outcome, Outcome::Moved { entries: 5, from: legacy.clone() });

        for name in ["boite.db", "boite.db-wal", "boite.db-shm", ".window-state.json"] {
            assert!(current.join(name).is_file(), "{name} did not arrive");
        }
        assert_eq!(
            std::fs::read_to_string(current.join("scrollback/thread-1.log")).unwrap(),
            "hello"
        );
        assert!(!legacy.exists(), "the emptied legacy directory should be gone");
    }

    #[test]
    fn an_existing_new_database_wins_and_the_old_one_is_left_alone() {
        let root = scratch("both");
        let legacy = root.join("dev.boite.app");
        let current = root.join("com.boite.desktop");
        write(&legacy.join("boite.db"), "old");
        write(&current.join("boite.db"), "new");

        let outcome = migrate(&legacy, &current).unwrap();
        assert_eq!(outcome, Outcome::KeptBoth { legacy: legacy.clone() });
        assert_eq!(std::fs::read_to_string(current.join("boite.db")).unwrap(), "new");
        assert_eq!(
            std::fs::read_to_string(legacy.join("boite.db")).unwrap(),
            "old",
            "the legacy database must survive for the user to recover"
        );
    }

    #[test]
    fn the_identifier_that_inherits_is_named_not_inferred() {
        // `dev.boite.dev` is the isolated dev build. It sits in the same parent
        // as the real install, so "the sibling called dev.boite.app" describes
        // the production data directory from its point of view too. Only the
        // identifier that actually replaced the old one may claim it.
        assert_ne!(CURRENT_IDENTIFIER, "dev.boite.dev");
        assert_ne!(CURRENT_IDENTIFIER, LEGACY_IDENTIFIER);
        let conf = include_str!("../tauri.conf.json");
        assert!(
            conf.contains(&format!("\"identifier\": \"{CURRENT_IDENTIFIER}\"")),
            "CURRENT_IDENTIFIER drifted from tauri.conf.json, so the migration \
             would silently stop running"
        );
    }

    #[test]
    fn a_database_that_will_not_move_aborts_before_anything_else_does() {
        // An older build still running holds boite.db open and Windows refuses
        // the rename. Whatever the reason, the rest of the directory must stay
        // put: a scrollback moved away from a database that did not follow is
        // worse than not having started.
        let root = scratch("locked");
        let legacy = root.join("dev.boite.app");
        let current = root.join("com.boite.desktop");
        write(&legacy.join("boite.db"), "main");
        write(&legacy.join("boite.db-wal"), "pending");
        write(&legacy.join("scrollback/thread-1.log"), "hello");
        // A directory where the file must land makes the rename fail on every
        // platform, which is the portable stand-in for a locked file.
        std::fs::create_dir_all(current.join("boite.db")).unwrap();

        let err = move_entries(&legacy, &current).unwrap_err();
        assert!(err.contains("boite.db"), "{err}");
        assert!(legacy.join("boite.db").is_file());
        assert!(legacy.join("boite.db-wal").is_file());
        assert!(legacy.join("scrollback/thread-1.log").is_file());
        assert!(!current.join("scrollback").exists());
    }

    #[test]
    fn a_log_file_written_before_the_move_does_not_block_it() {
        // begin_log_session runs on every start and can create the directory
        // before this does, so `current` existing is the normal case, not an
        // error, and a file it already holds must not be overwritten.
        let root = scratch("partial");
        let legacy = root.join("dev.boite.app");
        let current = root.join("com.boite.desktop");
        write(&legacy.join("boite.db"), "main");
        write(&legacy.join("logs/app.log"), "old log");
        write(&current.join("logs/app.log"), "new log");

        let outcome = migrate(&legacy, &current).unwrap();
        assert_eq!(outcome, Outcome::Moved { entries: 1, from: legacy.clone() });
        assert!(current.join("boite.db").is_file());
        assert_eq!(
            std::fs::read_to_string(current.join("logs/app.log")).unwrap(),
            "new log"
        );
        // The skipped entry keeps the legacy directory alive on purpose.
        assert!(legacy.join("logs/app.log").is_file());
    }
}
