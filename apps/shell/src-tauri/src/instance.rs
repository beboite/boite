use fs2::FileExt;
use std::fs::{create_dir_all, File, OpenOptions};
use std::io;
use std::path::Path;

/// The OS releases the lock even after a hard kill. Each data directory owns
/// one shell, so tests and the two installed channels remain independent.
pub fn acquire(directory: &Path) -> io::Result<Option<File>> {
    create_dir_all(directory)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("shell.lock"))?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(Some(file)),
        Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_owner_per_directory_until_the_handle_closes() {
        let root = std::env::temp_dir().join(format!("boite-instance-{}", std::process::id()));
        let first = acquire(&root).unwrap().unwrap();
        assert!(acquire(&root).unwrap().is_none());
        let other = acquire(&root.join("other-channel")).unwrap().unwrap();
        drop(first);
        let replacement = acquire(&root).unwrap().unwrap();
        drop(replacement);
        drop(other);
        std::fs::remove_dir_all(root).unwrap();
    }
}
