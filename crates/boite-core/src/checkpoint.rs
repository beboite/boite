//! What the tree looked like at each end of an agent's turn.
//!
//! One checkpoint is a commit object under `refs/boite/ckpt/<thread>/<n>`, and
//! nothing else in git ever looks there: not a branch, not `git status`, not
//! `git log`. So a turn has an exact diff and an exact revert without a
//! user-visible commit, without a second copy of the tree on disk, and without a
//! row in the database — git already stores trees, and a ref is the cheapest
//! handle there is on one.
//!
//! The mechanism is plumbing rather than porcelain, and every part of it is
//! chosen to leave the user's own git alone:
//!
//! - A **temporary index** through `GIT_INDEX_FILE`, seeded from the real one so
//!   the stat cache still works, means `git add -A` never touches what the user
//!   has staged.
//! - `write-tree` then `commit-tree` builds the commit off to one side. No
//!   branch moves, HEAD is never read and never written, so a worktree with zero
//!   commits and a detached HEAD both work.
//! - `git add -A` is what makes untracked files part of the checkpoint and
//!   `.gitignore` respected at the same time, which is the same rule the user
//!   already agreed to for their own commits.
//!
//! What this cannot do is restore the agent's conversation. A revert here puts
//! the files back and nothing else, and every caller has to say so.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::git::{git as git_cmd, git_show, repo_relative, run as git_run};

/// How many checkpoints one thread keeps before the oldest are dropped.
///
/// A checkpoint costs a commit and a tree; the blobs are almost always ones git
/// is already storing for the branch beside them, so the disk cost is close to
/// nothing. What it does cost is a ref, and a ref is what stops `git gc` from
/// collecting the objects under it — so an unbounded list is a repository that
/// grows for as long as the thread lives. Fifty is roughly two days of one busy
/// agent, and well past the point where anyone reverts to a turn by hand.
pub const KEEP_PER_THREAD: usize = 50;

/// The largest patch [`diff_blocking`] will hand back whole.
///
/// A patch is only ever asked for by something that wants the whole turn as
/// text; a panel reads the file list. This ceiling is what keeps one turn that
/// regenerated a lockfile from putting several megabytes through the IPC.
const MAX_PATCH_BYTES: usize = 256 * 1024;

const REF_PREFIX: &str = "refs/boite/ckpt";

/// Which end of a turn a checkpoint was taken at.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    /// The transition into `busy`: what the tree looked like before the agent
    /// touched anything.
    Start,
    /// The transition into `idle`: what it looked like when the turn ended.
    /// `waiting` and `shell` are not this, because neither is a finished turn.
    End,
    /// Not an end of anything the agent did: the tree a revert was about to
    /// overwrite. [`restore_blocking`] takes one before it touches a single
    /// file, so the undo is itself undoable.
    ///
    /// Nothing asks for this edge over the wire, and `checkpoint.capture` still
    /// takes the two real ends and nothing else: it belongs to the restore that
    /// writes it, not to a caller watching an agent's turn.
    Restore,
}

impl Edge {
    fn as_str(self) -> &'static str {
        match self {
            Edge::Start => "start",
            Edge::End => "end",
            Edge::Restore => "restore",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "start" => Some(Edge::Start),
            "end" => Some(Edge::End),
            "restore" => Some(Edge::Restore),
            _ => None,
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// Its position in this thread's list, which is also the last segment of its
    /// ref. Monotonic, never reused, so a gap means a pruned checkpoint rather
    /// than a lost one.
    pub index: u32,
    pub sha: String,
    pub edge: Edge,
    /// Milliseconds since the epoch, off the commit's own committer date.
    pub at: i64,
    /// What changed between the previous checkpoint of this thread and this one.
    ///
    /// Measured once, when the checkpoint is written, and carried in the commit
    /// message from then on. Recomputing it per row would be one `git diff` per
    /// checkpoint every time a list is drawn.
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// `A`, `M`, `D`, `R` or `T`, as git's `--name-status` reports it.
    pub status: String,
    /// Where a rename came from.
    pub orig_path: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub files: Vec<ChangedFile>,
    /// Empty unless the caller asked for it. See [`MAX_PATCH_BYTES`].
    pub patch: String,
    pub truncated: bool,
}

/// One file at both ends of a turn, in the shape the diff view already reads.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileAtEdges {
    pub before: Option<String>,
    pub after: Option<String>,
    pub binary: bool,
}

/// The ref namespace one thread's checkpoints live under.
///
/// A thread id is Boite's own, but a ref name is a filesystem path on most
/// platforms and git rejects a long list of shapes in one. Anything outside a
/// conservative alphabet becomes `-` rather than being refused, because a
/// checkpoint that silently does not happen is worse than two threads sharing a
/// namespace — which cannot happen anyway, since Boite mints the ids.
fn thread_ref_prefix(thread_id: &str) -> Result<String, String> {
    let safe: String = thread_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if safe.trim_matches('-').is_empty() {
        return Err("a checkpoint needs a thread id".into());
    }
    Ok(format!("{REF_PREFIX}/{safe}"))
}

/// Refuses anything that is not an object name before it reaches git's argv.
///
/// `diff`, `show` and `read-tree` all take their revisions as the first
/// positional tokens, and for those three `--` cannot separate a revision from
/// an option. So a value shaped like `--output=<path>` is not a bad revision to
/// git, it is an option, and git honours it: the caller's `repo` was checked
/// against the registered roots and the file lands somewhere else entirely.
///
/// Every one of these values comes from a checkpoint's own sha, so a hex object
/// name is the only shape that was ever legitimate. Refusing everything else
/// costs nothing and is the one check that cannot be argued around, which is
/// not true of quoting or escaping.
fn checked_rev(rev: &str) -> Result<(), String> {
    let hex = (7..=64).contains(&rev.len()) && rev.bytes().all(|b| b.is_ascii_hexdigit());
    if hex {
        Ok(())
    } else {
        Err(format!("{rev} is not a checkpoint id"))
    }
}

/// Where git keeps this worktree's own git directory and its own index.
///
/// Asked of git rather than derived from `.git`, because a linked worktree's
/// index is not the main checkout's and writing a checkpoint against the wrong
/// one would snapshot a tree nobody is looking at.
fn git_paths(repo: &Path) -> Result<(PathBuf, PathBuf), String> {
    let mut cmd = git_cmd(repo);
    cmd.args(["rev-parse", "--absolute-git-dir", "--git-path", "index"]);
    let out = git_run(cmd)?;
    let text = String::from_utf8_lossy(&out);
    let mut lines = text.lines();
    let dir = lines.next().ok_or("git did not say where it keeps its data")?;
    let index = lines.next().ok_or("git did not say where its index is")?;
    let dir = PathBuf::from(dir.trim());
    let index = PathBuf::from(index.trim());
    // `--git-path` answers relative to the worktree when the repository is
    // reached by a relative path, and an index written to the wrong directory is
    // a checkpoint of nothing.
    let index = if index.is_absolute() {
        index
    } else {
        repo.join(index)
    };
    Ok((dir, index))
}

/// A temporary index that removes itself, lock file included.
///
/// It lives inside the git directory so it shares the filesystem with the real
/// index — a rename across volumes is what git falls back to a copy for — and so
/// nothing under the worktree ever sees it.
struct TempIndex {
    path: PathBuf,
}

impl TempIndex {
    fn seeded_from(git_dir: &Path, real_index: &Path) -> Result<Self, String> {
        // The counter is what actually makes the name unique. A pid and a
        // millisecond do not: two threads sharing one worktree check point
        // independently, and two captures landing in the same millisecond would
        // then run `add -A` against the same index file. Each would write a tree
        // of what the other had staged, and the `Drop` of the first would delete
        // the file the second is still using.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = git_dir.join(format!(
            "boite-ckpt-index-{}-{}-{seq}",
            std::process::id(),
            crate::now_ms()
        ));
        let _ = fs::remove_file(&path);
        // Seeded rather than started empty: with the real index copied in, git's
        // stat cache still applies and `add -A` re-hashes only what moved. From
        // an empty index it would hash every file in the repository, every turn.
        if real_index.exists() {
            fs::copy(real_index, &path)
                .map_err(|e| format!("could not stage a checkpoint index: {e}"))?;
        }
        Ok(Self { path })
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let mut lock = self.path.clone().into_os_string();
        lock.push(".lock");
        let _ = fs::remove_file(PathBuf::from(lock));
    }
}

fn with_temp_index(cmd: &mut std::process::Command, index: &TempIndex) {
    cmd.env("GIT_INDEX_FILE", &index.path);
}

/// Writes the whole worktree into a tree, respecting `.gitignore`.
fn write_worktree_tree(repo: &Path, index: &TempIndex) -> Result<String, String> {
    let mut add = git_cmd(repo);
    with_temp_index(&mut add, index);
    // No pathspec on purpose: since git 2.0 that means the whole working tree
    // whatever directory this runs in, and a thread's cwd is not always the top
    // of its worktree.
    add.args(["add", "-A"]);
    git_run(add)?;

    let mut last_err = String::new();
    for attempt in 0..4 {
        let mut write = git_cmd(repo);
        with_temp_index(&mut write, index);
        write.arg("write-tree");
        match git_run(write) {
            Ok(out) => return Ok(String::from_utf8_lossy(&out).trim().to_string()),
            Err(e) if windows_object_lock(&e) && attempt < 3 => {
                last_err = e;
                std::thread::sleep(Duration::from_millis(15 * (attempt + 1) as u64));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last_err)
}

/// Windows refuses a second create of the same loose object while the first
/// write still holds the file. Four threads checkpointing one worktree all
/// write the same blobs, and `write-tree` then fails with Permission denied.
fn windows_object_lock(err: &str) -> bool {
    err.contains("Permission denied") && err.contains(".git/objects/")
}

fn is_repo(repo: &Path) -> bool {
    if !repo.is_dir() {
        return false;
    }
    let mut cmd = git_cmd(repo);
    cmd.args(["rev-parse", "--is-inside-work-tree"]);
    matches!(git_run(cmd), Ok(out) if String::from_utf8_lossy(&out).trim() == "true")
}

/// Takes a checkpoint of a worktree, or answers that there is nothing to take
/// one of.
///
/// `Ok(None)` is a directory that is not a git repository, which is an ordinary
/// thing for a thread to be running in and not a failure to report. Everything
/// else that goes wrong is an error, and the caller logs it and lets the turn
/// carry on: a capture must never be able to stop a turn.
pub fn capture_blocking(
    repo: &str,
    thread_id: &str,
    edge: Edge,
) -> Result<Option<Checkpoint>, String> {
    let path = Path::new(repo);
    if !is_repo(path) {
        return Ok(None);
    }
    let prefix = thread_ref_prefix(thread_id)?;
    let existing = list_under(path, &prefix)?;
    let previous = existing.last().cloned();
    let index = existing.last().map(|c| c.index).unwrap_or(0) + 1;

    let (git_dir, real_index) = git_paths(path)?;
    let temp = TempIndex::seeded_from(&git_dir, &real_index)?;
    let tree = write_worktree_tree(path, &temp)?;

    let delta = match &previous {
        Some(prev) => numstat_total(path, &prev.sha, &tree)?,
        None => (0, 0, 0),
    };

    // One line, and the metadata is in it. A ref points at an object and nothing
    // else, so the commit's own subject is the only place a checkpoint can carry
    // what it cost without a table beside it — and keeping it to a single line
    // is what lets `for-each-ref` hand back one record per line.
    let message = format!(
        "boite checkpoint {} {}\n",
        index,
        serde_json::json!({
            "edge": edge.as_str(),
            "files": delta.0,
            "add": delta.1,
            "del": delta.2,
        })
    );
    let mut commit = git_cmd(path);
    commit.args(["commit-tree", &tree]);
    if let Some(prev) = &previous {
        commit.args(["-p", &prev.sha]);
    }
    commit.args(["-m", &message]);
    // Pinned rather than inherited: a repository with no `user.email` configured
    // would refuse to write the object at all, and a checkpoint is Boite's, not
    // the user's, so it must not borrow their name either.
    commit.env("GIT_AUTHOR_NAME", "Boite");
    commit.env("GIT_AUTHOR_EMAIL", "checkpoint@boite.invalid");
    commit.env("GIT_COMMITTER_NAME", "Boite");
    commit.env("GIT_COMMITTER_EMAIL", "checkpoint@boite.invalid");
    let sha = String::from_utf8_lossy(&git_run(commit)?).trim().to_string();

    let mut update = git_cmd(path);
    update.args(["update-ref", &format!("{prefix}/{index}"), &sha]);
    git_run(update)?;

    prune(path, &prefix, &existing)?;

    Ok(Some(Checkpoint {
        index,
        sha,
        edge,
        at: crate::now_ms(),
        files: delta.0,
        additions: delta.1,
        deletions: delta.2,
    }))
}

/// Every checkpoint this thread still has, oldest first.
pub fn list_blocking(repo: &str, thread_id: &str) -> Result<Vec<Checkpoint>, String> {
    let path = Path::new(repo);
    if !is_repo(path) {
        return Ok(Vec::new());
    }
    list_under(path, &thread_ref_prefix(thread_id)?)
}

fn list_under(repo: &Path, prefix: &str) -> Result<Vec<Checkpoint>, String> {
    let mut cmd = git_cmd(repo);
    cmd.args([
        "for-each-ref",
        "--format=%(refname)\t%(objectname)\t%(committerdate:unix)\t%(contents:subject)",
        prefix,
    ]);
    let out = git_run(cmd)?;
    let text = String::from_utf8_lossy(&out);
    let mut found: Vec<Checkpoint> = text.lines().filter_map(parse_ref_line).collect();
    found.sort_by_key(|c| c.index);
    Ok(found)
}

fn parse_ref_line(line: &str) -> Option<Checkpoint> {
    let mut fields = line.split('\t');
    let refname = fields.next()?;
    let sha = fields.next()?.to_string();
    let seconds: i64 = fields.next()?.trim().parse().ok()?;
    let subject = fields.next()?;
    let index: u32 = refname.rsplit('/').next()?.parse().ok()?;
    let start = subject.find('{')?;
    let meta: serde_json::Value = serde_json::from_str(&subject[start..]).ok()?;
    Some(Checkpoint {
        index,
        sha,
        edge: Edge::parse(meta.get("edge")?.as_str()?)?,
        at: seconds * 1000,
        files: meta.get("files").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        additions: meta.get("add").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        deletions: meta.get("del").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
    })
}

fn prune(repo: &Path, prefix: &str, existing: &[Checkpoint]) -> Result<(), String> {
    // `existing` is what was there before the new one, so the new one counts as
    // one of the survivors.
    if existing.len() < KEEP_PER_THREAD {
        return Ok(());
    }
    let doomed = &existing[..existing.len() + 1 - KEEP_PER_THREAD];
    delete_refs(
        repo,
        doomed
            .iter()
            .map(|c| format!("{prefix}/{}", c.index))
            .collect(),
    )
}

/// Drops every checkpoint of a thread. What a deleted thread leaves behind.
pub fn forget_blocking(repo: &str, thread_id: &str) -> Result<(), String> {
    let path = Path::new(repo);
    if !is_repo(path) {
        return Ok(());
    }
    let prefix = thread_ref_prefix(thread_id)?;
    let names = list_under(path, &prefix)?
        .iter()
        .map(|c| format!("{prefix}/{}", c.index))
        .collect();
    delete_refs(path, names)
}

/// One `update-ref --stdin` rather than one process per ref, because a prune
/// after a capture would otherwise spawn as many gits as it drops.
fn delete_refs(repo: &Path, names: Vec<String>) -> Result<(), String> {
    if names.is_empty() {
        return Ok(());
    }
    use std::io::Write;
    use std::process::Stdio;

    let mut cmd = git_cmd(repo);
    cmd.args(["update-ref", "--stdin", "-z"]);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("git not found or failed to start: {e}"))?;
    {
        let stdin = child.stdin.as_mut().ok_or("git took no input")?;
        for name in &names {
            stdin
                .write_all(format!("delete {name}\0\0").as_bytes())
                .map_err(|e| format!("could not drop a checkpoint: {e}"))?;
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("could not drop a checkpoint: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// What changed between two checkpoints.
///
/// `patch` is only produced when asked for: a panel draws the file list, and the
/// whole unified diff is what something reading a turn as text wants.
pub fn diff_blocking(repo: &str, from: &str, to: &str, patch: bool) -> Result<Diff, String> {
    // Once here, because the three `git diff` runs below and the two helpers
    // they call are only ever reached through this function.
    checked_rev(from)?;
    checked_rev(to)?;
    let path = Path::new(repo);
    let mut files = name_status(path, from, to)?;
    let counts = numstat(path, from, to)?;
    for file in &mut files {
        if let Some((add, del, binary)) = counts.get(&file.path) {
            file.additions = *add;
            file.deletions = *del;
            file.binary = *binary;
        }
    }

    let (text, truncated) = if patch {
        let mut cmd = git_cmd(path);
        cmd.args(["diff", from, to]);
        let out = git_run(cmd)?;
        let whole = String::from_utf8_lossy(&out).into_owned();
        if whole.len() > MAX_PATCH_BYTES {
            let mut cut = MAX_PATCH_BYTES;
            while cut > 0 && !whole.is_char_boundary(cut) {
                cut -= 1;
            }
            (whole[..cut].to_string(), true)
        } else {
            (whole, false)
        }
    } else {
        (String::new(), false)
    };

    Ok(Diff {
        files,
        patch: text,
        truncated,
    })
}

fn name_status(repo: &Path, from: &str, to: &str) -> Result<Vec<ChangedFile>, String> {
    let mut cmd = git_cmd(repo);
    cmd.args(["diff", "--name-status", "-z", "--find-renames", from, to]);
    let out = git_run(cmd)?;
    let text = String::from_utf8_lossy(&out);
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let letter = status.chars().next().unwrap_or('M');
        // A rename or a copy sends two paths, in that order.
        let (orig_path, path) = if matches!(letter, 'R' | 'C') {
            let a = fields.next().unwrap_or_default().to_string();
            let b = match fields.next() {
                Some(b) => b.to_string(),
                None => a.clone(),
            };
            (Some(a), b)
        } else {
            (None, fields.next().unwrap_or_default().to_string())
        };
        if path.is_empty() {
            continue;
        }
        files.push(ChangedFile {
            path,
            status: letter.to_string(),
            orig_path,
            additions: 0,
            deletions: 0,
            binary: false,
        });
    }
    Ok(files)
}

type Counts = std::collections::HashMap<String, (u32, u32, bool)>;

fn numstat(repo: &Path, from: &str, to: &str) -> Result<Counts, String> {
    let mut cmd = git_cmd(repo);
    cmd.args(["diff", "--numstat", "-z", "--find-renames", from, to]);
    let out = git_run(cmd)?;
    let text = String::from_utf8_lossy(&out);
    let mut counts = Counts::new();
    // With `-z` a numstat record is `add\tdel\t` then the path as its own
    // NUL-terminated field, and a rename sends the old path and the new one.
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    while let Some(record) = fields.next() {
        let mut parts = record.split('\t');
        let add = parts.next().unwrap_or_default();
        let del = parts.next().unwrap_or_default();
        let inline = parts.next().unwrap_or_default();
        let binary = add == "-" || del == "-";
        let path = if inline.is_empty() {
            let old = fields.next().unwrap_or_default();
            fields.next().unwrap_or(old).to_string()
        } else {
            inline.to_string()
        };
        if path.is_empty() {
            continue;
        }
        counts.insert(
            path,
            (
                add.parse().unwrap_or(0),
                del.parse().unwrap_or(0),
                binary,
            ),
        );
    }
    Ok(counts)
}

fn numstat_total(repo: &Path, from: &str, to: &str) -> Result<(u32, u32, u32), String> {
    let counts = numstat(repo, from, to)?;
    let files = counts.len() as u32;
    let add = counts.values().map(|c| c.0).sum();
    let del = counts.values().map(|c| c.1).sum();
    Ok((files, add, del))
}

/// One file as it stood at each end of a turn, for the diff view.
pub fn file_at_edges_blocking(
    repo: &str,
    from: &str,
    to: &str,
    file: &str,
) -> Result<FileAtEdges, String> {
    checked_rev(from)?;
    checked_rev(to)?;
    let path = Path::new(repo);
    let rel = file.replace('\\', "/");
    repo_relative(&rel)?;
    let (before, before_binary) = git_show(path, &format!("{from}:{rel}"));
    let (after, after_binary) = git_show(path, &format!("{to}:{rel}"));
    Ok(FileAtEdges {
        before,
        after,
        binary: before_binary || after_binary,
    })
}

/// Puts the working tree back to what a checkpoint holds. **The tree only.**
///
/// Not the index, not HEAD, not any branch, and above all not the agent's
/// conversation — Boite has no way to rewind that, and a caller that implies
/// otherwise is lying to the user.
///
/// The route is a two-tree `read-tree -m` against a throwaway index holding the
/// worktree as it is right now. That is what makes the restore exact in both
/// directions: a file the turn created is removed, not merely left behind, and a
/// file it deleted comes back. Doing it against the *real* index instead would
/// have restored the files and staged the whole thing as a side effect.
///
/// Exact in both directions is also what makes it dangerous, so it takes a
/// [`Edge::Restore`] checkpoint of the worktree first and refuses to go on if
/// that fails. Without it this is the one operation in Boite that destroys work
/// with no way back: the index it merges against was seeded by `add -A`, so an
/// untracked file counts as tracked and is deleted rather than left alone, and
/// what a user did in the hours since the turn ended goes with it. With it, the
/// state being overwritten is a commit in the repository like any other and the
/// revert can itself be reverted.
pub fn restore_blocking(repo: &str, thread_id: &str, sha: &str) -> Result<(), String> {
    checked_rev(sha)?;
    let path = Path::new(repo);
    if !is_repo(path) {
        return Err("not a git repository".into());
    }
    // Before anything is touched, and its failure aborts the restore: a safety
    // net that did not open is worse than not jumping at all.
    capture_blocking(repo, thread_id, Edge::Restore)?;

    let (git_dir, real_index) = git_paths(path)?;
    let temp = TempIndex::seeded_from(&git_dir, &real_index)?;
    let now = write_worktree_tree(path, &temp)?;

    let mut read = git_cmd(path);
    with_temp_index(&mut read, &temp);
    read.args(["read-tree", "-u", "-m", &now, &format!("{sha}^{{tree}}")]);
    git_run(read)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "boite-ckpt-{tag}-{}-{nonce}-{seq}",
            std::process::id()
        ))
    }

    fn git_in(path: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    struct Repo {
        dir: PathBuf,
    }

    impl Repo {
        fn empty(tag: &str) -> Self {
            let dir = scratch(tag);
            fs::create_dir_all(&dir).unwrap();
            git_in(&dir, &["init", "--quiet"]);
            git_in(&dir, &["config", "user.name", "Boite Test"]);
            git_in(&dir, &["config", "user.email", "boite@example.test"]);
            // The developer's own `core.autocrlf=true` otherwise reaches in here
            // and a restore hands back CRLF for content written as LF, which is
            // git behaving correctly and the assertions below reading as if it
            // were not.
            git_in(&dir, &["config", "core.autocrlf", "false"]);
            git_in(&dir, &["branch", "-M", "master"]);
            Self { dir }
        }

        fn with_commit(tag: &str) -> Self {
            let repo = Self::empty(tag);
            repo.write("a.txt", "one\n");
            git_in(&repo.dir, &["add", "a.txt"]);
            git_in(&repo.dir, &["commit", "--quiet", "-m", "initial"]);
            repo
        }

        fn path(&self) -> &str {
            self.dir.to_str().unwrap()
        }

        fn write(&self, rel: &str, body: &str) {
            let target = self.dir.join(rel);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(target, body).unwrap();
        }

        fn read(&self, rel: &str) -> Option<String> {
            fs::read_to_string(self.dir.join(rel)).ok()
        }

        fn status(&self) -> String {
            let out = Command::new("git")
                .current_dir(&self.dir)
                .args(["status", "--porcelain"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn a_capture_carries_untracked_files_and_leaves_git_status_alone() {
        let repo = Repo::with_commit("clean");
        repo.write("untracked.txt", "hello\n");
        repo.write(".gitignore", "ignored.txt\n");
        repo.write("ignored.txt", "no\n");
        let before = repo.status();

        let one = capture_blocking(repo.path(), "thread-1", Edge::Start)
            .unwrap()
            .unwrap();
        assert_eq!(one.index, 1);
        assert_eq!(one.edge, Edge::Start);

        assert_eq!(
            repo.status(),
            before,
            "a checkpoint must not show up in git status"
        );

        let listed = list_ls_tree(&repo.dir, &one.sha);
        assert!(listed.contains("untracked.txt"), "{listed}");
        assert!(
            !listed.contains("ignored.txt"),
            "gitignore is the user's rule, not ours: {listed}"
        );
    }

    fn list_ls_tree(dir: &Path, sha: &str) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(["ls-tree", "-r", "--name-only", sha])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn a_repository_with_no_commits_and_a_detached_head_both_check_point() {
        let empty = Repo::empty("no-commits");
        empty.write("first.txt", "one\n");
        let taken = capture_blocking(empty.path(), "t", Edge::Start)
            .unwrap()
            .unwrap();
        assert!(list_ls_tree(&empty.dir, &taken.sha).contains("first.txt"));

        let detached = Repo::with_commit("detached");
        git_in(&detached.dir, &["checkout", "--quiet", "--detach"]);
        detached.write("b.txt", "two\n");
        let taken = capture_blocking(detached.path(), "t", Edge::End)
            .unwrap()
            .unwrap();
        assert!(list_ls_tree(&detached.dir, &taken.sha).contains("b.txt"));
    }

    #[test]
    fn a_directory_that_is_not_a_repository_is_not_a_failure() {
        let dir = scratch("plain");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            capture_blocking(dir.to_str().unwrap(), "t", Edge::Start).unwrap(),
            None
        );
        assert!(list_blocking(dir.to_str().unwrap(), "t").unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_turn_is_the_diff_between_its_two_checkpoints() {
        let repo = Repo::with_commit("diff");
        repo.write("kept.txt", "same\n");
        let start = capture_blocking(repo.path(), "t", Edge::Start)
            .unwrap()
            .unwrap();

        repo.write("a.txt", "one\ntwo\n");
        repo.write("new.txt", "fresh\n");
        fs::remove_file(repo.dir.join("kept.txt")).unwrap();
        let end = capture_blocking(repo.path(), "t", Edge::End)
            .unwrap()
            .unwrap();

        assert_eq!(end.files, 3, "one modified, one added, one deleted");
        assert_eq!(end.index, 2);

        let diff = diff_blocking(repo.path(), &start.sha, &end.sha, true).unwrap();
        let mut names: Vec<_> = diff
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![("a.txt", "M"), ("kept.txt", "D"), ("new.txt", "A")]
        );
        let modified = diff.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((modified.additions, modified.deletions), (1, 0));
        assert!(diff.patch.contains("+two"), "{}", diff.patch);
        assert!(!diff.truncated);

        let versions = file_at_edges_blocking(repo.path(), &start.sha, &end.sha, "a.txt").unwrap();
        assert_eq!(versions.before.as_deref(), Some("one\n"));
        assert_eq!(versions.after.as_deref(), Some("one\ntwo\n"));

        // Asked for nothing, so nothing is produced: the panel reads the list.
        assert!(diff_blocking(repo.path(), &start.sha, &end.sha, false)
            .unwrap()
            .patch
            .is_empty());
    }

    #[test]
    fn a_restore_puts_the_files_back_and_takes_the_new_ones_away() {
        let repo = Repo::with_commit("restore");
        repo.write("stays.txt", "before\n");
        let start = capture_blocking(repo.path(), "t", Edge::Start)
            .unwrap()
            .unwrap();

        repo.write("stays.txt", "after\n");
        repo.write("appeared.txt", "new\n");
        fs::remove_file(repo.dir.join("a.txt")).unwrap();

        restore_blocking(repo.path(), "t", &start.sha).unwrap();

        assert_eq!(repo.read("stays.txt").as_deref(), Some("before\n"));
        assert_eq!(repo.read("a.txt").as_deref(), Some("one\n"));
        assert_eq!(
            repo.read("appeared.txt"),
            None,
            "a file the turn created has to go, not merely be left behind"
        );
    }

    #[test]
    fn a_restore_stages_nothing() {
        let repo = Repo::with_commit("restore-index");
        repo.write("staged.txt", "staged\n");
        git_in(&repo.dir, &["add", "staged.txt"]);
        let start = capture_blocking(repo.path(), "t", Edge::Start)
            .unwrap()
            .unwrap();
        let before = repo.status();

        repo.write("a.txt", "changed\n");
        restore_blocking(repo.path(), "t", &start.sha).unwrap();

        assert_eq!(
            repo.status(),
            before,
            "restoring the tree must not touch what the user had staged"
        );
    }

    /// The whole point of the safety net: everything the restore is about to
    /// throw away has to be reachable afterwards, untracked files included,
    /// since those are exactly what `read-tree -u -m` deletes without asking.
    #[test]
    fn a_restore_check_points_what_it_is_about_to_overwrite() {
        let repo = Repo::with_commit("restore-net");
        let start = capture_blocking(repo.path(), "t", Edge::Start)
            .unwrap()
            .unwrap();

        repo.write("a.txt", "the user's own edit\n");
        repo.write("never-committed.txt", "an hour of work\n");
        restore_blocking(repo.path(), "t", &start.sha).unwrap();

        assert_eq!(repo.read("never-committed.txt"), None, "the restore ran");

        let net = list_blocking(repo.path(), "t").unwrap().pop().unwrap();
        assert_eq!(net.edge, Edge::Restore);
        let listed = list_ls_tree(&repo.dir, &net.sha);
        assert!(listed.contains("never-committed.txt"), "{listed}");
        // And it is a real way back, not just a record that something was lost.
        restore_blocking(repo.path(), "t", &net.sha).unwrap();
        assert_eq!(
            repo.read("never-committed.txt").as_deref(),
            Some("an hour of work\n")
        );
        assert_eq!(repo.read("a.txt").as_deref(), Some("the user's own edit\n"));
    }

    /// `from`, `to` and `sha` are the first positional tokens of a git command
    /// that has no `--` to hide behind, so anything option-shaped reaching them
    /// is git writing where the caller's roots said it could not.
    #[test]
    fn a_revision_that_is_not_an_object_name_is_refused() {
        let repo = Repo::with_commit("argv");
        let escape = "--output=/tmp/boite-checkpoint-escape";
        for bad in [escape, "", "abc", "HEAD", "master", &"a".repeat(65), "abcdefg-"] {
            assert!(
                diff_blocking(repo.path(), bad, "abcdef1", false).is_err(),
                "diff took {bad} as a revision"
            );
            assert!(
                diff_blocking(repo.path(), "abcdef1", bad, false).is_err(),
                "diff took {bad} as a revision"
            );
            assert!(
                file_at_edges_blocking(repo.path(), bad, "abcdef1", "a.txt").is_err(),
                "fileVersions took {bad} as a revision"
            );
            assert!(
                restore_blocking(repo.path(), "t", bad).is_err(),
                "restore took {bad} as a revision"
            );
        }
        assert!(
            !Path::new("/tmp/boite-checkpoint-escape").exists(),
            "git wrote a file the roots check never saw"
        );
        // A real object name still goes through, whether abbreviated or whole.
        let taken = capture_blocking(repo.path(), "t", Edge::Start)
            .unwrap()
            .unwrap();
        assert!(diff_blocking(repo.path(), &taken.sha[..7], &taken.sha, false).is_ok());
    }

    #[test]
    fn a_thread_keeps_a_bounded_number_of_checkpoints() {
        let repo = Repo::with_commit("prune");
        for n in 0..KEEP_PER_THREAD + 5 {
            repo.write("a.txt", &format!("{n}\n"));
            capture_blocking(repo.path(), "t", Edge::Start).unwrap();
        }
        let kept = list_blocking(repo.path(), "t").unwrap();
        assert_eq!(kept.len(), KEEP_PER_THREAD);
        assert_eq!(kept.first().unwrap().index, 6);
        assert_eq!(
            kept.last().unwrap().index,
            KEEP_PER_THREAD as u32 + 5,
            "indexes are never reused"
        );
    }

    #[test]
    fn two_threads_in_one_worktree_do_not_see_each_other() {
        let repo = Repo::with_commit("two-threads");
        capture_blocking(repo.path(), "alpha", Edge::Start).unwrap();
        repo.write("a.txt", "moved\n");
        capture_blocking(repo.path(), "alpha", Edge::End).unwrap();
        capture_blocking(repo.path(), "beta", Edge::Start).unwrap();

        assert_eq!(list_blocking(repo.path(), "alpha").unwrap().len(), 2);
        assert_eq!(list_blocking(repo.path(), "beta").unwrap().len(), 1);

        forget_blocking(repo.path(), "alpha").unwrap();
        assert!(list_blocking(repo.path(), "alpha").unwrap().is_empty());
        assert_eq!(
            list_blocking(repo.path(), "beta").unwrap().len(),
            1,
            "deleting one thread's checkpoints must not reach another's"
        );
    }

    /// Two threads in one worktree check point off their own turn boundaries,
    /// so their captures overlap for real. Sharing a temporary index would make
    /// each one stage what the other had just added, and whichever finished
    /// first would delete the file the other was still writing through.
    #[test]
    fn captures_at_the_same_moment_do_not_share_a_temporary_index() {
        let repo = Repo::with_commit("concurrent");
        repo.write("shared.txt", "x\n");
        let path = repo.path().to_string();
        let running: Vec<_> = ["alpha", "beta", "gamma", "delta"]
            .into_iter()
            .map(|thread| {
                let path = path.clone();
                std::thread::spawn(move || capture_blocking(&path, thread, Edge::Start))
            })
            .collect();
        for handle in running {
            let taken = handle.join().unwrap().unwrap().unwrap();
            assert!(list_ls_tree(&repo.dir, &taken.sha).contains("shared.txt"));
        }
    }

    #[test]
    fn a_thread_id_that_is_not_a_ref_name_still_gets_a_namespace() {
        assert_eq!(
            thread_ref_prefix("a/b..c.lock").unwrap(),
            "refs/boite/ckpt/a-b--c-lock"
        );
        assert!(thread_ref_prefix("").is_err());
        assert!(thread_ref_prefix("///").is_err());
    }

    /// A ref under this namespace that Boite did not write is skipped rather
    /// than guessed at, which is what keeps one hand-made ref from making the
    /// whole list unreadable.
    #[test]
    fn a_ref_line_boite_did_not_write_is_ignored() {
        assert!(parse_ref_line("refs/boite/ckpt/t/3\tabc\t1700000000\tsomething else").is_none());
        assert!(parse_ref_line("refs/boite/ckpt/t/head\tabc\t1\tboite checkpoint 1 {\"edge\":\"start\"}").is_none());
        let good = parse_ref_line(
            "refs/boite/ckpt/t/3\tabc\t1700000000\tboite checkpoint 3 {\"edge\":\"end\",\"files\":2,\"add\":9,\"del\":1}",
        )
        .unwrap();
        assert_eq!(good.index, 3);
        assert_eq!(good.edge, Edge::End);
        assert_eq!(good.at, 1_700_000_000_000);
        assert_eq!((good.files, good.additions, good.deletions), (2, 9, 1));
    }

    #[test]
    fn the_edges_round_trip() {
        for edge in [Edge::Start, Edge::End, Edge::Restore] {
            assert_eq!(Edge::parse(edge.as_str()), Some(edge));
        }
        assert_eq!(Edge::parse("waiting"), None);
    }
}
