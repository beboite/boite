//! The local clone this machine syncs through, and the only file here that runs
//! git.
//!
//! It lives at `~/.boite/sync/mirror`, inside the directory Boite already owns
//! on every platform. Not beside the app config, because `boite_core` cannot
//! reach Tauri's application directory — that is the host's to know — and a path
//! handed in by the host would differ between the desktop and a `boite-server`
//! running on *the same machine*, leaving one home with two mirrors fighting
//! each other. And because when something goes wrong,
//! `cd ~/.boite/sync/mirror && git status` is a support path a user will
//! actually take.
//!
//! A normal checkout rather than a bare clone: the merge tool wants real file
//! paths, and so does the person opening it by hand.
//!
//! Everything runs through `git::git()`, which already sets
//! `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`. That is what makes
//! "authentication is git's problem" a workable answer: a credential helper that
//! wants a terminal fails in a second with a sentence worth quoting, rather than
//! holding a background job open until somebody notices.
//!
//! The mirror holds no source of truth. The home directory has one copy and the
//! remote has the other, so resetting it is always safe and never loses
//! anything a user typed.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::git::{git, run};

/// Matches the fetch budget the rest of the crate uses.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// And the push one. A push carries more and is allowed longer.
const PUSH_TIMEOUT: Duration = Duration::from_secs(60);

/// The ref that remembers where this machine got to.
///
/// Local, and never pushed. Its absence means "this machine has never synced",
/// which the comparison reads as an empty base — the property the first-sync
/// rule depends on. A git note would be the wrong tool: notes are shared
/// objects and this must not travel.
const BASE_REF: &str = "refs/boite/base";

/// What is committed at the root so a machine whose global git configuration
/// Boite never touched still gets raw bytes.
const ATTRIBUTES: &str = "* -text -diff\n";

/// Declares what wrote the repository, so a newer layout can be refused rather
/// than mangled by an older Boite.
const STAMP_FILE: &str = "boite-sync.json";
const STAMP: &str = "{\n  \"version\": 1,\n  \"homeToken\": \"${BOITE_HOME}\"\n}\n";
const STAMP_VERSION: u64 = 1;

pub type Files = BTreeMap<String, Vec<u8>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failed {
    /// No repository address has been given yet. Refused before any work starts,
    /// rather than after a job row exists and a spinner is turning.
    NoRemote,
    /// Something is at the mirror path that is not a repository. Named, and
    /// never removed.
    NotARepository(String),
    /// A previous sync died part way through. Recovering automatically would
    /// mean overwriting, so this asks instead.
    Dirty(Vec<String>),
    /// The repository was written by a newer Boite.
    TooNew(u64),
    Git(String),
}

impl Failed {
    pub fn message(&self) -> String {
        match self {
            Failed::NoRemote => {
                "no repository has been named, so there is nothing to sync with".to_string()
            }
            Failed::NotARepository(path) => {
                format!("{path} is not a git repository; move it aside or choose another folder")
            }
            Failed::Dirty(paths) => format!(
                "the local mirror has unfinished changes in {}; run the repair action to reset it",
                paths.join(", ")
            ),
            Failed::TooNew(version) => format!(
                "the repository was written by a newer Boite (layout {version}); update this one"
            ),
            Failed::Git(message) => message.clone(),
        }
    }
}

/// What `git ls-remote` said, so an address can be checked without a clone.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub reachable: bool,
    /// It answers and holds nothing. The first sync fills it.
    pub empty: bool,
    /// It refused. The fix is a git credential on the machine the threads run
    /// on, not a field in Boite.
    pub needs_auth: bool,
    pub message: Option<String>,
}

/// Where the mirror lives, under the directory Boite owns.
pub fn mirror_dir(home: &Path) -> PathBuf {
    home.join(".boite").join("sync").join("mirror")
}

/// Where replaced contents are kept.
pub fn backup_dir(home: &Path) -> PathBuf {
    home.join(".boite").join("sync").join("backup")
}

/// Asks an address whether it is there, without cloning it.
pub fn probe(url: &str) -> Probe {
    let mut cmd = git(Path::new("."));
    cmd.args(["ls-remote", "--heads", url]);
    match run_capturing(cmd, FETCH_TIMEOUT) {
        Ok(out) => Probe {
            reachable: true,
            empty: String::from_utf8_lossy(&out).trim().is_empty(),
            needs_auth: false,
            message: None,
        },
        Err(message) => Probe {
            reachable: false,
            empty: false,
            needs_auth: reads_as_auth(&message),
            message: Some(message),
        },
    }
}

/// Whether git's own words mean "nobody could prove who you are".
///
/// Matched on the English text because `git()` pins `LC_ALL=C` for exactly this
/// reason: under a French locale none of these would match and the user would
/// get raw output instead of the one sentence that helps.
pub fn reads_as_auth(message: &str) -> bool {
    const MARKERS: &[&str] = &[
        "Authentication failed",
        "could not read Username",
        "could not read Password",
        "Permission denied (publickey)",
        "terminal prompts disabled",
        "Support for password authentication was removed",
        "403",
    ];
    MARKERS.iter().any(|marker| message.contains(marker))
}

/// Whether git's own words mean "somebody else pushed while you were working".
pub fn reads_as_rejected(message: &str) -> bool {
    const MARKERS: &[&str] = &["[rejected]", "non-fast-forward", "fetch first", "Updates were rejected"];
    MARKERS.iter().any(|marker| message.contains(marker))
}

/// The clone, made if it is not there and checked if it is.
pub fn open(dir: &Path, url: Option<&str>) -> Result<(), Failed> {
    let Some(url) = url else {
        return Err(Failed::NoRemote);
    };
    if dir.join(".git").exists() {
        set_remote(dir, url)?;
        return check_stamp(dir);
    }
    if dir.exists() && dir.read_dir().map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(Failed::NotARepository(dir.display().to_string()));
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|error| Failed::Git(error.to_string()))?;
    }
    let mut cmd = git(dir.parent().unwrap_or(Path::new(".")));
    cmd.args([
        // Git for Windows installs autocrlf true. Without pinning it here the
        // checkout rewrites every line ending and the comparison is diverged
        // for good, on files that nobody touched.
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.safecrlf=false",
        "clone",
        "--quiet",
        url,
    ]);
    cmd.arg(dir);
    run_capturing(cmd, PUSH_TIMEOUT).map_err(Failed::Git)?;
    for (key, value) in
        [("core.autocrlf", "false"), ("core.safecrlf", "false"), ("core.fileMode", "false")]
    {
        let mut cmd = git(dir);
        cmd.args(["config", key, value]);
        let _ = run(cmd);
    }
    check_stamp(dir)
}

fn set_remote(dir: &Path, url: &str) -> Result<(), Failed> {
    if remote_url(dir).as_deref() == Some(url) {
        return Ok(());
    }
    let mut cmd = git(dir);
    if remote_url(dir).is_some() {
        cmd.args(["remote", "set-url", "origin", url]);
    } else {
        cmd.args(["remote", "add", "origin", url]);
    }
    run(cmd).map(|_| ()).map_err(Failed::Git)
}

pub fn remote_url(dir: &Path) -> Option<String> {
    let mut cmd = git(dir);
    cmd.args(["remote", "get-url", "origin"]);
    let out = run(cmd).ok()?;
    let url = String::from_utf8_lossy(&out).trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// The branch this mirror tracks, taken from the clone rather than assumed.
pub fn branch(dir: &Path) -> String {
    let mut cmd = git(dir);
    cmd.args(["symbolic-ref", "--short", "HEAD"]);
    match run(cmd) {
        Ok(out) => {
            let name = String::from_utf8_lossy(&out).trim().to_string();
            if name.is_empty() {
                "main".to_string()
            } else {
                name
            }
        }
        Err(_) => "main".to_string(),
    }
}

/// Refuses when a previous sync left work behind.
///
/// Recovering on its own would mean writing over whatever is there, which is the
/// one thing this feature does not do. `repair` is the way out, and it is a
/// separate action so that it is chosen rather than stumbled into.
pub fn require_clean(dir: &Path) -> Result<(), Failed> {
    let mut cmd = git(dir);
    cmd.args(["status", "--porcelain"]);
    let out = run(cmd).map_err(Failed::Git)?;
    let text = String::from_utf8_lossy(&out);
    let paths: Vec<String> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(20)
        .map(|line| line[3.min(line.len())..].to_string())
        .collect();
    if paths.is_empty() {
        Ok(())
    } else {
        Err(Failed::Dirty(paths))
    }
}

/// Resets the mirror and nothing else.
///
/// Safe because the mirror holds no source of truth: the home directory has one
/// copy and the remote has the other. `git clean` rather than `remove_dir_all`,
/// which on Windows walks into a junction and empties what it points at.
pub fn repair(dir: &Path) -> Result<(), Failed> {
    for args in [["reset", "--hard", "HEAD"], ["clean", "-fd", "--"]] {
        let mut cmd = git(dir);
        cmd.args(args);
        let _ = run(cmd);
    }
    Ok(())
}

pub fn fetch(dir: &Path) -> Result<(), Failed> {
    let mut cmd = git(dir);
    cmd.args(["fetch", "origin", "--prune", "--quiet"]);
    run_capturing(cmd, FETCH_TIMEOUT).map(|_| ()).map_err(Failed::Git)
}

/// Brings the working tree to what the remote holds.
///
/// Only ever called on a clean mirror, so nothing is discarded. When the remote
/// has no branch yet — an empty repository, the first machine — there is nothing
/// to move to and the tree stays where it is.
pub fn adopt_remote(dir: &Path, branch: &str) -> Result<(), Failed> {
    if !has_rev(dir, &format!("origin/{branch}")) {
        return Ok(());
    }
    let mut cmd = git(dir);
    cmd.args(["reset", "--hard", &format!("origin/{branch}")]);
    run(cmd).map(|_| ()).map_err(Failed::Git)
}

fn has_rev(dir: &Path, rev: &str) -> bool {
    let mut cmd = git(dir);
    cmd.args(["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]);
    run(cmd).map(|out| !out.is_empty()).unwrap_or(false)
}

/// Every file a revision holds, read from the object store rather than the
/// working tree.
///
/// A working tree can be half-applied; a revision cannot. One `cat-file --batch`
/// for the lot rather than one process per file, because `~/.agents` is allowed
/// two thousand of them.
pub fn read_tree(dir: &Path, rev: &str) -> Result<Files, Failed> {
    if !has_rev(dir, rev) {
        return Ok(Files::new());
    }
    let mut cmd = git(dir);
    cmd.args(["ls-tree", "-r", "-z", "--name-only", rev]);
    let listing = run(cmd).map_err(Failed::Git)?;
    let paths: Vec<String> = String::from_utf8_lossy(&listing)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| path.to_string())
        .collect();
    let wanted: Vec<String> = paths
        .into_iter()
        .filter(|path| path != STAMP_FILE && path != ".gitattributes")
        .collect();
    if wanted.is_empty() {
        return Ok(Files::new());
    }
    batch_read(dir, rev, &wanted)
}

/// Reads many blobs through one `cat-file --batch`.
///
/// stdin is written from a thread of its own: the request list outgrows a pipe
/// buffer at a few thousand paths, and writing it all before reading anything
/// would deadlock against a child that is waiting for its output to be drained.
fn batch_read(dir: &Path, rev: &str, paths: &[String]) -> Result<Files, Failed> {
    let mut cmd = git(dir);
    cmd.args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|error| Failed::Git(format!("git could not be started: {error}")))?;

    let requests: Vec<String> = paths.iter().map(|path| format!("{rev}:{path}\n")).collect();
    let mut stdin = child.stdin.take().ok_or_else(|| Failed::Git("no stdin".into()))?;
    let writer = std::thread::spawn(move || {
        for request in requests {
            if stdin.write_all(request.as_bytes()).is_err() {
                return;
            }
        }
    });

    let mut raw = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        stdout
            .read_to_end(&mut raw)
            .map_err(|error| Failed::Git(format!("git output could not be read: {error}")))?;
    }
    let _ = writer.join();
    let _ = child.wait();

    let mut files = Files::new();
    let mut cursor = 0usize;
    for path in paths {
        let Some(newline) = raw[cursor..].iter().position(|byte| *byte == b'\n') else {
            break;
        };
        let header = String::from_utf8_lossy(&raw[cursor..cursor + newline]).to_string();
        cursor += newline + 1;
        // "<sha> missing" for anything that is not there, and no body follows.
        let Some(size) = header.rsplit(' ').next().and_then(|size| size.parse::<usize>().ok())
        else {
            continue;
        };
        if cursor + size > raw.len() {
            break;
        }
        files.insert(path.clone(), raw[cursor..cursor + size].to_vec());
        // The body is followed by a newline git adds itself.
        cursor += size + 1;
    }
    Ok(files)
}

/// Puts files in the working tree, and removes none.
///
/// Removing would be how a deletion propagates, and it does not. The two files
/// that describe the repository itself are written on the way past, so a
/// repository made by hand still gets them.
pub fn stage(dir: &Path, files: &Files) -> Result<(), Failed> {
    write_if_absent(dir, ".gitattributes", ATTRIBUTES)?;
    write_if_absent(dir, STAMP_FILE, STAMP)?;
    for (path, bytes) in files {
        let full = dir.join(as_native(path));
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|error| Failed::Git(error.to_string()))?;
        }
        std::fs::write(&full, bytes).map_err(|error| Failed::Git(error.to_string()))?;
    }
    Ok(())
}

fn write_if_absent(dir: &Path, name: &str, contents: &str) -> Result<(), Failed> {
    let path = dir.join(name);
    if path.exists() {
        return Ok(());
    }
    std::fs::write(&path, contents).map_err(|error| Failed::Git(error.to_string()))
}

fn check_stamp(dir: &Path) -> Result<(), Failed> {
    let Ok(text) = std::fs::read_to_string(dir.join(STAMP_FILE)) else {
        return Ok(());
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(());
    };
    match value.get("version").and_then(serde_json::Value::as_u64) {
        Some(version) if version > STAMP_VERSION => Err(Failed::TooNew(version)),
        _ => Ok(()),
    }
}

/// Commits whatever the working tree now holds, or answers `None` when nothing
/// changed.
///
/// The identity is passed per invocation and never written into the mirror's
/// config, with a synthetic fallback: a machine with no global `user.email`
/// would otherwise fail the commit and take the whole sync down with a message
/// about git configuration.
pub fn commit(dir: &Path, message: &str) -> Result<Option<String>, Failed> {
    let mut add = git(dir);
    add.args(["add", "-A", "--"]);
    add.arg(".");
    run(add).map_err(Failed::Git)?;

    let mut staged = git(dir);
    staged.args(["diff", "--cached", "--quiet"]);
    if staged.status().map(|status| status.success()).unwrap_or(false) {
        return Ok(None);
    }

    let mut cmd = git(dir);
    cmd.args([
        "-c",
        "user.name=boite",
        "-c",
        "user.email=sync@boite.local",
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        message,
    ]);
    run(cmd).map_err(Failed::Git)?;
    Ok(head(dir))
}

pub fn head(dir: &Path) -> Option<String> {
    let mut cmd = git(dir);
    cmd.args(["rev-parse", "HEAD"]);
    let out = run(cmd).ok()?;
    let sha = String::from_utf8_lossy(&out).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

/// Sends this machine's side.
///
/// The refspec is written in full so that no `push.default` and no user refspec
/// can drag `refs/boite/*` along with it — the base ref is this machine's and
/// must not travel. No force of any kind, `--force-with-lease` included: a lease
/// still discards the other machine's commit, and that is an overwrite.
pub fn push(dir: &Path, branch: &str) -> Result<(), Failed> {
    let mut cmd = git(dir);
    cmd.args(["push", "origin", &format!("HEAD:refs/heads/{branch}")]);
    run_capturing(cmd, PUSH_TIMEOUT).map(|_| ()).map_err(Failed::Git)
}

/// Where this machine got to, or `None` when it has never finished a sync.
pub fn base(dir: &Path) -> Option<String> {
    let mut cmd = git(dir);
    cmd.args(["rev-parse", "--verify", "--quiet", BASE_REF]);
    let out = run(cmd).ok()?;
    let sha = String::from_utf8_lossy(&out).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

pub fn set_base(dir: &Path, sha: &str) -> Result<(), Failed> {
    let mut cmd = git(dir);
    cmd.args(["update-ref", BASE_REF, sha]);
    run(cmd).map(|_| ()).map_err(Failed::Git)
}

/// The base tree, or an empty one — which is what makes a first sync put
/// everything in front of the merge tool.
pub fn base_tree(dir: &Path) -> Result<Files, Failed> {
    match base(dir) {
        Some(sha) => read_tree(dir, &sha),
        None => Ok(Files::new()),
    }
}

/// `run`, with the child killed if it outlives its budget.
///
/// The crate already has one of these in `git`, and it answers nothing on
/// success — right for a push, wrong for `ls-remote`, where the output *is* the
/// answer. Rather than widen a shipped signature every caller depends on, this
/// keeps its own, and keeps the one thing that version got right and is easy to
/// miss: both pipes are drained from threads. A chatty remote fills a pipe
/// buffer, which blocks the child forever and reads as a timeout that was
/// nobody's fault.
fn run_capturing(mut cmd: Command, timeout: Duration) -> Result<Vec<u8>, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child =
        cmd.spawn().map_err(|error| format!("git not found or failed to start: {error}"))?;
    let out_drain = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.read_to_end(&mut buffer);
            buffer
        })
    });
    let err_drain = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = out_drain.and_then(|drain| drain.join().ok()).unwrap_or_default();
                let err = err_drain
                    .and_then(|drain| drain.join().ok())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if status.success() {
                    return Ok(out);
                }
                return Err(if err.is_empty() {
                    format!("git exited with status {status}")
                } else {
                    err
                });
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("git took too long and was stopped".to_string());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(format!("git could not be waited on: {error}")),
        }
    }
}

fn as_native(path: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for segment in path.split('/') {
        out.push(segment);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bare repository in a temporary directory stands in for the remote, so
    /// none of this touches a network or an account.
    struct Bench(PathBuf);

    impl Bench {
        fn new(label: &str) -> Option<Self> {
            if !git_is_here() {
                eprintln!("skipping {label}: git is not on this machine");
                return None;
            }
            let root = std::env::temp_dir()
                .join("boite-sync-mirror")
                .join(format!("{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("origin")).expect("origin");
            let mut cmd = git(&root.join("origin"));
            cmd.args(["init", "--bare", "-b", "main", "--quiet"]);
            run(cmd).expect("bare origin");
            Some(Bench(root))
        }

        fn origin(&self) -> String {
            self.0.join("origin").display().to_string()
        }

        /// One machine's mirror.
        fn machine(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Bench {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn git_is_here() -> bool {
        let mut cmd = git(Path::new("."));
        cmd.arg("--version");
        run(cmd).is_ok()
    }

    fn files(pairs: &[(&str, &str)]) -> Files {
        pairs.iter().map(|(path, body)| ((*path).to_string(), body.as_bytes().to_vec())).collect()
    }

    /// The whole point, end to end and offline: what one machine pushes, the
    /// other reads.
    #[test]
    fn two_machines_converge_through_one_repository() {
        let Some(bench) = Bench::new("converge") else { return };
        let first = bench.machine("first");
        open(&first, Some(&bench.origin())).expect("clone");
        let branch_name = branch(&first);

        stage(&first, &files(&[("agents/.agents/AGENTS.md", "# from the first\n")]))
            .expect("stage");
        let sha = commit(&first, "first: 1 file").expect("commit").expect("a commit");
        push(&first, &branch_name).expect("push");
        set_base(&first, &sha).expect("base");

        let second = bench.machine("second");
        open(&second, Some(&bench.origin())).expect("clone");
        fetch(&second).expect("fetch");
        let there = read_tree(&second, &format!("origin/{branch_name}")).expect("tree");
        assert_eq!(
            there.get("agents/.agents/AGENTS.md").map(|bytes| bytes.as_slice()),
            Some(b"# from the first\n".as_slice())
        );
        // And the second machine has never synced, so its base is empty — which
        // is what puts a difference in front of the merge tool rather than
        // adopting it.
        assert!(base(&second).is_none());
        assert!(base_tree(&second).expect("base tree").is_empty());
    }

    /// The base is this machine's alone. Pushed, it would tell every other
    /// machine that this one's history was agreed.
    #[test]
    fn the_base_ref_is_local_and_never_pushed() {
        let Some(bench) = Bench::new("base-ref") else { return };
        let dir = bench.machine("only");
        open(&dir, Some(&bench.origin())).expect("clone");
        let branch_name = branch(&dir);
        stage(&dir, &files(&[("agents/.agents/AGENTS.md", "# one\n")])).expect("stage");
        let sha = commit(&dir, "only: 1 file").expect("commit").expect("a commit");
        push(&dir, &branch_name).expect("push");
        set_base(&dir, &sha).expect("base");
        assert_eq!(base(&dir).as_deref(), Some(sha.as_str()));

        let mut cmd = git(&dir);
        cmd.args(["ls-remote", "origin"]);
        let listing = String::from_utf8_lossy(&run(cmd).expect("ls-remote")).to_string();
        assert!(!listing.contains("refs/boite"), "the base ref travelled:\n{listing}");
    }

    /// Automatic recovery would mean writing over whatever a half-finished sync
    /// left, which is the one thing this does not do.
    #[test]
    fn a_dirty_mirror_is_refused_and_repair_is_the_way_out() {
        let Some(bench) = Bench::new("dirty") else { return };
        let dir = bench.machine("only");
        open(&dir, Some(&bench.origin())).expect("clone");
        stage(&dir, &files(&[("agents/.agents/AGENTS.md", "# one\n")])).expect("stage");
        commit(&dir, "only: 1 file").expect("commit");

        std::fs::write(dir.join("agents").join(".agents").join("AGENTS.md"), "# half written")
            .expect("write");
        let failed = require_clean(&dir).expect_err("should refuse");
        assert!(matches!(failed, Failed::Dirty(_)), "{failed:?}");
        assert!(failed.message().contains("repair"));

        repair(&dir).expect("repair");
        require_clean(&dir).expect("clean again");
    }

    /// An empty remote is not a divergence and not an error: it is the first
    /// machine's turn to fill it.
    #[test]
    fn an_empty_remote_reads_as_empty_rather_than_missing() {
        let Some(bench) = Bench::new("empty") else { return };
        let dir = bench.machine("only");
        open(&dir, Some(&bench.origin())).expect("clone an empty repository");
        fetch(&dir).expect("fetch");
        assert!(read_tree(&dir, &format!("origin/{}", branch(&dir))).expect("tree").is_empty());

        let answer = probe(&bench.origin());
        assert!(answer.reachable, "{answer:?}");
        assert!(answer.empty, "{answer:?}");
    }

    /// An address nobody answers at is reported, not retried into a hang: the
    /// git command factory disables every interactive prompt, which is what makes
    /// delegating authentication workable.
    #[test]
    fn an_address_that_answers_nothing_is_reported() {
        if !git_is_here() {
            return;
        }
        let answer = probe("/definitely/not/a/repository/anywhere");
        assert!(!answer.reachable);
        assert!(answer.message.is_some());
    }

    /// Bytes are what travelled and bytes are what comes back. Normalising line
    /// endings would make every file diverge between a Windows machine and a
    /// unix one, on the first sync, with nobody having touched anything.
    #[test]
    fn line_endings_are_not_rewritten() {
        let Some(bench) = Bench::new("endings") else { return };
        let dir = bench.machine("only");
        open(&dir, Some(&bench.origin())).expect("clone");
        let mixed = "one\r\ntwo\nthree\r\n";
        stage(&dir, &files(&[("agents/.agents/AGENTS.md", mixed)])).expect("stage");
        let sha = commit(&dir, "only: 1 file").expect("commit").expect("a commit");

        let back = read_tree(&dir, &sha).expect("tree");
        assert_eq!(
            back.get("agents/.agents/AGENTS.md").map(|bytes| bytes.as_slice()),
            Some(mixed.as_bytes())
        );
    }

    /// `~/.agents` is allowed two thousand files, so reading them one process at
    /// a time would not do. One batch, and every one of them comes back whole.
    #[test]
    fn many_files_are_read_in_one_pass() {
        let Some(bench) = Bench::new("batch") else { return };
        let dir = bench.machine("only");
        open(&dir, Some(&bench.origin())).expect("clone");
        let mut wanted = Files::new();
        for index in 0..250 {
            wanted.insert(
                format!("agents/.agents/skills/s{index:03}/SKILL.md"),
                format!("# skill {index}\nbody line\n").into_bytes(),
            );
        }
        stage(&dir, &wanted).expect("stage");
        let sha = commit(&dir, "only: 250 files").expect("commit").expect("a commit");

        let back = read_tree(&dir, &sha).expect("tree");
        assert_eq!(back.len(), wanted.len());
        assert_eq!(back, wanted);
    }

    /// Nothing changed, so there is nothing to commit and nothing to push. A
    /// sync that manufactured an empty commit every time would fill the history
    /// with noise nobody can read past.
    #[test]
    fn nothing_to_commit_is_not_a_commit() {
        let Some(bench) = Bench::new("no-op") else { return };
        let dir = bench.machine("only");
        open(&dir, Some(&bench.origin())).expect("clone");
        stage(&dir, &files(&[("agents/.agents/AGENTS.md", "# one\n")])).expect("stage");
        commit(&dir, "only: 1 file").expect("commit").expect("a commit");
        assert!(commit(&dir, "only: nothing").expect("commit").is_none());
    }

    /// A repository written by a newer Boite is refused rather than mangled by
    /// an older one that does not know its layout.
    #[test]
    fn a_newer_repository_is_refused() {
        let Some(bench) = Bench::new("too-new") else { return };
        let dir = bench.machine("only");
        open(&dir, Some(&bench.origin())).expect("clone");
        std::fs::write(dir.join(STAMP_FILE), r#"{"version": 2}"#).expect("write");
        assert_eq!(open(&dir, Some(&bench.origin())), Err(Failed::TooNew(2)));
    }
}
