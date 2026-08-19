//! Reading this machine's side, without following anything it should not.
//!
//! Two link hazards are real in a home directory with agents in it, and both are
//! measured rather than imagined. `~/.claude/skills`, `~/.claude/commands` and
//! `~/.claude/agents` are symlinks into `~/.agents`, so a walk that followed
//! links would sync the same twenty skills twice under two names. And
//! `~/.agents/AGENTS.md` is one inode with four names — `~/.gemini/GEMINI.md`
//! and `~/.gemini/config/AGENTS.md` among them — which is a hazard for the
//! writer rather than the reader, and lives in `apply`.
//!
//! So: `symlink_metadata` before anything, and `is_symlink()` checked before any
//! `is_dir()`, because on Windows a junction commonly reports `is_dir() == false`
//! and a check in the other order silently reads the target. A link inside a tree
//! is skipped and *named*, never skipped quietly. A source that is itself a link
//! — a dotfiles layout — is read through and named too, because refusing it
//! would break the commonest arrangement a power user has.
//!
//! Nothing here deletes, creates or replaces a link. `remove_dir_all` does not
//! appear in this module and must not: on Windows it descends into a junction
//! and empties the target, which is how a `node_modules` was destroyed during
//! another feature's development.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::manifest::{self, Kind, Source, Synced};
use super::portable;

/// One machine's side of the comparison: what each repository path holds here.
#[derive(Debug, Default)]
pub struct Scan {
    pub files: BTreeMap<String, Vec<u8>>,
    pub notes: Notes,
}

/// Everything the scan decided not to do, so the panel can say so.
///
/// A sync that quietly left files out reads exactly like one that covered
/// everything, which is the failure this exists to prevent.
#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notes {
    /// Links inside a tree. Read as names, never followed.
    pub skipped_links: Vec<String>,
    /// Sources that are themselves links. Read through, and worth saying: a
    /// dotfiles repository just took part in this.
    pub through_link: Vec<String>,
    /// Not valid UTF-8. Every file in scope is text; a binary in `~/.agents` is
    /// a surprise worth surfacing rather than a diff nobody can read.
    pub not_text: Vec<String>,
    /// Names the always-denied list stopped, wherever they appeared.
    pub denied: Vec<String>,
    /// Rules that reached nothing, or something they would not touch.
    pub rules_skipped: Vec<portable::Skipped>,
    /// Paths that could not be read at all, with what the system said.
    pub unreadable: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failed {
    /// The home directory is not valid UTF-8, so a home token could not be
    /// spelled. Refused rather than guessed at with a lossy conversion, which
    /// would write a path that opens nothing.
    HomeNotText,
    Refused(manifest::Refusal),
    /// A ceiling, which is a refusal and not a truncation: a tree that outgrew
    /// its limit is one somebody put something unexpected in, and a quietly
    /// partial commit reads as a complete one.
    TooManyFiles { path: String, found: usize, limit: usize },
    TooBig { path: String, found: u64, limit: u64 },
}

impl Failed {
    pub fn message(&self) -> String {
        match self {
            Failed::HomeNotText => "the home directory path is not valid UTF-8".to_string(),
            Failed::Refused(refusal) => refusal.message(),
            Failed::TooManyFiles { path, found, limit } => {
                format!("{path} holds {found} files, more than the {limit} this syncs")
            }
            Failed::TooBig { path, found, limit } => {
                format!("{path} is {found} bytes, more than the {limit} this syncs")
            }
        }
    }
}

/// Reads every enabled source, ready to compare against the repository.
///
/// `enabled` is the ids the user switched on. A source that is off is not walked
/// at all — not walked and filtered, not walked and dropped: a switch that is
/// off is a file Boite does not read.
pub fn scan(home: &Path, enabled: &[&str]) -> Result<Scan, Failed> {
    let Some(home_text) = home.to_str() else {
        return Err(Failed::HomeNotText);
    };
    let mut out = Scan::default();
    for entry in manifest::SOURCES {
        if !enabled.contains(&entry.id) {
            continue;
        }
        for source in entry.sources {
            read_source(home, home_text, entry, source, &mut out)?;
        }
    }
    Ok(out)
}

fn read_source(
    home: &Path,
    home_text: &str,
    entry: &Synced,
    source: &Source,
    out: &mut Scan,
) -> Result<(), Failed> {
    let root = manifest::resolve(home, source).map_err(Failed::Refused)?;
    match source.kind {
        Kind::File { rules } => {
            // A source that is not here is not an error. A machine without an
            // agent installed still has a row for it, and still receives its
            // configuration before the agent arrives.
            let Some(kind) = link_aware_kind(&root, source.path, out) else {
                return Ok(());
            };
            if !kind.is_file {
                return Ok(());
            }
            if kind.through_link {
                out.notes.through_link.push(source.path.to_string());
            }
            take_file(&root, entry.id, source.path, rules, home_text, out);
            Ok(())
        }
        Kind::Tree { deny, max_depth, max_files, max_bytes } => {
            walk(&root, entry.id, source.path, deny, max_depth, max_files, max_bytes, home_text, out)
        }
    }
}

struct EntryKind {
    is_file: bool,
    through_link: bool,
}

/// What something on disk is, with the link question asked first.
///
/// `is_symlink()` before any `is_dir()`, because on Windows a junction reports
/// `is_dir() == false` and asking in the other order reads the target.
/// `None` when the path is not there, which is not an error.
fn link_aware_kind(path: &Path, label: &str, out: &mut Scan) -> Option<EntryKind> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            out.notes.unreadable.push(format!("{label}: {error}"));
            return None;
        }
    };
    if meta.file_type().is_symlink() {
        // Read through, and say so. The link itself tells us nothing about what
        // is on the other end, so ask again — through the link this time.
        let target = fs::metadata(path).ok()?;
        return Some(EntryKind { is_file: target.is_file(), through_link: true });
    }
    Some(EntryKind { is_file: meta.is_file(), through_link: false })
}

#[allow(clippy::too_many_arguments)]
fn walk(
    root: &Path,
    id: &str,
    root_relative: &str,
    deny: &[&str],
    max_depth: u32,
    max_files: usize,
    max_bytes: u64,
    home_text: &str,
    out: &mut Scan,
) -> Result<(), Failed> {
    if !root.is_dir() {
        return Ok(());
    }
    let mut queue: Vec<(PathBuf, String, u32)> = vec![(root.to_path_buf(), root_relative.to_string(), 0)];
    let mut files = 0usize;
    let mut bytes = 0u64;
    while let Some((dir, dir_relative, depth)) = queue.pop() {
        let listing = match fs::read_dir(&dir) {
            Ok(listing) => listing,
            Err(error) => {
                out.notes.unreadable.push(format!("{dir_relative}: {error}"));
                continue;
            }
        };
        for item in listing.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            let relative = format!("{dir_relative}/{name}");
            if manifest::denied_always(&name) || deny.contains(&name.as_str()) {
                out.notes.denied.push(relative);
                continue;
            }
            // The one ordering that matters in this file.
            let meta = match fs::symlink_metadata(item.path()) {
                Ok(meta) => meta,
                Err(error) => {
                    out.notes.unreadable.push(format!("{relative}: {error}"));
                    continue;
                }
            };
            if meta.file_type().is_symlink() {
                out.notes.skipped_links.push(relative);
                continue;
            }
            if meta.is_dir() {
                if depth < max_depth {
                    queue.push((item.path(), relative, depth + 1));
                }
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            files += 1;
            bytes += meta.len();
            if files > max_files {
                return Err(Failed::TooManyFiles {
                    path: root_relative.to_string(),
                    found: files,
                    limit: max_files,
                });
            }
            if bytes > max_bytes {
                return Err(Failed::TooBig {
                    path: root_relative.to_string(),
                    found: bytes,
                    limit: max_bytes,
                });
            }
            take_file(&item.path(), id, &relative, &[], home_text, out);
        }
    }
    Ok(())
}

/// Reads one file and puts its outbound form under its repository path.
fn take_file(
    path: &Path,
    id: &str,
    home_relative: &str,
    rules: &[manifest::Rule],
    home_text: &str,
    out: &mut Scan,
) {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) => {
            out.notes.unreadable.push(format!("{home_relative}: {error}"));
            return;
        }
    };
    let Ok(text) = String::from_utf8(raw) else {
        out.notes.not_text.push(home_relative.to_string());
        return;
    };
    let redacted = portable::outbound(&text, rules, home_text);
    out.notes.rules_skipped.extend(redacted.skipped);
    out.files.insert(manifest::repo_path(id, home_relative), redacted.text.into_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A home in a temporary directory, so no test ever reads the developer's
    /// own. Every function above takes the home as an argument for exactly this
    /// reason: setting `BOITE_CLI_HOME` would be process-global while cargo runs
    /// tests in threads.
    struct TempHome(PathBuf);

    impl TempHome {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir()
                .join("boite-sync-tests")
                .join(format!("{label}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("temp home");
            TempHome(root)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, relative: &str, contents: &str) -> PathBuf {
            let full = self.0.join(relative);
            fs::create_dir_all(full.parent().expect("a parent")).expect("dirs");
            let mut file = fs::File::create(&full).expect("create");
            file.write_all(contents.as_bytes()).expect("write");
            full
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) -> bool {
        use std::os::windows::process::CommandExt;
        // A junction rather than a symlink, for the reason the artifacts module
        // gives: symlink creation on Windows needs developer mode or elevation,
        // and a junction needs neither.
        let out = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(0x0800_0000)
            .output();
        match out {
            Ok(out) if out.status.success() => true,
            Ok(out) => {
                eprintln!(
                    "mklink refused: status={:?} stdout={} stderr={}",
                    out.status,
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                false
            }
            Err(error) => {
                eprintln!("mklink did not start: {error}");
                false
            }
        }
    }

    /// The measured layout: `~/.claude/skills` points into `~/.agents`. Followed,
    /// the same skill would be committed twice under two names.
    #[test]
    fn a_link_inside_a_tree_is_skipped_and_never_followed() {
        let home = TempHome::new("skipped-links");
        home.write(".agents/AGENTS.md", "# rules\n");
        home.write(".agents/skills/one/SKILL.md", "# one\n");
        home.write("elsewhere/secret.md", "should never appear\n");
        // Joined one segment at a time: `join(".agents/pointer")` leaves a forward
        // slash in a Windows path, and `cmd` reads `/pointer` as an option.
        let link = home.path().join(".agents").join("pointer");
        if !link_dir(&home.path().join("elsewhere"), &link) {
            eprintln!("skipping: this machine cannot make a directory link");
            return;
        }

        let scan = scan(home.path(), &["agents"]).expect("scan");
        let names: Vec<&String> = scan.files.keys().collect();
        assert!(names.iter().all(|name| !name.contains("secret")), "{names:?}");
        assert_eq!(scan.files.len(), 2, "{names:?}");
        assert_eq!(scan.notes.skipped_links, vec![".agents/pointer".to_string()]);
    }

    /// `~/.claude` is not a source, so nothing under it is reachable — not
    /// filtered, not denied, simply never looked at. Only the one named file.
    #[test]
    fn nothing_under_the_claude_directory_is_reachable() {
        let home = TempHome::new("allowlist");
        home.write(".claude/settings.json", r#"{"model":"opus"}"#);
        home.write(".claude/.credentials.json", r#"{"token":"0123456789"}"#);
        home.write(".claude/plugins/cache/x/big.js", "// nine megabytes, elsewhere\n");
        home.write(".claude/sessions/20892.json", "{}");
        home.write(".claude.json", "{\"machineID\":\"abc\"}");

        let scan = scan(home.path(), &["claude"]).expect("scan");
        assert_eq!(
            scan.files.keys().collect::<Vec<_>>(),
            vec!["claude/.claude/settings.json"],
            "{:?}",
            scan.files.keys().collect::<Vec<_>>()
        );
    }

    /// A switch that is off is a file Boite does not read.
    #[test]
    fn a_disabled_source_is_not_read() {
        let home = TempHome::new("disabled");
        home.write(".claude/settings.json", r#"{"model":"opus"}"#);
        assert!(scan(home.path(), &[]).expect("scan").files.is_empty());
        assert!(scan(home.path(), &["agents"]).expect("scan").files.is_empty());
    }

    /// A machine without the agent still has a row, and still receives its
    /// configuration later. Absence is not an error.
    #[test]
    fn a_source_that_is_not_here_is_not_an_error() {
        let home = TempHome::new("absent");
        let scan = scan(home.path(), &["claude", "agents", "copilot"]).expect("scan");
        assert!(scan.files.is_empty());
        assert!(scan.notes.unreadable.is_empty(), "{:?}", scan.notes.unreadable);
    }

    /// A tree that outgrew its ceiling is refused by name, not committed in part.
    #[test]
    fn a_tree_over_its_ceiling_is_refused_rather_than_truncated() {
        let home = TempHome::new("ceiling");
        for index in 0..12 {
            home.write(&format!(".agents/skills/s{index}/SKILL.md"), "# skill\n");
        }
        let root = home.path().join(".agents");
        let failed = walk(
            &root,
            "agents",
            ".agents",
            &[],
            8,
            4,
            8 * 1024 * 1024,
            home.path().to_str().expect("utf-8"),
            &mut Scan::default(),
        )
        .expect_err("should refuse");
        assert!(matches!(failed, Failed::TooManyFiles { .. }), "{failed:?}");
        assert!(failed.message().contains(".agents"));
    }

    /// The denied list applies wherever a name appears, including inside the
    /// user's own markdown tree.
    #[test]
    fn a_denied_name_inside_the_tree_is_left_and_named() {
        let home = TempHome::new("denied");
        home.write(".agents/AGENTS.md", "# rules\n");
        home.write(".agents/.env", "TOKEN=0123456789\n");
        let scan = scan(home.path(), &["agents"]).expect("scan");
        assert_eq!(scan.files.len(), 1);
        assert_eq!(scan.notes.denied, vec![".agents/.env".to_string()]);
    }

    /// Every file in scope is text. A binary is named rather than turned into a
    /// diff nobody can read.
    #[test]
    fn a_file_that_is_not_text_is_skipped_and_named() {
        let home = TempHome::new("binary");
        let full = home.path().join(".agents/skills/logo.md");
        fs::create_dir_all(full.parent().expect("parent")).expect("dirs");
        fs::write(&full, [0xff, 0xfe, 0x00, 0x01]).expect("write");
        let scan = scan(home.path(), &["agents"]).expect("scan");
        assert!(scan.files.is_empty());
        assert_eq!(scan.notes.not_text, vec![".agents/skills/logo.md".to_string()]);
    }

    /// The redaction and the home token are applied on the way out, so what is
    /// held for the repository is already portable.
    #[test]
    fn what_is_read_is_already_portable() {
        let home = TempHome::new("portable");
        let home_text = home.path().to_str().expect("utf-8").to_string();
        // Built through serde rather than written by hand: on Windows the home
        // holds backslashes, and a hand-written literal would be invalid JSON —
        // which redaction correctly refuses to parse, hiding what this asserts.
        let settings = serde_json::json!({
            "statusLine": { "command": format!("pwsh {home_text}/.claude/s.ps1") }
        });
        home.write(".claude/settings.json", &settings.to_string());
        let scan = scan(home.path(), &["claude"]).expect("scan");
        let held = scan.files.get("claude/.claude/settings.json").expect("the file");
        let text = String::from_utf8(held.clone()).expect("utf-8");
        assert!(text.contains("__BOITE_LOCAL:/statusLine/command__"), "{text}");
        assert!(!text.contains(&home_text), "{text}");
    }
}
