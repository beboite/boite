//! Writing a file nobody else on the machine may read.
//!
//! Two files here are credentials on disk: the bootstrap token beside the
//! database, and the VAPID private key. Both were written with `fs::write` and
//! narrowed to `0600` afterwards, which leaves two ways for a secret to end up
//! readable by every account on the host.
//!
//! The first is the gap. `fs::write` creates through the umask — `0644` on a
//! default Debian, and this server's own Dockerfile runs it in an image whose
//! umask nobody set — so between the write and the `set_permissions` there is a
//! moment where the token is on disk and world-readable. It is a short moment,
//! and a moment is what a loop on the same machine is for. Creating the file
//! with the mode already applied removes it: the descriptor never exists at any
//! other mode.
//!
//! The second is the silence. The result of `set_permissions` was discarded, so
//! a filesystem that cannot represent the mode — a mounted volume, a `noacl`
//! export, anything Windows-backed — produced a world-readable token and said
//! nothing at all. That is the case worth a line in the log, because it is the
//! one nobody can see by looking at the code.
//!
//! `mode()` at creation covers the new file. It does nothing for a file that is
//! already there, since the flag applies to a create, so the explicit narrowing
//! stays for the case where a token was written by an older build, or by a
//! restore that rebuilt the data directory with someone else's umask.

use std::fs;
use std::io;
use std::path::Path;

/// Writes `contents` to `path`, readable and writable by this user alone.
///
/// The mode is applied on unix and is a no-op elsewhere: Windows has no umask
/// to lose to, and the file inherits the ACL of the data directory the server
/// created.
pub(crate) fn write(path: &Path, contents: &str) -> io::Result<()> {
    write_inner(path, contents)?;
    narrow(path);
    Ok(())
}

#[cfg(unix)]
fn write_inner(path: &Path, contents: &str) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents.as_bytes())
}

#[cfg(not(unix))]
fn write_inner(path: &Path, contents: &str) -> io::Result<()> {
    fs::write(path, contents)
}

/// Narrows a file that already existed, and says so when it cannot.
#[cfg(unix)]
fn narrow(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Err(e) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
        tracing::warn!(
            "{} holds a secret and could not be narrowed to 0600: {e}. \
             Anything running as another user on this host can read it.",
            path.display()
        );
    }
}

#[cfg(not(unix))]
fn narrow(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_written_secret_is_readable_again() {
        let dir = std::env::temp_dir().join(format!("boite-secret-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token");

        write(&path, "deadbeef").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "deadbeef");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The token file is rewritten over an existing one when a data directory
    /// is reused, and a shorter token must not leave the tail of a longer one
    /// behind it.
    #[test]
    fn a_rewrite_truncates_what_was_there() {
        let dir = std::env::temp_dir().join(format!("boite-secret-trunc-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token");

        write(&path, "0123456789abcdef").unwrap();
        write(&path, "short").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "short");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn nobody_else_can_read_it() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("boite-secret-mode-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token");

        write(&path, "deadbeef").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "group or other can reach the secret");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The file already exists at the default umask, the way an older build
    /// left it. Writing through here has to narrow it, not accept it.
    #[cfg(unix)]
    #[test]
    fn an_existing_wide_file_is_narrowed() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("boite-secret-wide-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write(&path, "new").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }
}
