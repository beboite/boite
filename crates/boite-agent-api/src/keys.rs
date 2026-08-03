//! The credentials a terminal is handed at spawn.
//!
//! Both hosts spawn PTYs and both used to stamp the same workspace token into
//! every one of them. They stamp a key file now, and this is the one place that
//! decides what goes in it, so the desktop and the server cannot end up issuing
//! two different kinds of credential.

use std::path::{Path, PathBuf};

use boite_core::store::Store;
use boite_identity::ThreadKey;

/// Mints the identity a terminal is about to sign with, and returns the file
/// naming it.
///
/// Called once per thread, at its first spawn. A later spawn of the same thread
/// finds the row already bound and hands back the file that was written then:
/// re-minting would be a new public key on a row that already has one, which is
/// exactly what [`Store::bind_thread_identity`] refuses.
///
/// **A key file that goes missing is not replaced.** If the row carries an owner
/// and the file is gone, this fails and the terminal opens with no Boite tools
/// rather than with a fresh identity. That is the lock working: a path that
/// re-mints on a missing file is a path that re-mints for anyone who can delete
/// one. The file therefore lives beside the database rather than in a temp
/// directory, so the two are lost together or not at all.
pub fn mint(store: &Store, keys_dir: &Path, thread_id: &str) -> Result<PathBuf, String> {
    if thread_id.trim().is_empty() {
        return Err("a thread needs an id before it can have a key".into());
    }
    let path = key_path(keys_dir, thread_id)?;
    if let Some(existing) = store.public_key_of_thread(thread_id) {
        let held = boite_core::secret_file::read(&path)
            .map_err(|e| format!("thread {thread_id} has an owner and no key file: {e}"))?;
        let held = ThreadKey::from_seed_hex(&held)?;
        if held.public_hex() != existing {
            return Err(format!(
                "the key file for thread {thread_id} is not the one on its row"
            ));
        }
        return Ok(path);
    }

    let key = ThreadKey::mint();
    // The file first: a row bound to a key nobody holds is a thread that can
    // never sign again, and the lock means it cannot be repaired.
    boite_core::secret_file::write(&path, &key.seed_hex())
        .map_err(|e| format!("cannot write the key file: {e}"))?;
    store.bind_thread_identity(thread_id, &key.public_hex())?;
    Ok(path)
}

/// Forgets a thread's key. For a thread being deleted.
///
/// Best effort and deliberately quiet: the row is going, and a leftover file
/// under a directory only this user can read grants nothing once there is no
/// row to look its public half up on.
pub fn forget(keys_dir: &Path, thread_id: &str) {
    if let Ok(path) = key_path(keys_dir, thread_id) {
        let _ = std::fs::remove_file(path);
    }
}

/// One file per thread, named after it.
///
/// The id is checked rather than trusted: it reaches here from a client on the
/// server side, and a `..` in it would put the file wherever the caller liked.
/// Ids are uuids, so anything outside that alphabet is refused rather than
/// escaped.
fn key_path(keys_dir: &Path, thread_id: &str) -> Result<PathBuf, String> {
    if !thread_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("{thread_id} is not a thread id"));
    }
    Ok(keys_dir.join(format!("{thread_id}.key")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fake;

    #[test]
    fn a_thread_keeps_the_key_it_was_minted() {
        let fake = Fake::new("mint").with_project("p1", "/w");
        let keys = fake.scratch().join("keys");

        let first = mint(&fake.store, &keys, "t1").unwrap();
        let seed = boite_core::secret_file::read(&first).unwrap();
        // A respawn hands back the same file, not a new identity.
        let second = mint(&fake.store, &keys, "t1").unwrap();
        assert_eq!(first, second);
        assert_eq!(boite_core::secret_file::read(&second).unwrap(), seed);
    }

    /// The lock, seen from the spawn path: a thread whose key file is gone is
    /// not re-minted, because a path that does that re-mints for whoever
    /// deleted it.
    #[test]
    fn a_lost_key_is_not_quietly_replaced() {
        let fake = Fake::new("lost").with_project("p1", "/w");
        let keys = fake.scratch().join("keys");
        let path = mint(&fake.store, &keys, "t1").unwrap();
        let owner = fake.store.public_key_of_thread("t1").unwrap();

        std::fs::remove_file(&path).unwrap();
        assert!(mint(&fake.store, &keys, "t1").is_err());
        assert_eq!(fake.store.public_key_of_thread("t1"), Some(owner));
    }

    /// And a file swapped for a different key is refused rather than believed.
    #[test]
    fn a_key_file_that_is_not_the_rows_is_refused() {
        let fake = Fake::new("swapped").with_project("p1", "/w");
        let keys = fake.scratch().join("keys");
        let path = mint(&fake.store, &keys, "t1").unwrap();

        boite_core::secret_file::write(&path, &ThreadKey::mint().seed_hex()).unwrap();
        let refusal = mint(&fake.store, &keys, "t1").unwrap_err();
        assert!(refusal.contains("not the one on its row"), "{refusal}");
    }

    /// The id names the file, and it arrives from a client on the server side.
    #[test]
    fn an_id_cannot_choose_where_its_key_file_goes() {
        let keys = Path::new("/keys");
        assert!(key_path(keys, "../../etc/passwd").is_err());
        assert!(key_path(keys, "a/b").is_err());
        assert!(key_path(keys, "..").is_err());
        assert!(key_path(keys, "0f8c-4a").is_ok());
    }

    #[test]
    fn forgetting_a_thread_removes_its_key() {
        let fake = Fake::new("forget").with_project("p1", "/w");
        let keys = fake.scratch().join("keys");
        let path = mint(&fake.store, &keys, "t1").unwrap();
        assert!(path.exists());
        forget(&keys, "t1");
        assert!(!path.exists());
        // And forgetting something that was never there is not an error.
        forget(&keys, "never");
    }
}
