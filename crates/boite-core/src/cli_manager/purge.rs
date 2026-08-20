//! Removing a CLI's own data, which is the half of an uninstall that cannot be
//! taken back.
//!
//! So it is the half with the rules. Every path comes from the catalogue in this
//! crate and never from the caller — a webview naming the directory to delete is
//! a webview deleting any directory — and each one is checked again here, right
//! before the removal, against the home directory it has to be inside.
//!
//! A link is unlinked, never followed. `remove_dir_all` walking into a junction
//! is the bug `git::artifacts` already exists to avoid, and on Windows a junction
//! inside a data directory is not hypothetical: Boite makes them itself.

use std::path::{Path, PathBuf};

use super::catalog::Cli;
use super::Failed;

/// A directory the panel offers to remove, and what it weighs.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPath {
    pub path: String,
    pub bytes: u64,
}

/// What this CLI has left on this machine, only counting what is really there.
///
/// The size is read so the dialogue can say what is about to go: "delete
/// `~/.claude`" and "delete `~/.claude`, 1.4 GB" are different sentences to
/// answer, and the second one is the true one.
pub fn preview(cli: &Cli) -> Vec<DataPath> {
    cli.data
        .iter()
        .filter_map(|dir| dir.resolve())
        .filter(|path| std::fs::symlink_metadata(path).is_ok())
        .map(|path| DataPath {
            bytes: size_of(&path),
            path: path.to_string_lossy().into_owned(),
        })
        .collect()
}

/// Removes every data directory of `cli`, answering with the ones that went.
///
/// A path that is not there is not an error: the question the caller asked is
/// "leave nothing behind", and nothing behind is the answer either way.
pub fn purge(cli: &Cli) -> Result<Vec<String>, Failed> {
    let home = super::home_dir()
        .ok_or_else(|| Failed("no home directory, so nothing can be checked".to_string()))?;
    purge_paths(&paths(cli), &home)
}

/// The pass itself, over paths somebody else resolved.
///
/// Every path is attempted, and a refusal does not end the pass: returning at the
/// first one reported a failure having already deleted the directories before it,
/// so the one thing the answer left out was what had actually happened.
fn purge_paths(targets: &[PathBuf], home: &Path) -> Result<Vec<String>, Failed> {
    let mut removed = Vec::new();
    let mut refused = Vec::new();
    for path in targets {
        match remove_guarded(path, home) {
            Ok(true) => removed.push(path.to_string_lossy().into_owned()),
            Ok(false) => {}
            Err(Failed(why)) => refused.push(why),
        }
    }
    if !refused.is_empty() {
        return Err(Failed(format!(
            "removed {}, and refused: {}",
            removed.len(),
            refused.join("; ")
        )));
    }
    Ok(removed)
}

/// Removes one path, or refuses.
///
/// Three refusals, and each one is a real case rather than a formality: a data
/// directory that resolved to the home itself (an empty `path` in the table, or a
/// `HOME` that moved), a path that canonicalized to somewhere else entirely (the
/// directory is a link, or a component of it is), and a path outside the home,
/// which is every system directory there is.
fn remove_guarded(path: &Path, home: &Path) -> Result<bool, Failed> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(false);
    };
    if meta.is_symlink() {
        // Unlink the name. Following it would delete whatever it points at, which
        // is exactly what somebody who pointed `~/.claude` at their documents
        // folder did not ask for.
        let outcome = std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path));
        return outcome
            .map(|_| true)
            .map_err(|e| Failed(format!("cannot unlink {}: {e}", path.display())));
    }
    let real = path
        .canonicalize()
        .map_err(|e| Failed(format!("cannot resolve {}: {e}", path.display())))?;
    let home = home
        .canonicalize()
        .map_err(|e| Failed(format!("cannot resolve the home directory: {e}")))?;
    if real == home {
        return Err(Failed(format!(
            "{} is the home directory itself, which is never what a CLI's data is",
            real.display()
        )));
    }
    if !real.starts_with(&home) {
        return Err(Failed(format!(
            "{} is outside the home directory, so it is not this CLI's to delete",
            real.display()
        )));
    }
    let outcome = if meta.is_dir() {
        std::fs::remove_dir_all(&real)
    } else {
        std::fs::remove_file(&real)
    };
    outcome
        .map(|_| true)
        .map_err(|e| Failed(format!("cannot remove {}: {e}", real.display())))
}

/// How much a directory weighs, links counted as their own size and never walked.
///
/// Bounded on both depth and entries: a data directory holding a link back up its
/// own tree would otherwise be a walk with no end, and the number is for a
/// sentence in a dialogue rather than for accounting.
fn size_of(path: &Path) -> u64 {
    fn walk(path: &Path, depth: usize, seen: &mut usize) -> u64 {
        if depth > 12 || *seen > 200_000 {
            return 0;
        }
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            return 0;
        };
        *seen += 1;
        if meta.is_symlink() {
            return 0;
        }
        if meta.is_file() {
            return meta.len();
        }
        let Ok(entries) = std::fs::read_dir(path) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| walk(&entry.path(), depth + 1, seen))
            .sum()
    }
    let mut seen = 0;
    walk(path, 0, &mut seen)
}

/// The paths of `cli`, resolved, whether or not they exist. For the tests and for
/// the status listing, which says whether there is anything to purge at all.
pub fn paths(cli: &Cli) -> Vec<PathBuf> {
    cli.data.iter().filter_map(|dir| dir.resolve()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("boite-purge-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_directory_inside_the_home_goes() {
        let home = scratch("inside");
        let data = home.join(".agent");
        std::fs::create_dir_all(data.join("sessions")).unwrap();
        std::fs::write(data.join("sessions").join("a.json"), b"{}").unwrap();

        assert!(remove_guarded(&data, &home).unwrap());
        assert!(!data.exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn the_home_itself_is_refused() {
        let home = scratch("home");
        let err = remove_guarded(&home, &home).unwrap_err();
        assert!(err.0.contains("home directory itself"), "{}", err.0);
        assert!(home.exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_path_outside_the_home_is_refused() {
        let home = scratch("outside-home");
        let elsewhere = scratch("outside-target");
        std::fs::write(elsewhere.join("keep"), b"x").unwrap();

        let err = remove_guarded(&elsewhere, &home).unwrap_err();
        assert!(err.0.contains("outside the home"), "{}", err.0);
        assert!(elsewhere.join("keep").exists());
        std::fs::remove_dir_all(&home).unwrap();
        std::fs::remove_dir_all(&elsewhere).unwrap();
    }

    /// The one that matters: a data directory that is a link somewhere else loses
    /// the link and keeps everything the link pointed at.
    #[cfg(unix)]
    #[test]
    fn a_link_is_unlinked_and_never_followed() {
        let home = scratch("link-home");
        let treasure = scratch("link-target");
        std::fs::write(treasure.join("notes.txt"), b"keep me").unwrap();
        let link = home.join(".agent");
        std::os::unix::fs::symlink(&treasure, &link).unwrap();

        assert!(remove_guarded(&link, &home).unwrap());
        assert!(!link.exists());
        assert!(treasure.join("notes.txt").exists(), "the link was followed");
        std::fs::remove_dir_all(&home).unwrap();
        std::fs::remove_dir_all(&treasure).unwrap();
    }

    #[test]
    fn a_path_that_is_not_there_is_not_an_error() {
        let home = scratch("absent");
        assert!(!remove_guarded(&home.join("nothing-here"), &home).unwrap());
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// A refusal in the middle of a pass says what went as well as what did not.
    /// The removals have already happened by then, and an answer that only carried
    /// the refusal would be the wrong half of the truth.
    #[test]
    fn a_pass_reports_what_it_removed_alongside_what_it_refused() {
        let home = scratch("mixed-home");
        let elsewhere = scratch("mixed-elsewhere");
        let inside = home.join(".agent");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::write(elsewhere.join("keep"), b"x").unwrap();

        let err = purge_paths(&[inside.clone(), elsewhere.clone()], &home).unwrap_err();
        assert!(err.0.starts_with("removed 1,"), "{}", err.0);
        assert!(err.0.contains("outside the home"), "{}", err.0);
        assert!(!inside.exists(), "the path it was allowed to remove stayed");
        assert!(elsewhere.join("keep").exists());

        // And a clean pass answers with the paths themselves, for the job's message.
        let second = home.join(".other");
        std::fs::create_dir_all(&second).unwrap();
        let removed = purge_paths(&[second.clone(), home.join("never-existed")], &home).unwrap();
        assert_eq!(removed, vec![second.to_string_lossy().into_owned()]);

        std::fs::remove_dir_all(&home).unwrap();
        std::fs::remove_dir_all(&elsewhere).unwrap();
    }

    #[test]
    fn a_size_counts_the_files_and_not_the_links() {
        let home = scratch("size");
        std::fs::write(home.join("a"), vec![0u8; 1024]).unwrap();
        std::fs::write(home.join("b"), vec![0u8; 512]).unwrap();
        assert_eq!(size_of(&home), 1536);
        std::fs::remove_dir_all(&home).unwrap();
    }
}
