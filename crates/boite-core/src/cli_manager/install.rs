//! The directory Boite owns, and how a binary gets in and out of it.
//!
//! `~/.boite/bin`, on every platform, and it is on the child PATH because
//! `shell::user_bin_dirs` names it. Nothing here writes to `~/.cargo/bin`,
//! `/usr/local/bin` or anywhere else a package manager considers its own: an
//! install Boite did is an install Boite can undo, and one it did into somebody
//! else's directory is not.
//!
//! A package that has to stay together (a launcher beside its runtime) is
//! unpacked under `~/.boite/opt/<id>/<version>` and linked from the bin, which is
//! what the vendor's own installer does with it.

use std::path::{Path, PathBuf};

use super::Failed;

/// Where Boite keeps what it installed.
pub fn root() -> Option<PathBuf> {
    super::home_dir().map(|home| home.join(".boite"))
}

/// The managed bin directory. Named by `shell::user_bin_dirs`, so a binary landing
/// here resolves for the next spawn without the app restarting.
pub fn bin_dir() -> Option<PathBuf> {
    root().map(|root| root.join("bin"))
}

/// Where a multi-file package is unpacked.
pub fn opt_dir() -> Option<PathBuf> {
    root().map(|root| root.join("opt"))
}

/// The managed copy of `name`, if Boite installed one.
pub fn managed_binary(name: &str) -> Option<PathBuf> {
    let path = bin_dir()?.join(name);
    // `symlink_metadata`, so a package's link counts as installed even when the
    // tree behind it is the thing that went missing.
    std::fs::symlink_metadata(&path).is_ok().then_some(path)
}

/// Whether `path` is inside the managed bin, which decides whether an uninstall
/// is Boite's to do or the package manager's.
pub fn is_managed(path: &Path) -> bool {
    match bin_dir() {
        Some(bin) => is_managed_in(&bin, path),
        None => false,
    }
}

fn is_managed_in(bin: &Path, path: &Path) -> bool {
    let Ok(bin) = bin.canonicalize() else {
        return false;
    };
    // The link, not what it points at: a package's binary lives under `opt` and
    // is reached through a link in the bin, and canonicalizing first would answer
    // no for it.
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return false,
    };
    parent.canonicalize().map(|p| p == bin).unwrap_or(false)
}

fn ensure_dir(dir: &Path) -> Result<(), Failed> {
    std::fs::create_dir_all(dir).map_err(|e| Failed(format!("cannot make {}: {e}", dir.display())))
}

#[cfg(unix)]
fn make_runnable(path: &Path) -> Result<(), Failed> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| Failed(format!("cannot make {} runnable: {e}", path.display())))
}

#[cfg(not(unix))]
fn make_runnable(_path: &Path) -> Result<(), Failed> {
    // Windows decides on the extension, and the file is already named `.exe`.
    Ok(())
}

/// Moves `from` into the managed bin as `name`, replacing what was there.
///
/// **Windows will not let a running `.exe` be overwritten, but it will let it be
/// renamed.** So the old binary is moved aside rather than deleted, the new one
/// takes its place, and the retirement is swept up afterwards — an agent running
/// out of the file being replaced keeps running out of the file it was started
/// from, and the next launch gets the new one. Doing it the other way round is an
/// update that reports success on every machine except the one with the CLI open.
pub fn place_binary(from: &Path, name: &str) -> Result<PathBuf, Failed> {
    let bin = bin_dir().ok_or_else(|| Failed("no home directory to install into".to_string()))?;
    place_binary_in(&bin, from, name)
}

fn place_binary_in(bin: &Path, from: &Path, name: &str) -> Result<PathBuf, Failed> {
    ensure_dir(bin)?;
    let target = bin.join(name);
    let staged = bin.join(format!(".{name}.boite.tmp"));
    let retired = bin.join(format!(".{name}.old"));

    let _ = std::fs::remove_file(&staged);
    // Copied rather than renamed: the download sits in the system temp
    // directory, which is a different filesystem often enough that a rename
    // there fails with EXDEV. Staged beside the target so *this* rename cannot.
    std::fs::copy(from, &staged).map_err(|e| {
        Failed(format!(
            "cannot stage {} into {}: {e}",
            from.display(),
            bin.display()
        ))
    })?;
    make_runnable(&staged)?;

    let had_target = std::fs::symlink_metadata(&target).is_ok();
    if had_target {
        let _ = std::fs::remove_file(&retired);
        std::fs::rename(&target, &retired).map_err(|e| {
            let _ = std::fs::remove_file(&staged);
            Failed(format!(
                "{} is in the way and cannot be moved aside: {e}",
                target.display()
            ))
        })?;
    }
    if let Err(err) = std::fs::rename(&staged, &target) {
        let _ = std::fs::remove_file(&staged);
        if had_target {
            let _ = std::fs::rename(&retired, &target);
        }
        return Err(Failed(format!("cannot install {}: {err}", target.display())));
    }
    sweep_retired_in(bin);
    Ok(target)
}

/// Unpacked package trees this id has, newest install last.
fn package_dir(id: &str, version: &str) -> Result<PathBuf, Failed> {
    let opt = opt_dir().ok_or_else(|| Failed("no home directory to install into".to_string()))?;
    Ok(opt.join(id).join(version))
}

/// Unpacks nothing itself: hands back the directory a package should be unpacked
/// into, emptied first so a failed attempt cannot be read as a finished one.
pub fn prepare_package(id: &str, version: &str) -> Result<PathBuf, Failed> {
    let dir = package_dir(id, version)?;
    if dir.exists() {
        remove_tree(&dir)?;
    }
    ensure_dir(&dir)?;
    Ok(dir)
}

/// Points the managed bin at `entry` inside an unpacked package.
///
/// A link rather than a copy, because the launcher resolves its runtime relative
/// to the path it was started from. On Windows there is no link to make without
/// developer mode, and no vendor shipping this shape has a Windows build, so it
/// says so rather than installing something that cannot work.
pub fn link_package(package: &Path, entry: &str, name: &str) -> Result<PathBuf, Failed> {
    let source = package.join(entry);
    if !source.is_file() {
        return Err(Failed(format!(
            "the package holds no {entry}, so there is nothing to run"
        )));
    }
    make_runnable(&source)?;
    let bin = bin_dir().ok_or_else(|| Failed("no home directory to install into".to_string()))?;
    ensure_dir(&bin)?;
    let target = bin.join(name);
    remove_entry(&target)?;

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, &target)
            .map_err(|e| Failed(format!("cannot link {}: {e}", target.display())))?;
        Ok(target)
    }
    #[cfg(not(unix))]
    {
        let _ = source;
        Err(Failed(
            "this CLI ships as a package that has to stay together, which needs a link this platform will not make".to_string(),
        ))
    }
}

/// Removes one entry from the managed bin, link or file, without following it.
pub fn remove_entry(path: &Path) -> Result<(), Failed> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    let outcome = if meta.is_dir() && !meta.is_symlink() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    outcome.map_err(|e| Failed(format!("cannot remove {}: {e}", path.display())))
}

/// Removes an unpacked tree, refusing to walk into a link on the way.
pub fn remove_tree(dir: &Path) -> Result<(), Failed> {
    let Ok(meta) = std::fs::symlink_metadata(dir) else {
        return Ok(());
    };
    if meta.is_symlink() {
        return remove_entry(dir);
    }
    std::fs::remove_dir_all(dir).map_err(|e| Failed(format!("cannot remove {}: {e}", dir.display())))
}

/// Everything Boite installed for `id`: the bin entry, and the unpacked tree if
/// there is one. Answers how many things it actually removed.
pub fn uninstall(id: &str, name: &str) -> Result<usize, Failed> {
    let mut removed = 0;
    if let Some(bin) = bin_dir() {
        let target = bin.join(name);
        if std::fs::symlink_metadata(&target).is_ok() {
            remove_entry(&target)?;
            removed += 1;
        }
    }
    if let Some(opt) = opt_dir() {
        let tree = opt.join(id);
        if tree.exists() {
            remove_tree(&tree)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Drops the binaries a previous update moved aside once nothing holds them open.
///
/// Best-effort by design: on Windows a retired binary is still locked while the
/// agent started from it runs, and the answer to that is to try again later
/// rather than to fail an install that worked.
pub fn sweep_retired() {
    if let Some(bin) = bin_dir() {
        sweep_retired_in(&bin);
    }
}

fn sweep_retired_in(bin: &Path) {
    let Ok(entries) = std::fs::read_dir(bin) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with('.') && (name.ends_with(".old") || name.ends_with(".boite.tmp")) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bin directory of this test's own. The real one is never written to from a
    /// test: `~/.boite/bin` is the directory the developer's own threads spawn out
    /// of while the suite runs.
    fn scratch_bin(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "boite-install-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A retired binary and a half-staged one are both swept, and a real install
    /// is not: the sweep runs on every install, so a rule too wide would delete
    /// the CLI it just put there.
    #[test]
    fn the_sweep_only_takes_what_an_update_left_behind() {
        let bin = scratch_bin("sweep");
        let keeper = bin.join("agent");
        let retired = bin.join(".agent.old");
        let staged = bin.join(".agent.boite.tmp");
        for path in [&keeper, &retired, &staged] {
            std::fs::write(path, b"x").unwrap();
        }
        sweep_retired_in(&bin);
        assert!(keeper.exists(), "the sweep took a real install");
        assert!(!retired.exists());
        assert!(!staged.exists());
        std::fs::remove_dir_all(&bin).unwrap();
    }

    /// Replacing an existing binary keeps the name and leaves nothing behind.
    #[test]
    fn placing_a_binary_replaces_what_was_there() {
        let bin = scratch_bin("place");
        let source = bin.join("downloaded");
        std::fs::write(&source, b"new").unwrap();
        let name = "agent";
        std::fs::write(bin.join(name), b"old").unwrap();

        let placed = place_binary_in(&bin, &source, name).unwrap();
        assert_eq!(std::fs::read(&placed).unwrap(), b"new");
        assert!(is_managed_in(&bin, &placed));
        assert!(
            !bin.join(".agent.old").exists(),
            "the replaced binary was left behind"
        );
        std::fs::remove_dir_all(&bin).unwrap();
    }

    /// An entry that is a link goes without the tree behind it going.
    #[cfg(unix)]
    #[test]
    fn removing_an_entry_unlinks_rather_than_follows() {
        let bin = scratch_bin("unlink");
        let package = bin.join("package");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("cursor-agent"), b"x").unwrap();
        let link = bin.join("cursor-agent");
        std::os::unix::fs::symlink(package.join("cursor-agent"), &link).unwrap();

        remove_entry(&link).unwrap();
        assert!(!link.exists());
        assert!(package.join("cursor-agent").exists());
        std::fs::remove_dir_all(&bin).unwrap();
    }
}
