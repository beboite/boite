//! One pool of conversations per project, rather than one per worktree.
//!
//! Claude and pi file a transcript under the directory the CLI ran in, and
//! every agent thread here runs in a worktree of its own. So `/resume` typed
//! inside a thread offered that thread's conversations and nothing else: the
//! thread beside it, the user's own checkout and yesterday's closed thread are
//! three other directories and therefore three other stores. The project it is
//! all about is the one thing the store never knew about.
//!
//! A worktree's store is a link onto the project's, made when the worktree is
//! handed to a thread and removed with it. Every thread of the project then
//! reads and writes one directory: `/resume` lists the project's conversations
//! wherever it is typed, and a worktree that goes away takes a link with it
//! instead of a conversation.
//!
//! Boite's own reading of those stores skips the links (`claude::find_…` and
//! `usage`), because a transcript reached through two names is one transcript
//! and answering twice for it is either a double count or the same file read
//! twice.

use std::fs;
use std::path::Path;

use crate::git::artifacts::link_dir;

use super::claude::claude_project_dir_name;
use super::editors::{pi_dir_name, pi_sessions_root};

/// The cwd as the CLI itself sees it. A trailing separator is dropped, because
/// a path spelled with one and a path spelled without it are one directory and
/// would otherwise be two stores; nothing else is touched. In particular the
/// case is left alone: this feeds directory names that have to match what the
/// CLI will look for, not a comparison.
fn as_given(cwd: &str) -> &str {
    cwd.trim_end_matches(['/', '\\'])
}

/// Points this worktree's stores at the project's, for every CLI that files by
/// directory.
///
/// Best effort throughout, and deliberately silent about the ordinary refusals.
/// A store that cannot be shared costs `/resume` the rest of the project's
/// conversations; refusing to open the worktree over it would cost the user
/// their thread.
pub fn share_session_stores(project_cwd: &str, worktree_cwd: &str) {
    if let Some(home) = dirs::home_dir() {
        share(
            &home.join(".claude").join("projects"),
            &claude_project_dir_name(as_given(project_cwd)),
            &claude_project_dir_name(as_given(worktree_cwd)),
        );
    }
    // Pi's flat shape serves every directory from one folder already, so there
    // is nothing to point anywhere.
    if let Some((root, flat)) = pi_sessions_root() {
        if !flat {
            share(
                &root,
                &pi_dir_name(as_given(project_cwd)),
                &pi_dir_name(as_given(worktree_cwd)),
            );
        }
    }
}

/// Takes the links back, and only the links.
///
/// Runs before the worktree is removed, for the same reason the shared
/// artifacts are unlinked there: on Windows a delete that meets a junction
/// walks into it and empties what it points at, which here is every
/// conversation the project ever had.
pub fn unshare_session_stores(worktree_cwd: &str) {
    if let Some(home) = dirs::home_dir() {
        unshare(
            &home.join(".claude").join("projects"),
            &claude_project_dir_name(as_given(worktree_cwd)),
        );
    }
    if let Some((root, flat)) = pi_sessions_root() {
        if !flat {
            unshare(&root, &pi_dir_name(as_given(worktree_cwd)));
        }
    }
}

/// Replaces one store directory with a link onto another.
fn share(root: &Path, pool: &str, worktree: &str) {
    if pool.is_empty() || worktree.is_empty() || pool == worktree {
        return;
    }
    let target = root.join(pool);
    let link = root.join(worktree);
    if fs::create_dir_all(&target).is_err() {
        return;
    }
    match fs::symlink_metadata(&link) {
        // Already a link. Where it points is not re-decided here: one this app
        // made points at the pool, and one it did not is somebody's own
        // arrangement and none of its business.
        Ok(meta) if meta.file_type().is_symlink() => return,
        Ok(_) => {
            // A real store, which is what a restored thread comes back to: a
            // worktree directory is named after its thread, so reopening one
            // reuses the path, and the conversations held there are the very
            // ones the user is trying to get back. They move into the pool
            // rather than being linked over and lost.
            if !drain_into(&link, &target) {
                eprintln!(
                    "[boite/session] {} kept its own store: it holds a transcript the project already has",
                    link.display()
                );
                return;
            }
            if fs::remove_dir(&link).is_err() {
                return;
            }
        }
        Err(_) => {}
    }
    if let Err(err) = link_dir(&target, &link) {
        eprintln!("[boite/session] no shared store for {}: {err}", link.display());
    }
}

/// Moves a store's files into the pool, and answers whether it emptied.
///
/// A name the pool already has is the one thing this refuses. Two files under
/// one session id are two records of one conversation, the pool's is the one
/// every other worktree has been appending to, and picking between them is not
/// something a link can do quietly.
fn drain_into(from: &Path, to: &Path) -> bool {
    let Ok(entries) = fs::read_dir(from) else {
        return false;
    };
    let mut emptied = true;
    for entry in entries.flatten() {
        let source = entry.path();
        let target = to.join(entry.file_name());
        if fs::symlink_metadata(&target).is_ok() {
            emptied = false;
            continue;
        }
        if fs::rename(&source, &target).is_ok() {
            continue;
        }
        // A rename across volumes fails, and nothing says the home directory
        // and the project are on one.
        emptied &= fs::copy(&source, &target)
            .and_then(|_| fs::remove_file(&source))
            .is_ok();
    }
    emptied
}

/// Unlinks a store, never a real one and never what one points at.
fn unshare(root: &Path, worktree: &str) {
    if worktree.is_empty() {
        return;
    }
    let link = root.join(worktree);
    let Ok(meta) = fs::symlink_metadata(&link) else {
        return;
    };
    if !meta.file_type().is_symlink() {
        return;
    }
    // `remove_dir` unlinks a junction or a directory symlink without following
    // it; `remove_file` is the same call for a file symlink. Neither is
    // `remove_dir_all`, which is the mistake this whole function guards.
    let _ = fs::remove_dir(&link).or_else(|_| fs::remove_file(&link));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A store root of our own, so the suite never touches the machine's.
    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("boite-shared-store-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed(root: &Path, dir: &str, file: &str, body: &str) {
        let dir = root.join(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(file), body).unwrap();
    }

    fn is_link(path: &Path) -> bool {
        fs::symlink_metadata(path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
    }

    /// The whole point: what the worktree writes lands in the project's pool,
    /// so every other thread of the project can resume it.
    #[test]
    fn a_worktree_store_becomes_the_project_one() {
        let root = root("linked");
        share(&root, "pool", "worktree");

        assert!(is_link(&root.join("worktree")));
        fs::write(root.join("worktree").join("sess.jsonl"), "line\n").unwrap();
        assert_eq!(
            fs::read_to_string(root.join("pool").join("sess.jsonl")).unwrap(),
            "line\n"
        );
    }

    /// A thread is closed and restored, so its worktree path comes back with a
    /// store already in it. That store is the conversation the user is trying
    /// to get back, and it has to end up where the project can see it.
    #[test]
    fn a_store_that_was_already_there_moves_into_the_pool() {
        let root = root("drained");
        seed(&root, "worktree", "sess.jsonl", "earlier\n");

        share(&root, "pool", "worktree");

        assert!(is_link(&root.join("worktree")));
        assert_eq!(
            fs::read_to_string(root.join("pool").join("sess.jsonl")).unwrap(),
            "earlier\n"
        );
    }

    /// Two records of one session, and no way to tell from here which one the
    /// user wants. Neither is destroyed and the store stays its own.
    #[test]
    fn a_transcript_the_pool_already_has_is_never_overwritten() {
        let root = root("collision");
        seed(&root, "pool", "sess.jsonl", "pool\n");
        seed(&root, "worktree", "sess.jsonl", "worktree\n");

        share(&root, "pool", "worktree");

        assert!(!is_link(&root.join("worktree")));
        assert_eq!(
            fs::read_to_string(root.join("pool").join("sess.jsonl")).unwrap(),
            "pool\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("worktree").join("sess.jsonl")).unwrap(),
            "worktree\n"
        );
    }

    /// The user's own checkout is the pool. Linking a directory onto itself is
    /// the one call that would lose every conversation at once.
    #[test]
    fn the_project_store_is_never_pointed_at_itself() {
        let root = root("self");
        seed(&root, "pool", "sess.jsonl", "kept\n");

        share(&root, "pool", "pool");

        assert!(!is_link(&root.join("pool")));
        assert_eq!(
            fs::read_to_string(root.join("pool").join("sess.jsonl")).unwrap(),
            "kept\n"
        );
    }

    /// Closing a thread takes its link. What the link pointed at is the
    /// project's, and outlives every thread that ever read it.
    #[test]
    fn unsharing_takes_the_link_and_leaves_the_conversations() {
        let root = root("unshared");
        seed(&root, "pool", "sess.jsonl", "kept\n");
        share(&root, "pool", "worktree");
        assert!(is_link(&root.join("worktree")));

        unshare(&root, "worktree");

        assert!(fs::symlink_metadata(root.join("worktree")).is_err());
        assert_eq!(
            fs::read_to_string(root.join("pool").join("sess.jsonl")).unwrap(),
            "kept\n"
        );
    }

    /// A real store belongs to whoever wrote it. A worktree removed before this
    /// existed still has one, and it is not this function's to delete.
    #[test]
    fn a_real_store_is_left_where_it_is() {
        let root = root("real");
        seed(&root, "worktree", "sess.jsonl", "mine\n");

        unshare(&root, "worktree");

        assert_eq!(
            fs::read_to_string(root.join("worktree").join("sess.jsonl")).unwrap(),
            "mine\n"
        );
    }
}
