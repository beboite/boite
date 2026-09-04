//! Moves the directories left behind when the bundle identifier changed.
//!
//! The identifier decides `app_data_dir()`, so renaming it orphans every
//! existing install's database, scrollback and window state in the old folder.
//! This runs before anything opens the database, moves what is there, and never
//! deletes anything it did not successfully move.
//!
//! "Before anything opens the database" is the load-bearing part, and it is why
//! this runs ahead of `tauri::Builder` rather than from the app's `setup` hook.
//! Plugin setup hooks run first, and `tauri.conf.json` preloads `sqlite:boite.db`
//! for the frontend's `Database.get`: by the time an app-level hook is called,
//! the sql plugin has already created an empty database at the new identifier.
//! The migration then found a database there, refused to overwrite it, and left
//! a real install stranded in the old directory. That shipped in 1.0.0.
//!
//! Two identifiers came before the current one, so this walks a chain and not a
//! pair: `dev.boite.app` up to 1.0.0, `com.boite.desktop` up to 1.3.4,
//! `com.boite.legacy` from 1.4.0. Each predecessor migrates into the current
//! identifier, most recent first, and the never-clobber rule settles the rest:
//! once `com.boite.desktop` has moved in, `dev.boite.app` finds a database at
//! the destination and is kept where it is.
//!
//! The data directory is not the only thing an identifier names. The webview
//! keeps the frontend's `localStorage` (pane layouts, device settings, thread
//! renames) somewhere else entirely, under the identifier too: in
//! `%LOCALAPPDATA%\<id>` on Windows, next to the logs, and in
//! `~/Library/WebKit/<id>` on macOS. Those move as well, best effort. Losing
//! them costs a layout, and no failure there is worth refusing to start over.

use std::path::{Path, PathBuf};

/// Every identifier this app shipped under before the current one, most recent
/// first, which is the order they inherit in.
///
/// `com.boite.desktop` shipped from 1.0.1 to 1.3.4. `dev.boite.app` shipped up
/// to 1.0.0: `dev.` was the scaffolding placeholder from `create-tauri-app`,
/// and a trailing `.app` is the extension macOS gives application bundles,
/// which is a poor last component for a bundle id.
pub const PREDECESSOR_IDENTIFIERS: [&str; 2] = ["com.boite.desktop", "dev.boite.app"];

/// The identifier 1.4.0 ships under, and the only one allowed to inherit a
/// predecessor's data. Without this check the migration keys on "is there a
/// sibling called `com.boite.desktop`", which is true for every build sharing
/// that parent directory, including `dev.boite.dev`, the isolated dev build,
/// whose entire purpose is to not touch the real install.
pub const CURRENT_IDENTIFIER: &str = "com.boite.legacy";

/// What a migration attempt did, so the caller can log it without re-deriving.
///
/// One value per directory that was looked at, which is why a start returns a
/// list of them: three identifiers and, on Windows and macOS, a second
/// directory per identifier.
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
/// wrong answer, see `move_database_first`.
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

/// Migrates a directory that carries state but no database.
///
/// Same rules as the data directory: rename only, entry by entry, never
/// clobber, never delete what did not move. Separate from `migrate` because
/// the question `migrate` asks first does not apply here: there is no database
/// to arbitrate, so there is no reason to keep both.
fn migrate_entry_by_entry(from: &Path, to: &Path) -> Result<Outcome, String> {
    if !from.is_dir() {
        return Ok(Outcome::Nothing);
    }
    let entries = move_entries(from, to)?;
    Ok(Outcome::Moved { entries, from: from.to_path_buf() })
}

/// Migrates a directory by renaming the directory itself.
///
/// For `~/Library/WebKit/<id>`, which WKWebView creates the first time a window
/// loads a page. That is well after this runs, so the current identifier has
/// nothing there yet and the whole directory moves in one call. If something
/// did create it, it wins and this does nothing, which is the never-clobber
/// rule applied to a directory instead of a file.
///
/// `entries` counts what the directory held at the top level, so the number
/// means the same thing in a log line as the ones the other moves report.
fn migrate_by_rename(from: &Path, to: &Path) -> Result<Outcome, String> {
    if !from.is_dir() || to.exists() {
        return Ok(Outcome::Nothing);
    }
    let entries = std::fs::read_dir(from).map(Iterator::count).unwrap_or(0);
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    std::fs::rename(from, to).map_err(|e| {
        format!("could not move {} to {}: {e}", from.display(), to.display())
    })?;
    Ok(Outcome::Moved { entries, from: from.to_path_buf() })
}

/// `%LOCALAPPDATA%\<id>` and where it goes, on the one platform where it is a
/// directory of its own.
///
/// It holds `EBWebView`, the WebView2 profile carrying the frontend's
/// `localStorage`, and the log directory. On Linux `data_local_dir()` is
/// `data_dir()`, and on macOS both are `~/Library/Application Support`, so
/// everywhere else this is the directory the data move already handled.
fn local_data_directories(predecessor: &str) -> Option<(PathBuf, PathBuf)> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let root = dirs::data_local_dir()?;
    Some((root.join(predecessor), root.join(CURRENT_IDENTIFIER)))
}

/// `~/Library/WebKit/<id>` and where it goes, on macOS only.
///
/// WKWebView's website data store, which is where the frontend's
/// `localStorage` lives on that platform. Nothing under it is reachable from
/// the data directory, so an identifier rename loses it unless it moves too.
fn webkit_directories(predecessor: &str) -> Option<(PathBuf, PathBuf)> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let root = dirs::home_dir()?.join("Library/WebKit");
    Some((root.join(predecessor), root.join(CURRENT_IDENTIFIER)))
}

/// Records a move that was worth attempting and is never worth a failed start.
///
/// The webview profile and the logs are in this class: the app opens on an
/// install that has its database either way, and the log session that would
/// carry the error properly does not exist yet.
fn record_best_effort(done: &mut Vec<Outcome>, attempt: Result<Outcome, String>) {
    match attempt {
        Ok(Outcome::Nothing) => {}
        Ok(outcome) => done.push(outcome),
        Err(e) => eprintln!("[boite/appdata] {e}"),
    }
}

/// Resolves every directory a predecessor could still hold and migrates them.
///
/// Called before `tauri::Builder`, so `app_data_dir()` is not available yet and
/// the paths are derived the same way Tauri derives them: the platform
/// directory plus the bundle identifier. A test pins `CURRENT_IDENTIFIER`
/// against `tauri.conf.json`, which is what keeps the two definitions honest.
///
/// A predecessor's directory is the sibling of the current one, since the only
/// thing that changed is the identifier that names it. The answer holds one
/// outcome per directory that did something, in the order the moves happened,
/// and is empty when there was nothing to move.
pub fn migrate_before_plugins(identifier: &str) -> Result<Vec<Outcome>, String> {
    if identifier != CURRENT_IDENTIFIER {
        return Ok(Vec::new());
    }
    let Some(data_root) = dirs::data_dir() else {
        return Ok(Vec::new());
    };
    let current = data_root.join(CURRENT_IDENTIFIER);
    let mut done = Vec::new();
    for predecessor in PREDECESSOR_IDENTIFIERS {
        // The data directory first and on its own error path: it carries the
        // database, and that is the one move worth giving up the start for.
        match migrate(&data_root.join(predecessor), &current)? {
            Outcome::Nothing => {}
            outcome => done.push(outcome),
        }
        if let Some((from, to)) = local_data_directories(predecessor) {
            record_best_effort(&mut done, migrate_entry_by_entry(&from, &to));
        }
        if let Some((from, to)) = webkit_directories(predecessor) {
            record_best_effort(&mut done, migrate_by_rename(&from, &to));
        }
    }
    Ok(done)
}

/// Where thread worktrees used to live: beside the database.
///
/// They live in their own project now, under `worktree_base_for`, because
/// neither a clone nor a hard link crosses a volume and a base on a different
/// drive from the projects meant every worktree recompiled and paid full disk
/// for its own build output.
///
/// This is what a worktree is migrated *out of*, and what a source path is
/// checked against before anything moves, so it stays for as long as an install
/// can still be carrying one. `BOITE_WORKTREE_BASE` moves it, which matters
/// here only for finding worktrees an earlier run put somewhere else.
pub fn worktree_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    if let Some(base) = std::env::var("BOITE_WORKTREE_BASE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return Ok(PathBuf::from(base));
    }
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

    /// The chain a real start walks, over a root a test owns.
    ///
    /// `migrate_before_plugins` resolves `dirs::data_dir()`, which on this
    /// machine is the user's live install, so the loop is what a test can
    /// exercise: the same constants, in the same order, under a scratch root.
    fn migrate_chain(root: &Path) -> Vec<Outcome> {
        let current = root.join(CURRENT_IDENTIFIER);
        PREDECESSOR_IDENTIFIERS
            .iter()
            .map(|id| migrate(&root.join(id), &current).unwrap())
            .collect()
    }

    #[test]
    fn a_fresh_install_has_nothing_to_migrate() {
        let root = scratch("fresh");
        assert_eq!(migrate_chain(&root), vec![Outcome::Nothing, Outcome::Nothing]);
        assert!(!root.join(CURRENT_IDENTIFIER).exists());
    }

    #[test]
    fn isolated_builds_do_not_migrate_production_data() {
        for identifier in ["dev.boite.dev", "dev.boite.chat-preview"] {
            assert!(migrate_before_plugins(identifier).unwrap().is_empty());
        }
    }

    #[test]
    fn the_whole_directory_moves_wal_files_included() {
        let root = scratch("move");
        let legacy = root.join("com.boite.desktop");
        let current = root.join("com.boite.legacy");
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
    fn an_install_from_before_1_0_1_still_moves() {
        // Nobody upgraded it in between, so `dev.boite.app` reaches 1.4.0 with
        // its database and skips the identifier that came between the two.
        let root = scratch("oldest");
        let legacy = root.join("dev.boite.app");
        write(&legacy.join("boite.db"), "ancient");

        let outcomes = migrate_chain(&root);
        assert_eq!(
            outcomes,
            vec![Outcome::Nothing, Outcome::Moved { entries: 1, from: legacy.clone() }]
        );
        assert_eq!(
            std::fs::read_to_string(root.join(CURRENT_IDENTIFIER).join("boite.db")).unwrap(),
            "ancient"
        );
    }

    #[test]
    fn the_most_recent_predecessor_wins_and_the_older_one_is_kept() {
        // Both directories survived, which is what 1.0.1 leaves behind when it
        // found a database at either end. The chain moves the recent one in
        // first, and the older one then meets a database at the destination.
        let root = scratch("chain");
        let desktop = root.join("com.boite.desktop");
        let oldest = root.join("dev.boite.app");
        let current = root.join(CURRENT_IDENTIFIER);
        write(&desktop.join("boite.db"), "recent");
        write(&oldest.join("boite.db"), "ancient");

        let outcomes = migrate_chain(&root);
        assert_eq!(
            outcomes,
            vec![
                Outcome::Moved { entries: 1, from: desktop.clone() },
                Outcome::KeptBoth { legacy: oldest.clone() },
            ]
        );
        assert_eq!(std::fs::read_to_string(current.join("boite.db")).unwrap(), "recent");
        assert_eq!(
            std::fs::read_to_string(oldest.join("boite.db")).unwrap(),
            "ancient",
            "the older database must survive for the user to recover"
        );
    }

    #[test]
    fn an_existing_new_database_wins_and_the_old_one_is_left_alone() {
        let root = scratch("both");
        let legacy = root.join("com.boite.desktop");
        let current = root.join("com.boite.legacy");
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
        // as the real install, so "the sibling called com.boite.desktop"
        // describes the production data directory from its point of view too.
        // Only the identifier that actually replaced the old one may claim it.
        assert_ne!(CURRENT_IDENTIFIER, "dev.boite.dev");
        for predecessor in PREDECESSOR_IDENTIFIERS {
            assert_ne!(CURRENT_IDENTIFIER, predecessor);
        }
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
        let legacy = root.join("com.boite.desktop");
        let current = root.join("com.boite.legacy");
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
        let legacy = root.join("com.boite.desktop");
        let current = root.join("com.boite.legacy");
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

    #[test]
    fn the_webview_profile_moves_entry_by_entry_without_clobbering() {
        // %LOCALAPPDATA%\<id> on Windows: the WebView2 profile holding the
        // frontend's localStorage, plus the log directory the running process
        // has already opened at the new identifier.
        let root = scratch("local");
        let legacy = root.join("com.boite.desktop");
        let current = root.join("com.boite.legacy");
        write(&legacy.join("EBWebView/Default/Local Storage/leveldb/000003.log"), "panes");
        write(&legacy.join("logs/desktop.jsonl"), "old records");
        write(&current.join("logs/desktop.jsonl"), "this session");

        let outcome = migrate_entry_by_entry(&legacy, &current).unwrap();
        assert_eq!(outcome, Outcome::Moved { entries: 1, from: legacy.clone() });
        assert_eq!(
            std::fs::read_to_string(
                current.join("EBWebView/Default/Local Storage/leveldb/000003.log")
            )
            .unwrap(),
            "panes"
        );
        assert_eq!(
            std::fs::read_to_string(current.join("logs/desktop.jsonl")).unwrap(),
            "this session",
            "the log this start already opened must not be overwritten"
        );
        assert!(legacy.join("logs/desktop.jsonl").is_file());
    }

    #[test]
    fn nothing_moves_out_of_a_directory_that_is_not_there() {
        let root = scratch("absent");
        let current = root.join("com.boite.legacy");
        assert_eq!(
            migrate_entry_by_entry(&root.join("com.boite.desktop"), &current).unwrap(),
            Outcome::Nothing
        );
        assert_eq!(
            migrate_by_rename(&root.join("com.boite.desktop"), &current).unwrap(),
            Outcome::Nothing
        );
        // Neither one may create the destination on the way to doing nothing.
        assert!(!current.exists());
    }

    #[test]
    fn the_webkit_store_moves_whole_and_only_onto_an_empty_place() {
        // ~/Library/WebKit/<id> on macOS. WKWebView creates it after this runs,
        // so the destination is free and the directory moves in one rename.
        let root = scratch("webkit");
        let legacy = root.join("com.boite.desktop");
        let current = root.join("com.boite.legacy");
        write(&legacy.join("WebsiteData/Default/localstorage.sqlite3"), "settings");
        write(&legacy.join("NetworkProcess/state"), "cookies");

        let outcome = migrate_by_rename(&legacy, &current).unwrap();
        assert_eq!(outcome, Outcome::Moved { entries: 2, from: legacy.clone() });
        assert_eq!(
            std::fs::read_to_string(current.join("WebsiteData/Default/localstorage.sqlite3"))
                .unwrap(),
            "settings"
        );
        assert!(!legacy.exists());

        // A second run finds the destination taken and leaves everything where
        // it is, the never-clobber rule applied to a whole directory.
        write(&legacy.join("WebsiteData/Default/localstorage.sqlite3"), "stale");
        assert_eq!(migrate_by_rename(&legacy, &current).unwrap(), Outcome::Nothing);
        assert_eq!(
            std::fs::read_to_string(current.join("WebsiteData/Default/localstorage.sqlite3"))
                .unwrap(),
            "settings"
        );
        assert!(legacy.join("WebsiteData/Default/localstorage.sqlite3").is_file());
    }

    #[test]
    fn the_extra_directories_are_resolved_for_one_platform_each() {
        // The pure functions above take paths so they run everywhere. These two
        // are the platform half, and each answers on exactly one platform.
        let local = local_data_directories("com.boite.desktop");
        assert_eq!(local.is_some(), cfg!(target_os = "windows"));
        let webkit = webkit_directories("com.boite.desktop");
        assert_eq!(webkit.is_some(), cfg!(target_os = "macos"));
        for (from, to) in local.into_iter().chain(webkit) {
            assert!(from.ends_with("com.boite.desktop"), "{}", from.display());
            assert!(to.ends_with(CURRENT_IDENTIFIER), "{}", to.display());
        }
    }

    #[test]
    fn a_best_effort_failure_is_reported_and_not_returned() {
        let mut done = Vec::new();
        record_best_effort(&mut done, Ok(Outcome::Nothing));
        record_best_effort(&mut done, Err("the webview profile is open".to_string()));
        assert!(done.is_empty());
        let moved = || Outcome::Moved { entries: 2, from: PathBuf::from("somewhere") };
        record_best_effort(&mut done, Ok(moved()));
        assert_eq!(done, vec![moved()]);
    }
}
