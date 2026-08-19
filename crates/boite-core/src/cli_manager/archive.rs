//! Unpacking the two formats every vendor publishes, and nothing more.
//!
//! Zip and gzipped tar. No `.zst`, which two of these vendors also publish and
//! neither publishes *only*: a third decompressor is a third dependency and a
//! third way for this to be wrong.
//!
//! Every entry's destination is checked before it is written. An archive is a
//! file somebody else wrote, `../../.ssh/authorized_keys` is a legal name inside
//! one, and `zip` hands back `None` from `enclosed_name` for exactly that reason.

use std::path::{Path, PathBuf};

use super::Failed;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Zip,
    TarGz,
}

/// What the artifact's name says it is.
///
/// The name rather than the bytes: `infer` would answer from the magic, and an
/// answer that disagrees with the URL is a redirect somewhere else, not an
/// archive to be clever about.
pub fn kind_of(name: &str) -> Result<Kind, Failed> {
    let lower = name.to_ascii_lowercase();
    let lower = lower.split(['?', '#']).next().unwrap_or(&lower);
    if lower.ends_with(".zip") {
        return Ok(Kind::Zip);
    }
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        return Ok(Kind::TarGz);
    }
    Err(Failed(format!("{name} is not an archive this can open")))
}

/// Unpacks everything under `dest`, dropping the first `strip` path components.
///
/// `strip` is one for a vendor whose tarball wraps everything in a directory
/// named after the build, which is `tar --strip-components=1` and is what the
/// cursor installer does. Nothing outside `dest` is ever written.
pub fn extract(archive: &Path, kind: Kind, dest: &Path, strip: usize) -> Result<(), Failed> {
    std::fs::create_dir_all(dest)
        .map_err(|e| Failed(format!("cannot make {}: {e}", dest.display())))?;
    match kind {
        Kind::Zip => extract_zip(archive, dest, strip),
        Kind::TarGz => extract_tar_gz(archive, dest, strip),
    }
}

fn strip_prefix_components(path: &Path, strip: usize) -> Option<PathBuf> {
    let mut components = path.components();
    for _ in 0..strip {
        components.next()?;
    }
    let rest: PathBuf = components.collect();
    (!rest.as_os_str().is_empty()).then_some(rest)
}

fn extract_zip(archive: &Path, dest: &Path, strip: usize) -> Result<(), Failed> {
    let file = std::fs::File::open(archive)
        .map_err(|e| Failed(format!("cannot read {}: {e}", archive.display())))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| Failed(format!("{} is not a zip: {e}", archive.display())))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| Failed(format!("unreadable entry in {}: {e}", archive.display())))?;
        // `enclosed_name` is None for an absolute path, a `..` and a Windows
        // drive letter alike. A refusal here is the whole boundary.
        let Some(name) = entry.enclosed_name() else {
            return Err(Failed(format!(
                "{} holds an entry that points outside it",
                archive.display()
            )));
        };
        let Some(relative) = strip_prefix_components(&name, strip) else {
            continue;
        };
        let target = dest.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| Failed(format!("cannot make {}: {e}", target.display())))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Failed(format!("cannot make {}: {e}", parent.display())))?;
        }
        let mut out = std::fs::File::create(&target)
            .map_err(|e| Failed(format!("cannot write {}: {e}", target.display())))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| Failed(format!("cannot write {}: {e}", target.display())))?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, dest: &Path, strip: usize) -> Result<(), Failed> {
    let file = std::fs::File::open(archive)
        .map_err(|e| Failed(format!("cannot read {}: {e}", archive.display())))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    tar.set_preserve_permissions(true);
    let entries = tar
        .entries()
        .map_err(|e| Failed(format!("{} is not a tar: {e}", archive.display())))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| Failed(format!("unreadable entry in {}: {e}", archive.display())))?;
        let path = entry
            .path()
            .map_err(|e| Failed(format!("nameless entry in {}: {e}", archive.display())))?
            .into_owned();
        // `tar` hands the name over without judging it, unlike zip, so the
        // judging happens here.
        if escapes(&path) {
            return Err(Failed(format!(
                "{} holds an entry that points outside it",
                archive.display()
            )));
        }
        let Some(relative) = strip_prefix_components(&path, strip) else {
            continue;
        };
        let target = dest.join(&relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Failed(format!("cannot make {}: {e}", parent.display())))?;
        }
        entry
            .unpack(&target)
            .map_err(|e| Failed(format!("cannot write {}: {e}", target.display())))?;
    }
    Ok(())
}

/// Whether an entry name would land anywhere but under the destination.
///
/// An absolute path and any `..` at all, rather than a normalised comparison of
/// the result: a name is data from an archive somebody else built, and the cheap
/// rule refuses a few harmless names while the clever one is where the escape
/// gets through.
///
/// `is_absolute` is not enough on Windows, where a name like `/etc/passwd` is
/// *not* absolute — it has no drive — and `Path::join` still throws the
/// destination away and lands it at the root of the current drive. So the root
/// and the drive prefix are refused by component rather than by that answer.
fn escapes(path: &Path) -> bool {
    path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
}

/// The executable inside an unpacked tree.
///
/// By name first, because a release that ships its own tools beside the CLI
/// (codex ships an app-server, a linter and a sandbox helper) has more than one
/// file in it and only one of them is the agent. The single-file case answers
/// itself, and anything else is a refusal rather than a guess: installing the
/// wrong binary under the right name is worse than not installing.
pub fn find_binary(dir: &Path, exe: &str) -> Result<PathBuf, Failed> {
    let mut files = Vec::new();
    collect_files(dir, 0, &mut files);
    let named = |wanted: &str| {
        files
            .iter()
            .find(|path| {
                path.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case(wanted))
            })
            .cloned()
    };
    if let Some(hit) = named(exe).or_else(|| named(&format!("{exe}.exe"))) {
        return Ok(hit);
    }
    let stem_matches: Vec<_> = files
        .iter()
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| name.starts_with(exe))
        })
        .cloned()
        .collect();
    if stem_matches.len() == 1 {
        return Ok(stem_matches[0].clone());
    }
    if files.len() == 1 {
        return Ok(files[0].clone());
    }
    Err(Failed(format!(
        "no file named {exe} inside the archive, and {} others to choose from",
        files.len()
    )))
}

/// Every file under `dir`, four levels deep, links never followed.
fn collect_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            collect_files(&path, depth + 1, out);
        } else if meta.is_file() {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_says_which_format() {
        assert_eq!(kind_of("codex-x86_64.tar.gz").unwrap(), Kind::TarGz);
        assert_eq!(kind_of("opencode-windows-x64.zip").unwrap(), Kind::Zip);
        assert_eq!(kind_of("thing.TGZ").unwrap(), Kind::TarGz);
        assert!(kind_of("codex-x86_64.zst").is_err());
        assert!(kind_of("claude").is_err());
    }

    #[test]
    fn stripping_drops_the_wrapper_directory() {
        let path = Path::new("package/bin/cursor-agent");
        assert_eq!(
            strip_prefix_components(path, 1).unwrap(),
            Path::new("bin/cursor-agent")
        );
        assert_eq!(strip_prefix_components(Path::new("only"), 1), None);
    }

    /// A round trip through each format, because a name check is not a check that
    /// the bytes came out. The wrapper directory is stripped for the shape whose
    /// vendor wraps its tree in one.
    #[test]
    fn a_gzipped_tar_comes_out_the_other_side() {
        let dir = std::env::temp_dir().join(format!("boite-tar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let tarball = dir.join("package.tar.gz");

        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            std::fs::File::create(&tarball).unwrap(),
            flate2::Compression::fast(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(5);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "wrapper/cursor-agent", &b"hello"[..])
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();

        let out = dir.join("out");
        extract(&tarball, Kind::TarGz, &out, 1).unwrap();
        let found = find_binary(&out, "cursor-agent").unwrap();
        assert_eq!(found, out.join("cursor-agent"));
        assert_eq!(std::fs::read(&found).unwrap(), b"hello");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_zip_comes_out_the_other_side() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("boite-zip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zipped = dir.join("opencode-windows-x64.zip");

        let mut writer = zip::ZipWriter::new(std::fs::File::create(&zipped).unwrap());
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file("opencode.exe", options).unwrap();
        writer.write_all(b"binary").unwrap();
        writer.finish().unwrap();

        let out = dir.join("out");
        extract(&zipped, Kind::Zip, &out, 0).unwrap();
        let found = find_binary(&out, "opencode").unwrap();
        assert_eq!(std::fs::read(&found).unwrap(), b"binary");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// An archive is a file somebody else wrote, and `../../.ssh/authorized_keys`
    /// is a legal name inside one. The `tar` crate refuses to *write* such a name,
    /// which is why the rule is asserted rather than a malicious fixture built:
    /// what it protects against is an archive built by something that does not.
    #[test]
    fn a_name_that_would_land_outside_the_destination_is_refused() {
        assert!(escapes(Path::new("../escaped")));
        assert!(escapes(Path::new("wrapper/../../escaped")));
        assert!(escapes(Path::new("/etc/passwd")));
        #[cfg(windows)]
        assert!(escapes(Path::new(r"C:\Windows\System32\drivers\etc\hosts")));
        assert!(!escapes(Path::new("wrapper/bin/cursor-agent")));
        assert!(!escapes(Path::new("codex")));
    }

    #[test]
    fn a_named_binary_wins_over_its_neighbours() {
        let dir = std::env::temp_dir().join(format!("boite-archive-{}", std::process::id()));
        let nested = dir.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("codex-app-server"), b"x").unwrap();
        std::fs::write(nested.join("codex"), b"x").unwrap();
        let found = find_binary(&dir, "codex").unwrap();
        assert_eq!(found.file_name().unwrap(), "codex");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_tree_with_no_candidate_is_a_refusal_rather_than_a_guess() {
        let dir = std::env::temp_dir().join(format!("boite-archive-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("readme"), b"x").unwrap();
        std::fs::write(dir.join("licence"), b"x").unwrap();
        assert!(find_binary(&dir, "codex").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
