//! A secret on disk, rather than in an environment a terminal prints.
//!
//! Boite used to stamp the agent bearer token straight into every PTY's
//! environment. Two things follow from that, and neither is theoretical: an
//! agent that types `env` (which coding agents do, constantly) prints the
//! credential into a terminal whose scrollback is kept and replayed on
//! reattach, and every process the agent starts, a build script and a
//! downloaded installer included, inherits it.
//!
//! Passing a path instead does not make the secret unreachable, and is not
//! meant to. It makes it something a process has to go and read on purpose,
//! which keeps it out of terminal recordings, screenshots, logs and anything
//! that dumps an environment.

use std::fs;
use std::io;
use std::path::Path;

/// Writes `value` where only this user can read it.
///
/// On unix the mode is set before the content is written, so there is no
/// instant where the file exists with the default mode and the secret in it.
///
/// On Windows there is no mode to set, and the caller's choice of directory is
/// the boundary: both callers write inside the per-user application data
/// directory, whose inherited ACL already grants the user and administrators
/// alone. An explicit ACL here would need a Win32 dependency for a guarantee
/// the location already gives.
pub fn write(path: &Path, value: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Replaced rather than truncated in place: a reader holding the old path
    // sees either the whole previous value or the whole new one.
    let _ = fs::remove_file(path);
    create_private(path)?;
    fs::write(path, value)
}

#[cfg(unix)]
fn create_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map(|_| ())
}

#[cfg(not(unix))]
fn create_private(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Reads a secret back, trimmed. A missing file is an error like any other:
/// the caller wanted a credential and there is none.
pub fn read(path: &Path) -> io::Result<String> {
    Ok(fs::read_to_string(path)?.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        // Keyed by pid and by the caller's own name, so parallel test threads
        // never share a directory.
        let dir = std::env::temp_dir()
            .join(format!("boite-secret-{}-{name}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir.join("token")
    }

    #[test]
    fn a_secret_round_trips_and_trims() {
        let path = scratch("roundtrip");
        write(&path, "deadbeef").unwrap();
        assert_eq!(read(&path).unwrap(), "deadbeef");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn rewriting_replaces_rather_than_appends() {
        let path = scratch("replace");
        write(&path, "first").unwrap();
        write(&path, "second").unwrap();
        assert_eq!(read(&path).unwrap(), "second");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_not_readable_by_anyone_else() {
        use std::os::unix::fs::PermissionsExt;
        let path = scratch("mode");
        write(&path, "deadbeef").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "0600, not whatever the umask allows");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
