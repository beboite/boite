use std::collections::hash_map::DefaultHasher;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub refs_version: Option<String>,
    pub commit_count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub conflicted: bool,
    pub orig_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub summary: String,
    pub additions: u32,
    pub deletions: u32,
    pub refs: Vec<String>,
    pub local_only: bool,
    pub remote_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchChangeResult {
    pub stashed: bool,
}

fn git(path: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(path);
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    // Never block on an interactive credential/auth prompt: fail fast instead
    // of hanging a background fetch forever.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");
    // Git translates its own messages, and the frontend maps known failures
    // (checkout would overwrite, unmerged index, worktree already checked out)
    // by matching them. Under a French or German locale none of those match and
    // the user gets raw git output instead of the guidance.
    cmd.env("LC_ALL", "C");
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn run(mut cmd: Command) -> Result<Vec<u8>, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("git not found or failed to start: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git exited with status {}", out.status)
        } else {
            err
        });
    }
    Ok(out.stdout)
}

pub fn repo_info_blocking(path: &str) -> Result<RepoInfo, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Ok(empty_repo());
    }
    let mut cmd = git(p);
    cmd.args([
        "status",
        "-b",
        "--porcelain=v2",
        "--untracked-files=no",
    ]);
    let stdout = match run(cmd) {
        Ok(b) => b,
        Err(_) => return Ok(empty_repo()),
    };
    let text = String::from_utf8_lossy(&stdout);

    let version = refs_version(p);
    let mut info = RepoInfo {
        is_repo: true,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        commit_count: commit_count_cached(p, version.as_deref()),
        refs_version: version,
    };
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest != "(detached)" {
                info.branch = Some(rest.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            info.upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // format: "+<ahead> -<behind>"
            for tok in rest.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    info.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    info.behind = n.parse().unwrap_or(0);
                }
            }
        }
    }
    Ok(info)
}

// Directories that never hold a user's nested repo but can be huge.
const SCAN_SKIP: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
];

// Breadth-first scan for git repos nested under `root`, for projects opened
// on a parent folder. Pure fs checks (`.git` dir, or file for worktrees) —
// no git subprocess per candidate. Found repos are not descended into, so
// submodules of a nested repo don't flood the list.
pub fn find_repos_blocking(root: &str, max_depth: u32) -> Result<Vec<String>, String> {
    const MAX_RESULTS: usize = 50;
    let base = Path::new(root);
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let mut found: Vec<String> = Vec::new();
    let mut queue: VecDeque<(PathBuf, u32)> = VecDeque::new();
    queue.push_back((base.to_path_buf(), 0));
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if found.len() >= MAX_RESULTS {
                return Ok(found);
            }
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || SCAN_SKIP.contains(&name.as_ref()) {
                continue;
            }
            let path = entry.path();
            if fs::symlink_metadata(path.join(".git")).is_ok() {
                found.push(path.to_string_lossy().to_string());
            } else if depth + 1 < max_depth {
                queue.push_back((path, depth + 1));
            }
        }
    }
    Ok(found)
}

fn empty_repo() -> RepoInfo {
    RepoInfo {
        is_repo: false,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        refs_version: None,
        commit_count: 0,
    }
}

// Total commits reachable from HEAD. Cheap (`rev-list --count`) and matches
// what `git log` walks, so the panel can show the real repo size instead of
// the paginated page length. Unborn HEAD / no commits => 0.
fn commit_count(p: &Path) -> u32 {
    let mut cmd = git(p);
    cmd.args(["rev-list", "--count", "HEAD"]);
    match run(cmd) {
        Ok(b) => String::from_utf8_lossy(&b).trim().parse().unwrap_or(0),
        Err(_) => 0,
    }
}

// `rev-list --count HEAD` walks the entire history, and the panel asks for
// repo info every 10s per open project. The count can only move when a ref
// moves, and `refs_version` already fingerprints exactly that without a
// subprocess — so key the count on it. One entry per repo the user opens;
// nothing here grows over time.
type CommitCountCache = std::sync::Mutex<std::collections::HashMap<PathBuf, (String, u32)>>;
static COMMIT_COUNT_CACHE: std::sync::OnceLock<CommitCountCache> = std::sync::OnceLock::new();

fn commit_count_cached(p: &Path, refs_version: Option<&str>) -> u32 {
    // No fingerprint means no .git we can watch; fall back to asking git.
    let Some(version) = refs_version else {
        return commit_count(p);
    };
    let cache = COMMIT_COUNT_CACHE.get_or_init(Default::default);
    if let Ok(map) = cache.lock() {
        if let Some((cached_version, count)) = map.get(p) {
            if cached_version == version {
                return *count;
            }
        }
    }
    let count = commit_count(p);
    if let Ok(mut map) = cache.lock() {
        map.insert(p.to_path_buf(), (version.to_string(), count));
    }
    count
}

// Resolve the actual .git directory; worktrees and submodules use a `.git`
// FILE containing "gitdir: <path>".
fn git_dir(path: &Path) -> Option<PathBuf> {
    let dotgit = path.join(".git");
    let meta = fs::metadata(&dotgit).ok()?;
    if meta.is_dir() {
        return Some(dotgit);
    }
    let content = fs::read_to_string(&dotgit).ok()?;
    let target = content.strip_prefix("gitdir:")?.trim();
    let target_path = PathBuf::from(target);
    Some(if target_path.is_absolute() {
        target_path
    } else {
        path.join(target_path)
    })
}

fn hash_file_state(p: &Path, hasher: &mut DefaultHasher) {
    let Ok(meta) = fs::metadata(p) else { return };
    meta.len().hash(hasher);
    if let Ok(modified) = meta.modified() {
        let nanos = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        nanos.hash(hasher);
    }
}

fn hash_refs_dir(dir: &Path, hasher: &mut DefaultHasher) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        p.hash(hasher);
        if p.is_dir() {
            hash_refs_dir(&p, hasher);
        } else {
            hash_file_state(&p, hasher);
        }
    }
}

// Change detection without subprocesses: the old implementation spawned two
// git processes (rev-parse + for-each-ref) every 3s poll just to hash refs.
// Hashing HEAD content + mtimes/sizes of the ref stores detects the same
// transitions for free.
fn refs_version(path: &Path) -> Option<String> {
    let dir = git_dir(path)?;
    let mut hasher = DefaultHasher::new();
    if let Ok(head) = fs::read(dir.join("HEAD")) {
        head.hash(&mut hasher);
    }
    hash_file_state(&dir.join("packed-refs"), &mut hasher);
    hash_refs_dir(&dir.join("refs"), &mut hasher);
    Some(format!("{:016x}", hasher.finish()))
}

#[derive(Serialize)]
pub struct PathStatus {
    pub path: String,
    pub status: String,
}

pub fn changed_paths_blocking(path: &str) -> Result<Vec<PathStatus>, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Ok(Vec::new());
    }
    let mut cmd = git(p);
    cmd.args([
        "status",
        "--porcelain=v2",
        "--untracked-files=normal",
        "--ignored=no",
        "-z",
    ]);
    let stdout = match run(cmd) {
        Ok(b) => b,
        Err(_) => return Ok(Vec::new()),
    };
    let entries = parse_porcelain_v2(&stdout);

    use std::collections::HashMap;
    let mut best: HashMap<String, char> = HashMap::new();
    for e in entries {
        let new_status = e
            .status
            .chars()
            .next()
            .unwrap_or('?');
        match best.get(&e.path).copied() {
            Some(existing) => {
                if rank(new_status) > rank(existing) {
                    best.insert(e.path, new_status);
                }
            }
            None => {
                best.insert(e.path, new_status);
            }
        }
    }

    let mut out: Vec<PathStatus> = best
        .into_iter()
        .map(|(rel, status)| PathStatus {
            path: rel,
            status: status.to_string(),
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn rank(c: char) -> u8 {
    match c {
        'U' => 6,
        'D' => 5,
        'A' => 4,
        'M' => 3,
        'R' => 2,
        'C' => 2,
        '?' => 1,
        _ => 0,
    }
}

pub fn status_blocking(path: &str) -> Result<Vec<ChangeEntry>, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Ok(Vec::new());
    }
    let mut cmd = git(p);
    cmd.args([
        "status",
        "--porcelain=v2",
        "--untracked-files=normal",
        "--ignored=no",
        "-z",
    ]);
    let stdout = run(cmd)?;
    Ok(parse_porcelain_v2(&stdout))
}

fn parse_porcelain_v2(bytes: &[u8]) -> Vec<ChangeEntry> {
    let mut out: Vec<ChangeEntry> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let end = bytes[i..]
            .iter()
            .position(|&b| b == 0)
            .map(|n| i + n)
            .unwrap_or(bytes.len());
        let record = &bytes[i..end];
        i = end + 1;
        if record.is_empty() {
            continue;
        }
        let prefix = record[0];
        let line = String::from_utf8_lossy(record).into_owned();
        match prefix {
            b'1' => {
                // 1 XY sub mH mI mW hH hI path
                let mut parts = line.splitn(9, ' ');
                let _ = parts.next(); // "1"
                let xy = parts.next().unwrap_or("..");
                for _ in 0..6 {
                    parts.next();
                }
                if let Some(path) = parts.next() {
                    push_xy(&mut out, xy, path, None);
                }
            }
            b'2' => {
                // 2 XY sub mH mI mW hH hI Xscore path; the original path
                // follows as its own NUL-terminated record.
                let orig_end = bytes[i..]
                    .iter()
                    .position(|&b| b == 0)
                    .map(|n| i + n)
                    .unwrap_or(bytes.len());
                let orig = String::from_utf8_lossy(&bytes[i..orig_end]).into_owned();
                i = orig_end + 1;

                let mut parts = line.splitn(10, ' ');
                let _ = parts.next();
                let xy = parts.next().unwrap_or("..");
                for _ in 0..7 {
                    parts.next();
                }
                if let Some(path) = parts.next() {
                    let orig = if orig.is_empty() { None } else { Some(orig.as_str()) };
                    push_xy(&mut out, xy, path, orig);
                }
            }
            b'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let mut parts = line.splitn(11, ' ');
                let _ = parts.next();
                let _ = parts.next();
                for _ in 0..8 {
                    parts.next();
                }
                if let Some(path) = parts.next() {
                    out.push(ChangeEntry {
                        path: path.to_string(),
                        status: "U".into(),
                        staged: false,
                        conflicted: true,
                        orig_path: None,
                    });
                }
            }
            b'?' => {
                let path = line.get(2..).unwrap_or("");
                if !path.is_empty() {
                    out.push(ChangeEntry {
                        path: path.to_string(),
                        status: "?".into(),
                        staged: false,
                        conflicted: false,
                        orig_path: None,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

fn push_xy(out: &mut Vec<ChangeEntry>, xy: &str, path: &str, orig: Option<&str>) {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    if x != '.' && x != ' ' {
        out.push(ChangeEntry {
            path: path.to_string(),
            status: x.to_string(),
            staged: true,
            conflicted: false,
            orig_path: orig.map(|s| s.to_string()),
        });
    }
    if y != '.' && y != ' ' {
        out.push(ChangeEntry {
            path: path.to_string(),
            status: y.to_string(),
            staged: false,
            conflicted: false,
            orig_path: orig.map(|s| s.to_string()),
        });
    }
}

/// What a repository can say about a commit an agent claims to have made.
/// `known` false means git has never heard of it — the sha was mistyped, or
/// invented, or belongs to another clone.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitState {
    pub known: bool,
    pub pushed: bool,
    pub short: String,
    pub subject: Option<String>,
    /// A local branch holding the commit, preferring the one checked out, for
    /// looking a pull request up by head.
    pub branch: Option<String>,
}

/// A sha is untrusted input reaching a command line. It is passed as an
/// argument and never through a shell, so this is not the thing standing
/// between us and injection — but a value that cannot be a sha has no business
/// being tried, and `--flag`-shaped input is exactly what argument parsers
/// mistake for their own.
fn looks_like_sha(sha: &str) -> bool {
    (7..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// Reads a claimed commit back out of the repository: does it exist, and has it
/// left this machine. Both answers come from git, so a sha nothing backs shows
/// up as unknown rather than as a tick.
pub fn commit_state_blocking(path: &str, sha: &str) -> CommitState {
    let p = Path::new(path);
    if !p.is_dir() || !looks_like_sha(sha) {
        return CommitState::default();
    }

    // `^{commit}` so a tag or a tree with that name is not mistaken for one.
    let mut cmd = git(p);
    cmd.args(["rev-parse", "--verify", "--quiet", &format!("{sha}^{{commit}}")]);
    let Ok(out) = run(cmd) else {
        return CommitState::default();
    };
    let full = String::from_utf8_lossy(&out).trim().to_string();
    if full.is_empty() {
        return CommitState::default();
    }

    let subject = {
        let mut cmd = git(p);
        cmd.args(["log", "-1", "--format=%s", &full]);
        run(cmd)
            .ok()
            .map(|o| String::from_utf8_lossy(&o).trim().to_string())
            .filter(|s| !s.is_empty())
    };

    // On a remote-tracking branch is the only evidence that it left: a local
    // branch being ahead says nothing about where the commit is.
    let remote_refs: Vec<String> = {
        let mut cmd = git(p);
        cmd.args(["branch", "-r", "--contains", &full, "--format=%(refname:short)"]);
        run(cmd)
            .map(|o| {
                String::from_utf8_lossy(&o)
                    .lines()
                    .map(|l| l.trim().to_string())
                    // origin/HEAD is a pointer at the default branch, not a
                    // branch anyone opened a pull request from.
                    .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
                    .collect()
            })
            .unwrap_or_default()
    };
    let pushed = !remote_refs.is_empty();

    let local_branch = {
        let mut cmd = git(p);
        cmd.args(["branch", "--contains", &full, "--format=%(HEAD)%(refname:short)"]);
        run(cmd).ok().and_then(|o| {
            let text = String::from_utf8_lossy(&o);
            let mut names: Vec<String> = Vec::new();
            for line in text.lines() {
                let line = line.trim();
                // `%(HEAD)` marks the checked-out branch with `*`; it is the one
                // a pull request would have been opened from.
                if let Some(rest) = line.strip_prefix('*') {
                    return Some(rest.trim().to_string());
                }
                if !line.is_empty() {
                    names.push(line.to_string());
                }
            }
            names.into_iter().next()
        })
    };

    // Falling back to the remote ref, minus its remote name: work pushed from a
    // branch this clone never had, or has since deleted, still has a pull
    // request — and without a name for it nothing would ever go looking.
    let branch = local_branch.or_else(|| {
        remote_refs
            .first()
            .and_then(|r| r.split_once('/').map(|(_, name)| name.to_string()))
    });

    CommitState {
        known: true,
        pushed,
        short: full.chars().take(7).collect(),
        subject,
        branch,
    }
}

/// A pull request as `gh` reports it. Not a git concept: git knows the commit
/// left the machine, nothing more, and the rest lives on the forge.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub state: String,
    pub url: String,
}

/// The outcome of asking `gh` about a branch.
///
/// Four answers rather than an option, because "no pull request" and "could not
/// ask" are not the same thing to the person reading the row. Two of them are
/// worth saying out loud — `gh` is there but signed out, or it failed — and two
/// are not: no `gh` at all, and a repository that is not on GitHub are both
/// simply outside what this can answer.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrLookup {
    /// No `gh`, or no GitHub remote. Nothing to report and nothing to fix.
    Unavailable,
    /// `gh` answered, and there is no pull request for this branch.
    NotFound,
    Found { pr: PullRequest },
    /// `gh` was reachable and refused. `auth` marks the one case the user can
    /// act on directly, which `gh` reports with exit code 4.
    Failed { auth: bool, detail: String },
}

/// Turns a refusal from `gh` into something the panel can say, kept apart from
/// the process handling so both branches can be tested against the real
/// messages rather than against a guess at them.
fn classify_gh_failure(code: Option<i32>, stderr: &str) -> PrLookup {
    let detail = stderr.lines().next().unwrap_or("").trim().to_string();
    // Not a GitHub repository at all. gh is right to refuse and there is
    // nothing for the user to do about it, so this is silence like a missing
    // gh rather than a failure.
    if detail.contains("known GitHub host") {
        return PrLookup::Unavailable;
    }
    PrLookup::Failed {
        // gh exits 4 when it wants `gh auth login`: the one outcome here the
        // user can act on, and so the one worth naming.
        auth: code == Some(4),
        detail: if detail.is_empty() {
            match code {
                Some(c) => format!("gh exited with {c}"),
                None => "gh was killed".into(),
            }
        } else {
            detail
        },
    }
}

/// The pull request opened from this branch.
///
/// This is the only part of the strip that reaches the network, so it is also
/// the only part with a deadline and a kill behind it.
pub fn pull_request_for_branch_blocking(path: &str, branch: &str) -> PrLookup {
    let p = Path::new(path);
    if !p.is_dir() || branch.is_empty() || branch.starts_with('-') {
        return PrLookup::Unavailable;
    }

    let mut cmd = Command::new("gh");
    cmd.current_dir(p);
    cmd.args([
        "pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json",
        "number,state,url",
    ]);
    // gh asks interactively when it is not authenticated, and a prompt waiting
    // on a terminal nobody is looking at is exactly the hang this must not have.
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.env("GH_NO_UPDATE_NOTIFIER", "1");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    // Kept rather than dropped: it carries the difference between a signed-out
    // gh and a repository gh has no business answering about.
    cmd.stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    // Failing to spawn is `gh` not being installed, which is not a problem to
    // report — most machines do not have it, and nothing here needs it.
    let Ok(mut child) = cmd.spawn() else {
        return PrLookup::Unavailable;
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            // Past the deadline, or waiting failed: leave nothing running behind
            // a panel that has already given up on the answer.
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return PrLookup::Failed {
                    auth: false,
                    detail: "gh did not answer in time".into(),
                };
            }
        }
    }

    let Ok(out) = child.wait_with_output() else {
        return PrLookup::Unavailable;
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return classify_gh_failure(out.status.code(), &stderr);
    }

    let Ok(parsed) = serde_json::from_slice::<Vec<serde_json::Value>>(&out.stdout) else {
        return PrLookup::Failed {
            auth: false,
            detail: "gh returned something that is not a pull request list".into(),
        };
    };
    let Some(pr) = parsed.into_iter().next() else {
        return PrLookup::NotFound;
    };
    let Some(number) = pr.get("number").and_then(|v| v.as_u64()) else {
        return PrLookup::NotFound;
    };
    PrLookup::Found {
        pr: PullRequest {
            number,
            state: pr
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN")
                .to_string(),
            url: pr
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        },
    }
}

pub fn log_blocking(path: &str, limit: u32, skip: u32) -> Result<Vec<Commit>, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 500);
    let upstream = upstream_ref(p);
    let mut cmd = git(p);
    cmd.args([
        "log",
        "HEAD",
    ]);
    if let Some(ref u) = upstream {
        cmd.arg(u);
    }
    cmd.args([
        "--topo-order",
        "--numstat",
        &format!("-n{}", limit),
        &format!("--skip={}", skip),
        "--pretty=format:%x1e%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%n",
    ]);
    let stdout = match run(cmd) {
        Ok(b) => b,
        Err(_) => return Ok(Vec::new()),
    };
    let text = String::from_utf8_lossy(&stdout);
    let mut commits: Vec<Commit> = Vec::new();
    for record in text.split('\u{1e}') {
        let trimmed = record.trim_start_matches('\n');
        if trimmed.is_empty() {
            continue;
        }
        let mut lines = trimmed.lines();
        let Some(header) = lines.next() else {
            continue;
        };
        let mut fields = header.split('\u{1f}');
        let sha = fields.next().unwrap_or("").to_string();
        let short_sha = fields.next().unwrap_or("").to_string();
        let parents = fields
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        let author = fields.next().unwrap_or("").to_string();
        let email = fields.next().unwrap_or("").to_string();
        let time = fields.next().unwrap_or("0").parse().unwrap_or(0);
        let refs = fields
            .next()
            .unwrap_or("")
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let summary = fields.next().unwrap_or("").to_string();
        if sha.is_empty() {
            continue;
        }
        let mut additions = 0u32;
        let mut deletions = 0u32;
        for line in lines {
            let mut parts = line.split('\t');
            let added = parts.next().unwrap_or("");
            let deleted = parts.next().unwrap_or("");
            if let Ok(n) = added.parse::<u32>() {
                additions = additions.saturating_add(n);
            }
            if let Ok(n) = deleted.parse::<u32>() {
                deletions = deletions.saturating_add(n);
            }
        }
        commits.push(Commit {
            sha,
            short_sha,
            parents,
            author,
            email,
            time,
            summary,
            additions,
            deletions,
            refs,
            local_only: false,
            remote_only: false,
        });
    }

    let local_set = local_only_set(p, upstream.as_deref());
    let remote_set = remote_only_set(p, upstream.as_deref());
    if !local_set.is_empty() {
        for c in &mut commits {
            if local_set.contains(&c.sha) {
                c.local_only = true;
            }
        }
    }
    if !remote_set.is_empty() {
        for c in &mut commits {
            if remote_set.contains(&c.sha) {
                c.remote_only = true;
            }
        }
    }

    Ok(commits)
}

fn upstream_ref(path: &Path) -> Option<String> {
    let mut cmd = git(path);
    cmd.args([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "HEAD@{upstream}",
    ]);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn local_only_set(path: &Path, upstream: Option<&str>) -> HashSet<String> {
    let Some(up) = upstream else {
        return HashSet::new();
    };
    let mut cmd = git(path);
    cmd.args(["rev-list", "HEAD", &format!("^{up}")]);
    match run(cmd) {
        Ok(b) => String::from_utf8_lossy(&b)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Err(_) => HashSet::new(),
    }
}

fn remote_only_set(path: &Path, upstream: Option<&str>) -> HashSet<String> {
    let Some(up) = upstream else {
        return HashSet::new();
    };
    let mut cmd = git(path);
    cmd.args(["rev-list", up, "^HEAD"]);
    match run(cmd) {
        Ok(b) => String::from_utf8_lossy(&b)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Err(_) => HashSet::new(),
    }
}

pub fn unstage_blocking(path: &str, files: Vec<String>) -> Result<(), String> {
    let p = Path::new(path);
    let mut cmd = git(p);
    cmd.args(["reset", "HEAD", "--"]);
    for f in &files {
        cmd.arg(f);
    }
    run(cmd).map(|_| ())
}

pub fn discard_blocking(path: &str, files: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    let p = Path::new(path);
    if !files.is_empty() {
        // Restore from the index, NOT from HEAD: discarding working-tree
        // changes must never wipe what the user has staged.
        let mut cmd = git(p);
        cmd.args(["checkout", "--"]);
        for f in &files {
            cmd.arg(f);
        }
        run(cmd)?;
    }
    if !untracked.is_empty() {
        let mut cmd = git(p);
        cmd.args(["clean", "-fd", "--"]);
        for f in &untracked {
            cmd.arg(f);
        }
        run(cmd)?;
    }
    Ok(())
}

pub fn run_files(path: &str, sub: &str, files: &[String], with_dashes: bool) -> Result<(), String> {
    let p = Path::new(path);
    let mut cmd = git(p);
    cmd.arg(sub);
    if with_dashes {
        cmd.arg("--");
    }
    for f in files {
        cmd.arg(f);
    }
    run(cmd).map(|_| ())
}

const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

pub fn fetch_blocking(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }
    if !has_remote(p) {
        // Nothing to fetch from; treat as a successful no-op so the frontend
        // does not count it as a failure and back off.
        return Ok(());
    }
    let mut cmd = git(p);
    cmd.args(["fetch", "--all", "--prune", "--quiet"]);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    run_with_timeout(cmd, FETCH_TIMEOUT)
}

fn has_remote(path: &Path) -> bool {
    let mut cmd = git(path);
    cmd.arg("remote");
    match run(cmd) {
        Ok(out) => !String::from_utf8_lossy(&out).trim().is_empty(),
        Err(_) => false,
    }
}

// Like `run`, but kills the child if it outlives `timeout`. Used for
// network-touching commands (fetch/push/pull) that can stall.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("git not found or failed to start: {e}"))?;
    // Drain stderr concurrently: a chatty remote fills the pipe buffer,
    // which blocks the child forever and turns it into a false "timed out".
    let mut stderr_drain = child.stderr.take().map(|mut s| {
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = s.read_to_string(&mut buf);
            buf
        })
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let err = stderr_drain
                    .take()
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if status.success() {
                    return Ok(());
                }
                return Err(if err.is_empty() {
                    format!("git exited with status {status}")
                } else {
                    err
                });
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("git command timed out".into());
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("git wait failed: {e}")),
        }
    }
}

const PUSH_PULL_TIMEOUT: Duration = Duration::from_secs(60);

pub fn push_blocking(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }
    if !has_remote(p) {
        return Err("No remote configured".into());
    }
    let mut cmd = git(p);
    if upstream_ref(p).is_some() {
        cmd.args(["push", "--quiet"]);
    } else {
        let branch = current_branch(p).ok_or("Cannot push: detached HEAD")?;
        cmd.args(["push", "--quiet", "-u", "origin", &branch]);
    }
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    run_with_timeout(cmd, PUSH_PULL_TIMEOUT)
}

pub fn pull_blocking(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }
    if !has_remote(p) {
        return Err("No remote configured".into());
    }
    // --ff-only: never create a merge commit behind the user's back. A
    // diverged branch surfaces as an error they resolve in the terminal.
    let mut cmd = git(p);
    cmd.args(["pull", "--ff-only", "--quiet"]);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    run_with_timeout(cmd, PUSH_PULL_TIMEOUT)
}

fn current_branch(path: &Path) -> Option<String> {
    let mut cmd = git(path);
    cmd.args(["rev-parse", "--abbrev-ref", "HEAD"]);
    let out = run(cmd).ok()?;
    let s = String::from_utf8_lossy(&out).trim().to_string();
    if s.is_empty() || s == "HEAD" { None } else { Some(s) }
}

fn symbolic_branch(path: &Path) -> Option<String> {
    current_branch(path).or_else(|| {
        let mut cmd = git(path);
        cmd.args(["symbolic-ref", "--quiet", "--short", "HEAD"]);
        run(cmd)
            .ok()
            .map(|out| String::from_utf8_lossy(&out).trim().to_string())
            .filter(|name| !name.is_empty())
    })
}

pub fn branches_blocking(path: &str) -> Result<Vec<BranchInfo>, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err("Not a directory".into());
    }

    let current = symbolic_branch(p);
    let mut cmd = git(p);
    cmd.args([
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
    ]);
    let stdout = run(cmd)?;
    let mut names: Vec<String> = String::from_utf8_lossy(&stdout)
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    if let Some(ref name) = current {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    names.sort_by_cached_key(|name| name.to_lowercase());

    Ok(names
        .into_iter()
        .map(|name| BranchInfo {
            current: current.as_deref() == Some(name.as_str()),
            name,
        })
        .collect())
}

fn validate_branch_name(path: &Path, name: &str) -> Result<(), String> {
    if name.trim() != name || name.is_empty() {
        return Err("Invalid branch name. Remove leading or trailing spaces.".into());
    }
    // A leading dash reaches git as an option, not a name: `--help` makes both
    // check-ref-format and switch exit 0 without creating anything, so the call
    // would report success on a branch that does not exist.
    if name.starts_with('-') {
        return Err(format!("Invalid branch name '{name}'. It cannot start with '-'."));
    }
    let mut cmd = git(path);
    cmd.args(["check-ref-format", "--branch", name]);
    if run(cmd).is_err() {
        return Err(format!(
            "Invalid branch name '{name}'. Use a valid Git branch name without spaces or reserved characters."
        ));
    }
    Ok(())
}

fn local_branch_exists(path: &Path, name: &str) -> bool {
    let mut cmd = git(path);
    cmd.args([
        "show-ref",
        "--verify",
        "--quiet",
        &format!("refs/heads/{name}"),
    ]);
    cmd.status().map(|status| status.success()).unwrap_or(false)
}

fn ref_oid(path: &Path, reference: &str) -> Option<String> {
    let mut cmd = git(path);
    cmd.args(["rev-parse", "--verify", "--quiet", reference]);
    run(cmd)
        .ok()
        .map(|out| String::from_utf8_lossy(&out).trim().to_string())
        .filter(|oid| !oid.is_empty())
}

pub fn switch_branch_blocking(
    path: &str,
    name: &str,
    create: bool,
    stash_changes: bool,
) -> Result<BranchChangeResult, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err("Not a directory".into());
    }
    validate_branch_name(p, name)?;

    if !create && symbolic_branch(p).as_deref() == Some(name) {
        return Ok(BranchChangeResult { stashed: false });
    }
    if create && local_branch_exists(p, name) {
        return Err(format!("A branch named '{name}' already exists."));
    }
    if !create && !local_branch_exists(p, name) {
        return Err(format!(
            "The branch '{name}' no longer exists. Refresh the branch list."
        ));
    }

    let before_stash = ref_oid(p, "refs/stash");
    if stash_changes {
        if ref_oid(p, "HEAD").is_none() {
            return Err(
                "Git cannot stash changes before the first commit. Bring the changes to the new branch or create the initial commit first."
                    .into(),
            );
        }
        let from = symbolic_branch(p).unwrap_or_else(|| "detached HEAD".into());
        let mut cmd = git(p);
        cmd.args([
            "stash",
            "push",
            "--include-untracked",
            "--message",
            &format!("boite: changes before switching from {from} to {name}"),
        ]);
        run(cmd)?;
    }
    let after_stash = ref_oid(p, "refs/stash");
    let stashed = stash_changes && after_stash.is_some() && after_stash != before_stash;

    let mut cmd = git(p);
    cmd.arg("switch");
    if create {
        cmd.arg("-c");
    }
    cmd.arg(name);
    if let Err(switch_error) = run(cmd) {
        if stashed {
            let mut restore = git(p);
            restore.args(["stash", "pop", "--index"]);
            return match run(restore) {
                Ok(_) => Err(format!("{switch_error}\nYour local changes were restored.")),
                Err(restore_error) => Err(format!(
                    "{switch_error}\nThe switch was cancelled, but Git could not restore the stash automatically: {restore_error}"
                )),
            };
        }
        return Err(switch_error);
    }

    Ok(BranchChangeResult { stashed })
}


pub fn init_blocking(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }
    let mut cmd = git(p);
    cmd.arg("init");
    run(cmd).map(|_| ())
}

#[derive(Serialize)]
pub struct FileVersions {
    pub head: Option<String>,
    pub index: Option<String>,
    pub work: Option<String>,
    pub binary: bool,
}

// `file` / `headFile` arrive straight from a client. The caller only scopes
// `path` (the repo) through ProjectRoots, and both of these end up in a
// `Path::join` — where an absolute path DISCARDS the repo prefix entirely and
// `..` walks out of it. Either one turns "read a file in this repo" into an
// arbitrary filesystem read, so repo-relative is the only accepted shape.
fn repo_relative(rel: &str) -> Result<(), String> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err("file must be repo-relative".into());
    }
    for component in p.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("file must be repo-relative".into()),
        }
    }
    Ok(())
}

// Second gate for the working-tree read: a symlink *inside* the repo can still
// point outside it, and component checks cannot see that.
fn contained(repo: &Path, target: &Path) -> bool {
    match (fs::canonicalize(repo), fs::canonicalize(target)) {
        (Ok(root), Ok(abs)) => abs.starts_with(root),
        _ => false,
    }
}

pub fn file_versions_blocking(
    path: &str,
    file: &str,
    head_file: Option<&str>,
) -> Result<FileVersions, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }
    let rel = file.replace('\\', "/");
    // Renamed files live under their old name in HEAD.
    let head_rel = head_file.map(|f| f.replace('\\', "/")).unwrap_or_else(|| rel.clone());
    repo_relative(&rel)?;
    repo_relative(&head_rel)?;

    let (head, head_binary) = git_show(p, &format!("HEAD:{}", head_rel));
    let (index, index_binary) = git_show(p, &format!(":{}", rel));

    let abs = p.join(&rel);
    let mut work_binary = false;
    let work = match fs::metadata(&abs) {
        Ok(meta) if meta.is_file() && contained(p, &abs) => match fs::read(&abs) {
            Ok(bytes) => {
                if bytes_binary(&bytes) {
                    work_binary = true;
                    None
                } else {
                    Some(String::from_utf8_lossy(&bytes).into_owned())
                }
            }
            Err(_) => None,
        },
        _ => None,
    };

    Ok(FileVersions {
        head,
        index,
        work,
        binary: head_binary || index_binary || work_binary,
    })
}

// (content, is_binary) — binary blobs return (None, true) so the caller can
// tell "binary" apart from "absent at this revision".
fn git_show(repo: &Path, spec: &str) -> (Option<String>, bool) {
    let mut cmd = git(repo);
    cmd.args(["show", spec]);
    match cmd.output() {
        Ok(out) if out.status.success() => {
            if bytes_binary(&out.stdout) {
                (None, true)
            } else {
                (Some(String::from_utf8_lossy(&out.stdout).into_owned()), false)
            }
        }
        _ => (None, false),
    }
}

fn bytes_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8192)];
    head.contains(&0u8)
}

pub fn commit_blocking(path: &str, message: &str) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message is empty".into());
    }
    let p = Path::new(path);
    let mut cmd = git(p);
    cmd.args(["commit", "-m", trimmed]);
    let stdout = run(cmd)?;
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

/// One directory named after an id, directly under `base` and never elsewhere.
///
/// Used for thread worktrees: the result is always exactly one level down, so
/// the filesystem trust boundary gains one root — the base — rather than one per
/// directory fed from a stored id. A worktree also has to live outside the
/// project for a second reason: one nested in the repository shows up as
/// untracked, which makes the main checkout permanently dirty and hides real
/// changes in `git status`.
pub fn scoped_dir_for(base: &Path, id: &str) -> PathBuf {
    // Ids are generated, but this path reaches `git worktree add` and
    // `create_dir_all`, so it is treated as untrusted input: anything that is
    // not plainly a name is replaced rather than escaped.
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    base.join(if safe.is_empty() { "unnamed".into() } else { safe })
}

/// What a worktree is still holding that removing it would destroy.
///
/// Nothing here is stored: both answers are read back off the repository, so
/// they stay true across a restart, a crash, and a worktree Boite did not make.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeHold {
    /// Modified, staged or untracked files. An agent's work in progress.
    pub dirty: bool,
    /// HEAD is on no local branch, so the commits here are reachable from
    /// nowhere else and go away with the directory. False once a branch has
    /// been claimed: removing the worktree then leaves the branch behind.
    pub orphan_commits: bool,
}

impl WorktreeHold {
    pub fn holds_work(&self) -> bool {
        self.dirty || self.orphan_commits
    }
}

fn is_oid(text: &str) -> bool {
    text.len() >= 40 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Where a repository keeps its refs and its objects.
///
/// A linked worktree has a `.git` directory of its own, holding its HEAD and its
/// index, and shares everything else with the main checkout. `commondir` is
/// where git itself records that path; join handles it whether it was written
/// relative or absolute.
fn common_dir(gitdir: &Path) -> PathBuf {
    fs::read_to_string(gitdir.join("commondir"))
        .ok()
        .map(|rel| gitdir.join(rel.trim()))
        .unwrap_or_else(|| gitdir.to_path_buf())
}

/// The object id a ref that has been packed away resolves to.
fn packed_ref(common: &Path, reference: &str) -> Option<String> {
    let packed = fs::read_to_string(common.join("packed-refs")).ok()?;
    packed
        .lines()
        .filter_map(|line| line.split_once(' '))
        .find(|(_, name)| name.trim() == reference)
        .map(|(oid, _)| oid.trim().to_string())
        .filter(|oid| is_oid(oid))
}

/// The commit HEAD is on, read off the filesystem.
///
/// `git rev-parse --verify HEAD` answers the same question and costs a process,
/// which on Windows is the expensive part of opening a worktree — measured at
/// 57ms on this developer's machine, in front of every new agent thread. Nothing
/// it looks at is computed: HEAD is either an object id or a symref into
/// `refs/`, and a ref that has been packed is a line in `packed-refs`.
fn head_oid(repo: &Path) -> Option<String> {
    let gitdir = git_dir(repo)?;
    let common = common_dir(&gitdir);
    let mut target = fs::read_to_string(gitdir.join("HEAD"))
        .ok()?
        .trim()
        .to_string();
    // A ref is allowed to name another ref, and `git symbolic-ref` writes
    // exactly that. Bounded rather than recursive: a cycle between two of them
    // is a broken repository, not a reason to read files forever.
    for _ in 0..8 {
        let Some(reference) = target.strip_prefix("ref:") else {
            // Detached, or the end of the chain: an object id.
            return is_oid(&target).then_some(target);
        };
        let reference = reference.trim().to_string();
        match fs::read_to_string(common.join(&reference)) {
            Ok(loose) => target = loose.trim().to_string(),
            // `packed-refs` holds no symrefs, so a packed answer ends the chain
            // whichever way it comes back.
            Err(_) => return packed_ref(&common, &reference),
        }
    }
    None
}

/// Whether HEAD names a commit that exists. False for an unborn branch, which
/// is a repository nothing can be checked out from yet, false for a ref left
/// pointing at an object that is gone, and false for a ref that resolves to
/// something that is not a commit: a tag object or a tree, neither of which
/// `worktree add --detach` can open a checkout on.
///
/// A ref outlives what it points at whenever history is rewritten or a fetch is
/// cut short, and reading the ref file cannot see that. `cat-file -e` can, over
/// every shape the object database comes in, packed or loose and whichever hash
/// the repository was created with. The `^{commit}` peel is what turns object
/// existence into the stricter question actually being asked. It costs a
/// process, and the only caller spawns `git worktree add` right after, which is
/// orders of magnitude more expensive than this check.
fn head_has_commit(repo: &Path) -> bool {
    let Some(oid) = head_oid(repo) else {
        return false;
    };
    let mut cmd = git(repo);
    cmd.args(["cat-file", "-e", &format!("{oid}^{{commit}}")]);
    run(cmd).is_ok()
}

/// Opens a worktree on the repository's current HEAD, detached.
///
/// Detached on purpose: a named branch would have to be invented before anyone
/// knows what the work is, it would sit in the branch list whether or not the
/// work was worth keeping, and Git refuses to check the same branch out twice —
/// which would make two threads on `master` an error instead of the default.
pub fn add_detached_worktree_blocking(repo: &str, path: &str) -> Result<String, String> {
    let r = Path::new(repo);
    if !r.is_dir() {
        return Err("Not a directory".into());
    }
    // `worktree add` on a repository with no commits fails with a message about
    // an invalid reference, which reads as a bug rather than as "commit first".
    if !head_has_commit(r) {
        return Err("This repository has no commits yet.".into());
    }
    if Path::new(path).exists() {
        return Err(format!("'{path}' already exists."));
    }
    let mut cmd = git(r);
    cmd.args(["worktree", "add", "--detach", path]);
    run(cmd)?;
    // Taken from the main checkout, not rebuilt. Without this a worktree costs
    // a full install and a full recompile before anything can run in it, which
    // is the difference between an isolated thread and an unusable one.
    provision_shared_artifacts(r, Path::new(path));
    Ok(path.to_string())
}

/// Suffix of the file that marks a worktree as unclaimed.
///
/// Beside the directory, never inside it. A marker file in the worktree would be
/// an untracked file, which is exactly what `worktree_hold_blocking` reads as
/// "there is work in here" and what the Worktrees tab paints as a dirty row.
const SPARE_SUFFIX: &str = ".spare";

/// How many unclaimed worktrees the pool keeps, over every repository together.
///
/// A spare is a whole checkout plus a copy of the build artifacts, and it is
/// made on the cheapest gesture in the app. Uncapped, a browse through twenty
/// projects wrote twenty checkouts and nothing ever took one back. The most
/// recent few are where the next thread is going.
const MAX_SPARES: usize = 3;

/// How long an unclaimed spare is worth keeping.
///
/// Its copy of `node_modules` and `.venv` was taken when it was made, so an old
/// one would hand an agent the dependencies of an old lockfile — and in the
/// meantime it is disk nobody asked for. Markers survive a restart, so without
/// this the oldest spare on the machine has no upper age at all.
const SPARE_MAX_AGE: Duration = Duration::from_secs(12 * 60 * 60);

/// Where a worktree's marker goes, or none for a path with no final component.
///
/// Refused rather than defaulted: `file_name` answers none for a filesystem
/// root and for a path ending in `..`, and a default would name every one of
/// them the same bare `.spare` beside a directory nobody meant.
fn spare_marker(dir: &Path) -> Option<PathBuf> {
    let mut name = dir.file_name()?.to_os_string();
    name.push(SPARE_SUFFIX);
    Some(dir.with_file_name(name))
}

/// Whether this worktree is one nobody has taken yet. Read by the listing, so an
/// unclaimed spare is not shown as a worktree the user has something to do with.
pub fn is_spare_worktree(dir: &str) -> bool {
    spare_marker(Path::new(dir)).is_some_and(|marker| marker.is_file())
}

/// Takes a spare out of the pool, which is what claiming one for a thread and
/// reworking one both have to do before they touch the directory.
///
/// Deleting the marker *is* the claim, and it is a single filesystem operation,
/// so whichever caller the kernel serves first owns the directory and every
/// other one is told plainly that it does not. That is what keeps
/// `git checkout --detach` out of a worktree an agent has already been handed:
/// warming does not get to touch a directory whose marker it did not take.
fn take_marker(dir: &Path) -> bool {
    spare_marker(dir).is_some_and(|marker| fs::remove_file(marker).is_ok())
}

/// Same directory, whatever the platform spelled it as. Compared as text rather
/// than canonicalized: canonicalizing costs syscalls per call and resolves
/// symlinks, and both paths here were written by this app.
fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        p.to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    norm(a) == norm(b)
}

struct Spare {
    dir: PathBuf,
    /// The repository this checkout came from, as its marker recorded it.
    repo: PathBuf,
    /// The commit the checkout in there is on.
    head: String,
    /// When it was made, in seconds since the epoch. Zero for a marker written
    /// before this line existed, which reads as ancient and gets collected.
    at: u64,
}

/// The unclaimed worktrees under `base`, all of them or only one repository's.
///
/// Read off the disk rather than held in memory, so a spare survives a restart
/// instead of being leaked and remade. Cheap: one directory listing and a couple
/// of small file reads.
fn read_spares(base: &Path, repo: Option<&Path>) -> Vec<Spare> {
    let Ok(entries) = fs::read_dir(base) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let marker = entry.path();
        let Some(name) = marker.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(dir_name) = name.strip_suffix(SPARE_SUFFIX) else {
            continue;
        };
        let Ok(text) = fs::read_to_string(&marker) else {
            continue;
        };
        let mut owner: Option<&str> = None;
        let mut head: Option<&str> = None;
        let mut at = 0u64;
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("repo=") {
                owner = Some(v.trim());
            } else if let Some(v) = line.strip_prefix("head=") {
                head = Some(v.trim());
            } else if let Some(v) = line.strip_prefix("at=") {
                at = v.trim().parse().unwrap_or(0);
            }
        }
        let (Some(owner), Some(head)) = (owner, head) else {
            continue;
        };
        if repo.is_some_and(|repo| !same_dir(Path::new(owner), repo)) {
            continue;
        }
        out.push(Spare {
            dir: base.join(dir_name),
            repo: PathBuf::from(owner),
            head: head.to_string(),
            at,
        });
    }
    out
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_spare_marker(dir: &Path, repo: &Path, head: &str) -> std::io::Result<()> {
    let marker = spare_marker(dir)
        .ok_or_else(|| std::io::Error::other("a worktree path with no name"))?;
    fs::write(
        marker,
        format!(
            "repo={}\nhead={}\nat={}\n",
            repo.display(),
            head,
            now_secs()
        ),
    )
}

/// Gives a spare's directory back. Never a worktree anyone is using.
///
/// Unforced: the pool only ever owns directories nobody has been handed, so a
/// refusal here means there is real work in one — somebody opened a shell in a
/// spare and wrote in it — and it is left alone. Its marker is gone by the time
/// this runs, so it shows up in the Worktrees tab as the ordinary worktree it
/// has become, which is the one place it can still be dealt with.
fn drop_spare(repo: &Path, dir: &Path) {
    let _ = remove_worktree_blocking(&repo.to_string_lossy(), &dir.to_string_lossy(), false);
}

/// Keeps the pool inside its bounds, by count and by age.
///
/// Called from warming rather than from a timer, because warming is the only
/// thing that ever makes the pool bigger, and therefore the only moment it can
/// be over.
fn collect_spares(base: &Path) {
    let mut spares = read_spares(base, None);
    // Newest first, so what survives the cap is what the next thread is most
    // likely to want.
    spares.sort_by_key(|spare| std::cmp::Reverse(spare.at));
    let now = now_secs();
    let mut kept = 0usize;
    for spare in spares {
        let expired = now.saturating_sub(spare.at) > SPARE_MAX_AGE.as_secs();
        if !expired && kept < MAX_SPARES {
            kept += 1;
            continue;
        }
        // Taken out of the pool exactly as a thread takes one: a spare claimed
        // between the listing above and this line is not ours to remove.
        if !take_marker(&spare.dir) {
            continue;
        }
        if spare.dir.is_dir() {
            drop_spare(&spare.repo, &spare.dir);
        }
    }
}

/// Moves an existing checkout onto another commit. One process, and it writes
/// only the paths that differ between the two trees.
fn detach_to(worktree: &Path, oid: &str) -> Result<(), String> {
    let mut cmd = git(worktree);
    cmd.args(["checkout", "--detach", oid]);
    run(cmd).map(|_| ())
}

/// Claims a ready-made worktree for this repository, or answers that there is
/// none to claim.
fn take_spare(base: &Path, repo: &Path) -> Option<String> {
    let wanted = head_oid(repo)?;
    let now = now_secs();
    for spare in read_spares(base, Some(repo)) {
        // Of two threads born at the same moment exactly one wins a given spare,
        // and the other moves on to the next.
        if !take_marker(&spare.dir) {
            continue;
        }
        // A marker that outlived its directory: deleted by hand, or a creation
        // that failed after writing it. The claim above is what cleaned it up.
        if !spare.dir.is_dir() {
            continue;
        }
        // Older than its copy of the shared directories is worth trusting.
        // Handing it over would give the agent whatever lockfile was current
        // when it was made.
        if now.saturating_sub(spare.at) > SPARE_MAX_AGE.as_secs() {
            drop_spare(repo, &spare.dir);
            continue;
        }
        if spare.head == wanted {
            return Some(spare.dir.to_string_lossy().into_owned());
        }
        // Made before the last commits landed. A thread has to start on the
        // commit the project is on, and moving this checkout is one process over
        // the diff, where making another is a whole checkout plus its shared
        // directories again.
        if detach_to(&spare.dir, &wanted).is_ok() {
            // The checkout it just did can have taken one of them away, and a
            // spare made before an install has never seen the rest. Cheap when
            // there is nothing to do: one stat per directory.
            provision_shared_artifacts(repo, &spare.dir);
            return Some(spare.dir.to_string_lossy().into_owned());
        }
        // Refused to move — something is in there after all. Never hand back a
        // checkout of the wrong commit. Removed here and not on a thread of its
        // own: the caller goes straight on to `worktree add` in this same
        // repository, and two git processes in `.git/worktrees` at once is a
        // race for no gain.
        drop_spare(repo, &spare.dir);
    }
    None
}

/// Repositories a spare is being made for right now. Two warms would otherwise
/// each find none and each make one.
static WARMING: parking_lot::Mutex<Vec<String>> = parking_lot::Mutex::new(Vec::new());

struct WarmGuard(String);

impl WarmGuard {
    /// None when another thread is already warming this repository.
    fn claim(repo: &Path) -> Option<Self> {
        let key = repo.to_string_lossy().to_lowercase();
        let mut warming = WARMING.lock();
        if warming.contains(&key) {
            return None;
        }
        warming.push(key.clone());
        Some(Self(key))
    }
}

impl Drop for WarmGuard {
    fn drop(&mut self) {
        WARMING.lock().retain(|k| k != &self.0);
    }
}

/// Makes sure this repository has one worktree standing by, and that it is on
/// the commit the repository is on.
///
/// This is the whole point of the pool: `git worktree add` plus the shared
/// directories is around half a second on a small repository and seconds on a
/// large one, and it used to sit between a click and a terminal that could show
/// anything. Paid here instead, off any click.
///
/// Never asks whether the main checkout is clean. That question decides whether
/// a *thread* gets a worktree; a spare is made from HEAD either way, and one
/// made while the checkout was dirty is exactly as good once it is clean again.
pub fn warm_worktree_pool_blocking(repo: &str, base: &str) -> Result<(), String> {
    let r = Path::new(repo);
    if git_dir(r).is_none() {
        return Ok(());
    }
    let Some(head) = head_oid(r) else {
        // No commits yet: nothing to check out, and nothing to warm.
        return Ok(());
    };
    let base = Path::new(base);
    fs::create_dir_all(base).map_err(|e| format!("worktree base: {e}"))?;
    let Some(_guard) = WarmGuard::claim(r) else {
        return Ok(());
    };

    // Before anything else, because warming is what fills the pool and this is
    // the only thing that empties it.
    collect_spares(base);

    for spare in read_spares(base, Some(r)) {
        if !spare.dir.is_dir() {
            // A marker that outlived its directory.
            let _ = take_marker(&spare.dir);
            continue;
        }
        // Already standing by, on the commit the project is on.
        if spare.head == head {
            return Ok(());
        }
        // Behind the project. Brought up to date here rather than at claim time,
        // so the thread that takes it pays nothing at all — but only after
        // taking the marker, which is the same single operation a thread's claim
        // uses. Losing that race means an agent now owns this directory and is
        // already writing in it, and `git checkout --detach` in there would
        // throw that work away.
        if !take_marker(&spare.dir) {
            continue;
        }
        if detach_to(&spare.dir, &head).is_ok() {
            provision_shared_artifacts(r, &spare.dir);
            // Back in the pool, and not one moment earlier: between the two
            // lines above it belongs to this call and to nobody else.
            let _ = write_spare_marker(&spare.dir, r, &head);
            return Ok(());
        }
        // It would not move, so it is not something to hand a thread.
        drop_spare(r, &spare.dir);
    }

    let dir = scoped_dir_for(base, &format!("spare-{}", uuid::Uuid::new_v4()));
    add_detached_worktree_blocking(repo, &dir.to_string_lossy())?;
    // Last, so a spare is only ever offered once it is a complete checkout: the
    // marker is what makes it claimable, and a failed creation leaves a
    // directory nobody will hand out.
    write_spare_marker(&dir, r, &head).map_err(|e| format!("spare marker: {e}"))?;
    // The one just made is the newest, so this drops the oldest over the cap
    // rather than what was just paid for.
    collect_spares(base);
    Ok(())
}

fn warm_in_background(repo: &Path, base: &Path) {
    let repo = repo.to_string_lossy().into_owned();
    let base = base.to_string_lossy().into_owned();
    thread::spawn(move || {
        let _ = warm_worktree_pool_blocking(&repo, &base);
    });
}

/// Opens a worktree for a thread, or answers that this repository is not one
/// to open a worktree in. `Ok(None)` means the thread runs in the project
/// folder.
///
/// The eligibility checks live here rather than in the caller because each one
/// used to cost an IPC round trip and a `git` process of its own: the frontend
/// asked "is this a repo", then "is it clean", then "open one", paying three
/// process spawns to reach a decision that is mostly filesystem state. On
/// Windows a process spawn is the expensive part of this whole operation, not
/// the checkout.
///
/// `label` names the directory only when one has to be made here. The ordinary
/// path hands over a spare, which was named when it was made — that is what
/// takes `git worktree add` out from in front of the terminal, and it leaves the
/// status check below as the only thing a new thread waits on.
pub fn open_worktree_if_eligible_blocking(
    repo: &str,
    base: &str,
    label: &str,
) -> Result<Option<String>, String> {
    let r = Path::new(repo);
    // No subprocess: a repository is a `.git` directory, or the `gitdir:` file
    // a worktree and a submodule get, and both are one stat away.
    if git_dir(r).is_none() {
        return Ok(None);
    }
    // "Look at what I just changed" cannot be answered from a clean worktree.
    // A dirty main checkout means the work under discussion is there, so the
    // thread starts there too.
    let mut status = git(r);
    status.args(["status", "--porcelain", "--untracked-files=normal"]);
    if !run(status)?.is_empty() {
        return Ok(None);
    }
    let base = Path::new(base);
    fs::create_dir_all(base).map_err(|e| format!("worktree base: {e}"))?;

    if let Some(dir) = take_spare(base, r) {
        // Refill, so the next thread in this project is as cheap as this one.
        warm_in_background(r, base);
        return Ok(Some(dir));
    }
    // Nothing standing by: this thread pays for its own checkout, which is what
    // every thread used to do.
    let path = scoped_dir_for(base, label).to_string_lossy().into_owned();
    let made = add_detached_worktree_blocking(repo, &path)?;
    warm_in_background(r, base);
    Ok(Some(made))
}

/// Turns a detached worktree into a branch, once its work has proved worth
/// keeping. Fails if the name is taken, so a claim never quietly hijacks an
/// existing branch.
pub fn claim_worktree_branch_blocking(worktree: &str, name: &str) -> Result<(), String> {
    let w = Path::new(worktree);
    if !w.is_dir() {
        return Err("Not a directory".into());
    }
    validate_branch_name(w, name)?;
    if local_branch_exists(w, name) {
        return Err(format!("A branch named '{name}' already exists."));
    }
    let mut cmd = git(w);
    cmd.args(["switch", "-c", name]);
    run(cmd)?;
    Ok(())
}

/// Directories a worktree takes from the main checkout instead of building its
/// own copy of from scratch.
///
/// These are the ones that make a worktree expensive rather than cheap: a
/// second `node_modules` and a second `target` turn a few megabytes of source
/// into gigabytes, and an agent that has to install and recompile before it can
/// run anything is an agent that cannot work. All of them are build output or
/// fetched dependencies — reproducible, never the user's own files.
pub const SHARED_ARTIFACTS: [&str; 4] = ["node_modules", "target", ".venv", "vendor"];

/// The ones a build writes into on every single run, as opposed to only when
/// the user installs something.
///
/// The distinction decides what happens when the filesystem cannot clone. A
/// link to `node_modules` is wrong only if someone runs an install; a link to
/// `target` is wrong on the next `cargo build`, because two worktrees of the
/// same package resolve to one artifact slot. Measured, not assumed: build A,
/// edit and build B, then build A again — cargo reports A fresh in 0.00s and
/// `target/debug/<name>` is B's binary. The agent then tests the other thread's
/// code and is told it passed.
const BUILD_OUTPUT: [&str; 1] = ["target"];

/// Gives the worktree its own copy of the main checkout's heavy directories,
/// cloned rather than duplicated where the filesystem can. Returns the names
/// actually provisioned.
///
/// Copy-on-write is what makes this affordable: on APFS this repository's 32 GB
/// `target` clones in 13 seconds and costs no disk at all until one of the two
/// copies is written to. That is the whole reason the directories can be
/// separate now — the previous symlink was not chosen for speed over
/// correctness, it was chosen because a real copy of `target` was unthinkable.
///
/// Best-effort by design: what cannot be provisioned costs disk and time, not
/// correctness, so a failure is skipped rather than raised.
pub fn provision_shared_artifacts(repo: &Path, worktree: &Path) -> Vec<String> {
    let mut done = Vec::new();
    for name in SHARED_ARTIFACTS {
        let src = repo.join(name);
        if !src.is_dir() {
            continue;
        }
        let dst = worktree.join(name);
        // A real directory of that name in the worktree is tracked content, and
        // replacing it would delete work. Only an absent path is ours to fill.
        if fs::symlink_metadata(&dst).is_ok() {
            continue;
        }
        if clone_dir(&src, &dst).is_ok() {
            done.push(name.to_string());
            continue;
        }
        // No copy-on-write here: ext4, a network volume, Windows outside a dev
        // drive. Sharing is still the right trade for the install-time ones —
        // it is what makes a JavaScript worktree usable at all — but never for
        // build output, which would hand this thread another's binaries. Cargo
        // creates its own `target` on first build; it is slow, not wrong.
        if BUILD_OUTPUT.contains(&name) {
            continue;
        }
        if link_dir(&src, &dst).is_ok() {
            done.push(name.to_string());
        }
    }
    done
}

/// Clones a directory tree copy-on-write, or fails without writing anything.
///
/// Refusing is the contract, and it is the hard part. A clone that quietly
/// degrades to a byte copy is worse than no clone at all: it writes a real
/// 32 GB where the caller budgeted nothing, and it reports success, so nothing
/// downstream ever learns the volume could not do this.
#[cfg(target_os = "macos")]
fn clone_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let cstr = |p: &Path| {
        CString::new(p.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::other("path contains a nul byte"))
    };
    let (s, d) = (cstr(src)?, cstr(dst)?);
    // The syscall, not `cp -c`. `cp -c` was the obvious choice and it is the
    // wrong one: measured, it exits 0 and copies every byte both when the two
    // paths are on different volumes and when the volume is not APFS, so it
    // can never be used to ask whether cloning is possible. `clonefile` clones
    // a directory hierarchy in one call and reports EXDEV or ENOTSUP instead
    // of pretending.
    if unsafe { libc::clonefile(s.as_ptr(), d.as_ptr(), 0) } == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    let _ = fs::remove_dir_all(dst);
    Err(err)
}

#[cfg(target_os = "linux")]
fn clone_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    // `always`, never `auto`: `auto` is the same trap as `cp -c`, degrading to
    // a full byte copy on ext4 while reporting success. `always` is documented
    // to fail instead, and that includes the cross-filesystem case, so this
    // stays a real capability probe.
    let mut cmd = Command::new("cp");
    cmd.arg("--reflink=always").arg("-r").arg(src).arg(dst);
    let status = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if status.success() {
        return Ok(());
    }
    // A refusal partway through still leaves a tree behind, and every later
    // caller would read that as "already provisioned" and skip the fallback.
    let _ = fs::remove_dir_all(dst);
    Err(std::io::Error::other("clone failed"))
}

/// Windows has no block cloning outside a ReFS dev drive, and no command-line
/// verb for it. The install-time directories fall through to a junction as
/// before; `target` is left for the build to create.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn clone_dir(_src: &Path, _dst: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("no copy-on-write on this platform"))
}

#[cfg(windows)]
fn link_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    // A junction rather than a symlink: symlink creation needs either developer
    // mode or elevation on Windows, junctions need neither.
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "mklink", "/J"])
        .arg(dst)
        .arg(src)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // Without this the console host paints a real window for every link,
        // so opening a worktree flashes one per shared directory.
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let status = cmd.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("mklink failed"))
    }
}

#[cfg(not(windows))]
fn link_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

/// Removes the links, never what they point at.
///
/// This has to run before `git worktree remove`. Git deletes the directory
/// tree, and on Windows it descends into a junction and empties the *target* —
/// which is the main checkout's `node_modules`. That is not theoretical: it is
/// how one was destroyed during this feature's own development.
///
/// A cloned directory is deliberately not touched here: it belongs to this
/// worktree alone, nothing outside is reachable through it, and git deleting it
/// with the rest of the tree is the correct outcome. Copy-on-write means that
/// frees only the blocks the two copies stopped sharing.
pub fn unlink_shared_artifacts(worktree: &Path) {
    for name in SHARED_ARTIFACTS {
        let dst = worktree.join(name);
        let Ok(meta) = fs::symlink_metadata(&dst) else {
            continue;
        };
        if !meta.file_type().is_symlink() {
            // A real directory: whatever it is, it is not ours to delete.
            continue;
        }
        // `remove_dir` unlinks the junction or directory symlink itself and
        // never follows it. `remove_dir_all` would be the bug this exists to
        // prevent.
        let _ = fs::remove_dir(&dst).or_else(|_| fs::remove_file(&dst));
    }
}

/// Moves a detached worktree onto a branch that already exists.
///
/// The other half of claiming: continuing something already started, rather
/// than naming something new. Git refuses a branch that is checked out in
/// another worktree — including the main one — and that refusal is worth
/// passing on plainly, because it is the whole reason a second checkout of the
/// same branch cannot exist.
pub fn reserve_worktree_branch_blocking(worktree: &str, name: &str) -> Result<(), String> {
    let w = Path::new(worktree);
    if !w.is_dir() {
        return Err("Not a directory".into());
    }
    validate_branch_name(w, name)?;
    if !local_branch_exists(w, name) {
        return Err(format!("There is no local branch named '{name}'."));
    }
    if let Some(holder) = worktree_holding_branch(w, name) {
        return Err(format!(
            "'{name}' is already checked out at {holder}. Only one worktree can hold a branch."
        ));
    }
    let mut cmd = git(w);
    cmd.args(["switch", name]);
    run(cmd)?;
    Ok(())
}

/// Which worktree, if any, currently has this branch checked out.
fn worktree_holding_branch(path: &Path, name: &str) -> Option<String> {
    let mut cmd = git(path);
    cmd.args(["worktree", "list", "--porcelain"]);
    let out = run(cmd).ok()?;
    let text = String::from_utf8_lossy(&out);
    let target = format!("refs/heads/{name}");
    let mut current: Option<String> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            current = Some(rest.to_string());
        } else if line.strip_prefix("branch ") == Some(target.as_str()) {
            return current;
        }
    }
    None
}

/// What removing this worktree would cost. Read before every removal.
pub fn worktree_hold_blocking(worktree: &str) -> Result<WorktreeHold, String> {
    let w = Path::new(worktree);
    if !w.is_dir() {
        return Err("Not a directory".into());
    }

    let mut status = git(w);
    // Untracked files count: a file the agent created and never staged is
    // exactly the work a cleanup must not throw away.
    status.args(["status", "--porcelain", "--untracked-files=normal"]);
    let dirty = !run(status)?.is_empty();

    // No local branch contains HEAD, so these commits live in this directory
    // and nowhere else. A claimed branch shows up here and clears the flag.
    //
    // `for-each-ref` rather than `branch --contains`: the latter also prints
    // the detached head itself as `* (HEAD detached at abc1234)`, so its output
    // is never empty in exactly the case this has to detect.
    let mut contains = git(w);
    contains.args(["for-each-ref", "--contains", "HEAD", "refs/heads/"]);
    let orphan_commits = run(contains)
        .map(|out| String::from_utf8_lossy(&out).trim().is_empty())
        .unwrap_or(true);

    Ok(WorktreeHold {
        dirty,
        orphan_commits,
    })
}

/// Removes a worktree, refusing while it still holds work.
///
/// `force` is the user answering for themselves after being told what is in
/// there. Automatic cleanup never passes it: it deletes empty worktrees only,
/// which is what makes an agent that forgets to claim a branch harmless.
pub fn remove_worktree_blocking(
    repo: &str,
    worktree: &str,
    force: bool,
) -> Result<(), String> {
    let r = Path::new(repo);
    if !r.is_dir() {
        return Err("Not a directory".into());
    }
    if !force {
        let hold = worktree_hold_blocking(worktree)?;
        if hold.holds_work() {
            return Err(match (hold.dirty, hold.orphan_commits) {
                (true, true) => "This worktree has uncommitted changes and commits on no branch.",
                (true, false) => "This worktree has uncommitted changes.",
                _ => "This worktree has commits that are on no branch.",
            }
            .into());
        }
    }
    // Before git touches the directory, and not optional: git deletes the tree
    // and on Windows follows a junction into the main checkout's own
    // `node_modules`, emptying it.
    unlink_shared_artifacts(Path::new(worktree));
    let mut cmd = git(r);
    cmd.args(["worktree", "remove", "--force", worktree]);
    run(cmd)?;
    // A worktree whose directory was deleted by hand leaves an administrative
    // file behind, and the path stays "already registered" until it is pruned.
    let mut prune = git(r);
    prune.args(["worktree", "prune"]);
    let _ = run(prune);
    Ok(())
}

/// One line of `git worktree list`, with what it would cost to remove it.
///
/// The repository is the authority, not Boite's thread rows: a worktree whose
/// thread was deleted still exists on disk and still holds whatever was in it,
/// and that is precisely the one nobody can see today.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    /// The branch it is on, or none when HEAD is detached — which is how every
    /// worktree Boite opens starts out.
    pub branch: Option<String>,
    pub head: String,
    /// The first one git lists is the repository's own checkout. It is in the
    /// list because leaving it out would make the numbers not add up, and it
    /// is flagged because it is the one that must never be offered for removal.
    pub main: bool,
    pub locked: bool,
    /// Git would drop this entry on the next `worktree prune`: its directory is
    /// gone, only the administrative file is left.
    pub prunable: bool,
    /// Modified, staged or untracked files. False for a worktree whose
    /// directory no longer exists, where there is nothing left to be dirty.
    pub dirty: bool,
    /// HEAD is on no local branch, so the commits here are reachable from
    /// nowhere else.
    pub orphan_commits: bool,
    /// Made ahead of time and not claimed yet: the next agent thread in this
    /// repository walks into it instead of waiting for a checkout. Removing it
    /// costs nothing but the head start.
    pub spare: bool,
}

/// Every worktree of a repository, its own checkout included.
///
/// `--porcelain` because the human format elides and aligns; each record is a
/// blank-line-separated block of `key value` lines, and the keys that carry no
/// value (`bare`, `detached`, `prunable`) appear alone.
///
/// The dirty and orphan flags cost two git invocations per worktree, which is
/// why this exists as one call rather than as a list the caller then walks: on
/// Windows the round trips are the expensive part, and a page that has to draw
/// the whole picture wants it in one answer.
pub fn list_worktrees_blocking(repo: &str) -> Result<Vec<WorktreeEntry>, String> {
    let r = Path::new(repo);
    if !r.is_dir() {
        return Err("Not a directory".into());
    }
    let mut cmd = git(r);
    cmd.args(["worktree", "list", "--porcelain"]);
    let out = run(cmd)?;
    let text = String::from_utf8_lossy(&out);

    let mut entries: Vec<WorktreeEntry> = Vec::new();
    let mut path: Option<String> = None;
    let mut head = String::new();
    let mut branch: Option<String> = None;
    let mut locked = false;
    let mut prunable = false;

    // A record ends at a blank line, and the last one ends at the end of the
    // output — hence the sentinel rather than a flush after the loop.
    for line in text.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(p) = path.take() {
                let main = entries.is_empty();
                // Listed rather than hidden, and marked. It carries no thread and
                // holds no work, so a row nobody could explain would be worse
                // than one that says what it is — and hiding it would make the
                // one directory the pool keeps per repository invisible to the
                // one page that can reclaim it.
                let spare = !main && is_spare_worktree(&p);
                // A pruned-away directory cannot be inspected, and reporting it
                // as clean would invite exactly the removal that is already
                // safe. The prunable flag is what that row is about.
                let hold = worktree_hold_blocking(&p).unwrap_or(WorktreeHold {
                    dirty: false,
                    orphan_commits: false,
                });
                entries.push(WorktreeEntry {
                    path: p,
                    branch: branch.take(),
                    head: std::mem::take(&mut head),
                    main,
                    locked,
                    prunable,
                    dirty: hold.dirty,
                    orphan_commits: hold.orphan_commits,
                    spare,
                });
            }
            locked = false;
            prunable = false;
            continue;
        }
        let (key, value) = match line.split_once(' ') {
            Some((k, v)) => (k, v),
            None => (line, ""),
        };
        match key {
            "worktree" => path = Some(value.to_string()),
            "HEAD" => head = value.to_string(),
            // `refs/heads/x` is what git prints; the panel wants `x`.
            "branch" => branch = Some(value.trim_start_matches("refs/heads/").to_string()),
            "locked" => locked = true,
            "prunable" => prunable = true,
            _ => {}
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod worktree_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "boite-worktree-{tag}-{}-{nonce}-{seq}",
            std::process::id()
        ))
    }

    fn git_in(path: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {:?}", out);
    }

    struct Fixture {
        repo: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let repo = scratch("repo");
            fs::create_dir_all(&repo).unwrap();
            git_in(&repo, &["init", "--quiet"]);
            git_in(&repo, &["config", "user.name", "Boite Test"]);
            git_in(&repo, &["config", "user.email", "boite@example.test"]);
            git_in(&repo, &["branch", "-M", "master"]);
            fs::write(repo.join("a.txt"), "one\n").unwrap();
            git_in(&repo, &["add", "a.txt"]);
            git_in(&repo, &["commit", "--quiet", "-m", "initial"]);
            Self { repo }
        }

        fn path(&self) -> &str {
            self.repo.to_str().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.repo);
        }
    }

    /// HEAD is read off the filesystem rather than through `git rev-parse`, so
    /// every shape it comes in has to be recognised: unborn (a symref to a
    /// branch that has no commit), loose, packed, and detached.
    #[test]
    fn head_is_resolved_without_asking_git() {
        let empty = scratch("empty");
        fs::create_dir_all(&empty).unwrap();
        git_in(&empty, &["init", "--quiet"]);
        assert!(
            !head_has_commit(&empty),
            "an unborn HEAD has no commit to detach from"
        );
        let w = scratch("w-empty");
        assert_eq!(
            add_detached_worktree_blocking(empty.to_str().unwrap(), w.to_str().unwrap()),
            Err("This repository has no commits yet.".into()),
        );
        assert!(!w.exists());
        let _ = fs::remove_dir_all(&empty);

        let f = Fixture::new();
        assert!(head_has_commit(&f.repo), "a loose ref is a commit");
        // Packed: the loose file under refs/heads is gone and the ref only
        // exists as a line in packed-refs.
        git_in(&f.repo, &["pack-refs", "--all"]);
        assert!(
            !f.repo.join(".git/refs/heads/master").is_file(),
            "pack-refs should have removed the loose ref"
        );
        assert!(head_has_commit(&f.repo), "a packed ref is a commit too");

        // Detached, and through a linked worktree, whose own HEAD sits in
        // .git/worktrees/<name> while its refs stay with the main checkout.
        let linked = scratch("linked");
        assert!(add_detached_worktree_blocking(f.path(), linked.to_str().unwrap()).is_ok());
        assert!(head_has_commit(&linked), "a detached HEAD is an object id");
        let _ = remove_worktree_blocking(f.path(), linked.to_str().unwrap(), true);
    }

    /// A ref is allowed to name another ref, and git writes that itself for
    /// `HEAD -> refs/heads/master` on a repository whose default branch was
    /// renamed through a symbolic ref. Stopping at the first hop reads a working
    /// repository as one with no commits.
    #[test]
    fn head_follows_a_ref_that_names_another_ref() {
        let f = Fixture::new();
        let real = head_oid(&f.repo).expect("the fixture has a commit");

        // HEAD -> refs/heads/alias -> refs/heads/master -> <oid>.
        fs::write(f.repo.join(".git/refs/heads/alias"), "ref: refs/heads/master\n").unwrap();
        fs::write(f.repo.join(".git/HEAD"), "ref: refs/heads/alias\n").unwrap();
        assert_eq!(
            head_oid(&f.repo).as_deref(),
            Some(real.as_str()),
            "a chain of symrefs still ends at the commit"
        );
        assert!(head_has_commit(&f.repo));

        // A chain that closes on itself is a broken repository, and has to
        // answer rather than read files forever.
        fs::write(f.repo.join(".git/refs/heads/alias"), "ref: refs/heads/alias\n").unwrap();
        assert_eq!(head_oid(&f.repo), None, "a cycle is not a commit");
    }

    /// A ref that outlived its object. `worktree add` answers that with a
    /// message about an invalid reference, which is the message the guard is
    /// there to replace — so the guard has to see it, and reading the ref file
    /// alone cannot.
    #[test]
    fn a_ref_pointing_at_nothing_is_not_a_commit() {
        let f = Fixture::new();
        let real = head_oid(&f.repo).expect("the fixture has a commit");
        let master = f.repo.join(".git/refs/heads/master");

        let dangling = "0123456789abcdef0123456789abcdef01234567";
        fs::write(&master, format!("{dangling}\n")).unwrap();
        assert_eq!(head_oid(&f.repo).as_deref(), Some(dangling), "the ref reads");
        assert!(!head_has_commit(&f.repo), "but nothing is behind it");

        let w = scratch("w-dangling");
        assert_eq!(
            add_detached_worktree_blocking(f.path(), w.to_str().unwrap()),
            Err("This repository has no commits yet.".into()),
        );
        assert!(!w.exists());

        // The same question, once the object is packed rather than loose. A
        // freshly cloned repository has no loose objects at all, so a check that
        // only looked at `objects/xx/` would answer "no commits yet" on every
        // one of them.
        fs::write(&master, format!("{real}\n")).unwrap();
        git_in(&f.repo, &["repack", "-ad"]);
        git_in(&f.repo, &["prune-packed"]);
        assert!(
            !f.repo
                .join(format!(".git/objects/{}/{}", &real[..2], &real[2..]))
                .is_file(),
            "repack should have swept the loose object"
        );
        assert!(head_has_commit(&f.repo), "a packed commit is still a commit");
    }

    /// A ref is allowed to point at any object, and `worktree add --detach`
    /// needs a commit. An object that exists but is a tree has to be refused
    /// here rather than by git, or the user reads a message about an invalid
    /// reference instead of the guard's own.
    #[test]
    fn a_ref_pointing_at_a_non_commit_is_refused() {
        let f = Fixture::new();
        let mut cmd = git(&f.repo);
        cmd.args(["rev-parse", "HEAD^{tree}"]);
        let tree = String::from_utf8(run(cmd).unwrap())
            .unwrap()
            .trim()
            .to_string();

        fs::write(f.repo.join(".git/refs/heads/master"), format!("{tree}\n")).unwrap();
        assert_eq!(
            head_oid(&f.repo).as_deref(),
            Some(tree.as_str()),
            "the ref reads, and the object is really there"
        );
        assert!(
            !head_has_commit(&f.repo),
            "an existing tree is still not something to check out"
        );

        let w = scratch("w-tree");
        assert_eq!(
            add_detached_worktree_blocking(f.path(), w.to_str().unwrap()),
            Err("This repository has no commits yet.".into()),
        );
        assert!(!w.exists());
    }

    /// The three answers the eligibility check has to give, since it is now the
    /// only thing standing between a thread and a worktree.
    #[test]
    fn eligibility_refuses_a_non_repo_and_a_dirty_checkout() {
        let plain = scratch("plain");
        fs::create_dir_all(&plain).unwrap();
        let base = scratch("base-plain");
        assert_eq!(
            open_worktree_if_eligible_blocking(
                plain.to_str().unwrap(),
                base.to_str().unwrap(),
                "t1",
            ),
            Ok(None),
        );
        assert!(
            !base.join("t1").exists(),
            "a non-repo must not get a worktree"
        );
        let _ = fs::remove_dir_all(&plain);
        let _ = fs::remove_dir_all(&base);

        let f = Fixture::new();
        // Clean, and nothing standing by: a worktree named after the thread,
        // under the base.
        let base = scratch("base-clean");
        let made = open_worktree_if_eligible_blocking(f.path(), base.to_str().unwrap(), "t1");
        assert_eq!(
            made,
            Ok(Some(base.join("t1").to_string_lossy().into_owned())),
        );
        assert!(base.join("t1").join("a.txt").is_file());
        let _ = remove_worktree_blocking(
            f.path(),
            base.join("t1").to_str().unwrap(),
            true,
        );

        // An untracked file counts: the work under discussion is in the main
        // checkout, so the thread has to start there and see it.
        let dirty = scratch("base-dirty");
        fs::write(f.repo.join("scratch.txt"), "wip\n").unwrap();
        assert_eq!(
            open_worktree_if_eligible_blocking(f.path(), dirty.to_str().unwrap(), "t2"),
            Ok(None),
        );
        assert!(!dirty.join("t2").exists());
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&dirty);
    }

    /// The pool, which is the difference between a thread that waits for a
    /// checkout and one that walks into a finished one.
    #[test]
    fn a_spare_is_made_ahead_and_handed_to_the_next_thread() {
        let f = Fixture::new();
        let base = scratch("pool");
        fs::create_dir_all(&base).unwrap();
        let base_s = base.to_str().unwrap().to_string();

        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        let spares = read_spares(&base, Some(&f.repo));
        assert_eq!(spares.len(), 1, "warming leaves exactly one spare");
        let dir = spares[0].dir.clone();
        assert!(dir.join("a.txt").is_file(), "a spare is a real checkout");

        // Warming again keeps the one that is already there.
        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        assert_eq!(read_spares(&base, Some(&f.repo)).len(), 1);

        let listed = list_worktrees_blocking(f.path()).unwrap();
        let row = listed
            .iter()
            .find(|e| same_dir(Path::new(&e.path), &dir))
            .expect("a spare is listed, so the page that can reclaim it sees it");
        assert!(row.spare, "and it says what it is");

        // The next thread gets that very directory, and it stops being a spare.
        let taken = open_worktree_if_eligible_blocking(f.path(), &base_s, "t1").unwrap();
        assert_eq!(taken.as_deref(), dir.to_str());
        assert!(
            !is_spare_worktree(dir.to_str().unwrap()),
            "claiming a spare is deleting its marker"
        );
        let listed = list_worktrees_blocking(f.path()).unwrap();
        let row = listed
            .iter()
            .find(|e| same_dir(Path::new(&e.path), &dir))
            .expect("a claimed worktree is listed like any other");
        assert!(!row.spare, "and is no longer standing by");

        let _ = remove_worktree_blocking(f.path(), dir.to_str().unwrap(), true);
        let _ = fs::remove_dir_all(&base);
    }

    /// A spare is only useful if it is on the commit the project is on: a thread
    /// that starts one commit behind is looking at the wrong code.
    #[test]
    fn a_spare_made_before_a_commit_is_brought_forward() {
        let f = Fixture::new();
        let base = scratch("pool-stale");
        fs::create_dir_all(&base).unwrap();
        let base_s = base.to_str().unwrap().to_string();

        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        let dir = read_spares(&base, Some(&f.repo))[0].dir.clone();
        assert!(!dir.join("b.txt").exists());

        fs::write(f.repo.join("b.txt"), "two\n").unwrap();
        git_in(&f.repo, &["add", "b.txt"]);
        git_in(&f.repo, &["commit", "--quiet", "-m", "second"]);

        let taken = open_worktree_if_eligible_blocking(f.path(), &base_s, "t1").unwrap();
        assert_eq!(taken.as_deref(), dir.to_str(), "the spare is still the one used");
        assert!(
            dir.join("b.txt").is_file(),
            "it has to carry the commit made after it was created"
        );

        let _ = remove_worktree_blocking(f.path(), dir.to_str().unwrap(), true);
        let _ = fs::remove_dir_all(&base);
    }

    /// The one thing the pool must never do: run `git checkout --detach` inside
    /// a directory an agent has already been handed. Warming brings a spare
    /// forward when the project has moved on, and a thread claims one by
    /// deleting its marker — so both have to be asking the same question, and
    /// the loser has to walk away.
    #[test]
    fn warming_will_not_touch_a_worktree_that_has_just_been_claimed() {
        let f = Fixture::new();
        let base = scratch("pool-race");
        fs::create_dir_all(&base).unwrap();
        let base_s = base.to_str().unwrap().to_string();

        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        let dir = read_spares(&base, Some(&f.repo))[0].dir.clone();

        // The project moves on, so the next warm has a reason to check the
        // spare out again.
        fs::write(f.repo.join("b.txt"), "two\n").unwrap();
        git_in(&f.repo, &["add", "b.txt"]);
        git_in(&f.repo, &["commit", "--quiet", "-m", "second"]);

        // Warming's own read of the pool, taken before anything else happens.
        // Everything below is what can land between that read and the checkout
        // it was about to run.
        let seen = read_spares(&base, Some(&f.repo));
        assert_eq!(seen.len(), 1);
        assert_ne!(seen[0].head, head_oid(&f.repo).unwrap(), "it is behind");

        // The thread wins the claim, and its agent starts writing.
        let taken = take_spare(&base, &f.repo).expect("the spare is claimable");
        assert_eq!(taken.as_str(), dir.to_str().unwrap());
        assert!(!is_spare_worktree(&taken), "and stops being a spare");
        fs::write(dir.join("agent-notes.md"), "work in progress\n").unwrap();

        // Warming resumes, holding the stale listing. The marker is the gate,
        // and it is gone: this is the exact line that used to be a bare
        // `detach_to` on `seen[0].dir`.
        assert!(
            !take_marker(&seen[0].dir),
            "a claimed spare must refuse warming the same way it refuses a second thread"
        );

        // And the whole call, for good measure.
        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();

        assert!(
            dir.join("agent-notes.md").is_file(),
            "warming ran a checkout in a claimed worktree and destroyed its untracked files"
        );
        assert!(
            !is_spare_worktree(dir.to_str().unwrap()),
            "and it must not have been put back in the pool"
        );
        // It made itself another one instead, which is the whole answer: the
        // claimed directory is nobody's business but the thread's.
        let spares = read_spares(&base, Some(&f.repo));
        assert_eq!(spares.len(), 1, "a fresh spare, not the claimed one");
        assert_ne!(spares[0].dir, dir);

        let _ = remove_worktree_blocking(f.path(), spares[0].dir.to_str().unwrap(), true);
        let _ = remove_worktree_blocking(f.path(), dir.to_str().unwrap(), true);
        let _ = fs::remove_dir_all(&base);
    }

    /// A spare is a whole checkout, made on project selection, and it used to be
    /// kept forever: looking at twenty projects wrote twenty of them and nothing
    /// took one back.
    #[test]
    fn the_pool_is_capped_by_count_and_by_age() {
        let f = Fixture::new();
        let base = scratch("pool-cap");
        fs::create_dir_all(&base).unwrap();
        let base_s = base.to_str().unwrap().to_string();

        // More spares than the cap allows, each one a real worktree of this
        // repository, as warming would have left them over several sessions.
        let mut made = Vec::new();
        for i in 0..(MAX_SPARES + 2) {
            let dir = base.join(format!("spare-{i}"));
            add_detached_worktree_blocking(f.path(), &dir.to_string_lossy()).unwrap();
            write_spare_marker(&dir, &f.repo, &head_oid(&f.repo).unwrap()).unwrap();
            made.push(dir);
        }
        assert_eq!(read_spares(&base, None).len(), MAX_SPARES + 2);

        // Through the ordinary door: warming is the only thing that grows the
        // pool, so it is also where it is brought back inside its bounds.
        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        assert_eq!(
            read_spares(&base, None).len(),
            MAX_SPARES,
            "the cap is the cap"
        );

        // Age, independent of the count: a marker old enough that its copy of
        // the shared directories cannot be trusted goes even under the cap.
        let left = read_spares(&base, None);
        let ancient = left[0].dir.clone();
        fs::write(
            spare_marker(&ancient).unwrap(),
            format!(
                "repo={}\nhead={}\nat={}\n",
                f.repo.display(),
                head_oid(&f.repo).unwrap(),
                now_secs() - SPARE_MAX_AGE.as_secs() - 1,
            ),
        )
        .unwrap();
        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        assert!(
            !ancient.exists(),
            "an expired spare is removed, not just unmarked"
        );
        assert_eq!(read_spares(&base, None).len(), MAX_SPARES - 1);

        for dir in made {
            let _ = remove_worktree_blocking(f.path(), dir.to_str().unwrap(), true);
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// The whole reason for detaching: two of them on the same commit, which
    /// `worktree add <branch>` would reject as already checked out.
    #[test]
    fn two_detached_worktrees_can_sit_on_the_same_commit() {
        let f = Fixture::new();
        let a = scratch("a");
        let b = scratch("b");
        add_detached_worktree_blocking(f.path(), a.to_str().unwrap()).unwrap();
        add_detached_worktree_blocking(f.path(), b.to_str().unwrap()).unwrap();
        assert!(a.join("a.txt").is_file());
        assert!(b.join("a.txt").is_file());
        // And neither invented a branch to do it.
        assert!(symbolic_branch(&a).is_none());
        assert!(symbolic_branch(&b).is_none());
        let _ = remove_worktree_blocking(f.path(), a.to_str().unwrap(), true);
        let _ = remove_worktree_blocking(f.path(), b.to_str().unwrap(), true);
    }

    #[test]
    fn listing_names_the_main_checkout_and_carries_each_worktree_state() {
        let f = Fixture::new();

        // Alone, the repository is its own only worktree.
        let solo = list_worktrees_blocking(f.path()).unwrap();
        assert_eq!(solo.len(), 1);
        assert!(solo[0].main);
        assert_eq!(solo[0].branch.as_deref(), Some("master"));
        assert!(!solo[0].dirty && !solo[0].orphan_commits);

        let dirty = scratch("list-dirty");
        add_detached_worktree_blocking(f.path(), dirty.to_str().unwrap()).unwrap();
        fs::write(dirty.join("scratch.txt"), "in flight\n").unwrap();

        let clean = scratch("list-clean");
        add_detached_worktree_blocking(f.path(), clean.to_str().unwrap()).unwrap();

        let all = list_worktrees_blocking(f.path()).unwrap();
        assert_eq!(all.len(), 3, "{all:?}");
        assert_eq!(all.iter().filter(|w| w.main).count(), 1);

        let found = |p: &Path| {
            all.iter()
                .find(|w| Path::new(&w.path) == p || w.path.contains(p.file_name().unwrap().to_str().unwrap()))
                .unwrap_or_else(|| panic!("{p:?} missing from {all:?}"))
        };

        // The untracked file is the whole point: it is work, and the list has
        // to say so without anyone opening the directory.
        assert!(found(&dirty).dirty);
        assert!(!found(&clean).dirty);
        // Detached is how every worktree Boite opens starts, so both sit on no
        // branch and their commits would go away with the directory.
        assert!(found(&dirty).branch.is_none());
        assert!(found(&clean).branch.is_none());

        let _ = remove_worktree_blocking(f.path(), dirty.to_str().unwrap(), true);
        let _ = remove_worktree_blocking(f.path(), clean.to_str().unwrap(), true);
    }

    #[test]
    fn a_fresh_worktree_holds_nothing_and_is_removable() {
        let f = Fixture::new();
        let w = scratch("fresh");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        let hold = worktree_hold_blocking(w.to_str().unwrap()).unwrap();
        assert!(!hold.holds_work(), "{hold:?}");

        remove_worktree_blocking(f.path(), w.to_str().unwrap(), false).unwrap();
        assert!(!w.exists());
    }

    #[test]
    fn an_untracked_file_is_enough_to_refuse_removal() {
        let f = Fixture::new();
        let w = scratch("untracked");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();
        fs::write(w.join("scratch.md"), "notes\n").unwrap();

        let hold = worktree_hold_blocking(w.to_str().unwrap()).unwrap();
        assert!(hold.dirty);
        assert!(remove_worktree_blocking(f.path(), w.to_str().unwrap(), false).is_err());
        assert!(w.exists(), "the refusal must not have deleted anything");

        remove_worktree_blocking(f.path(), w.to_str().unwrap(), true).unwrap();
    }

    /// An agent that commits without ever claiming a branch. Losing this is
    /// exactly what the guard exists to prevent.
    #[test]
    fn commits_on_no_branch_refuse_removal() {
        let f = Fixture::new();
        let w = scratch("orphan");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();
        fs::write(w.join("b.txt"), "work\n").unwrap();
        git_in(&w, &["add", "b.txt"]);
        git_in(&w, &["commit", "--quiet", "-m", "agent work"]);

        let hold = worktree_hold_blocking(w.to_str().unwrap()).unwrap();
        assert!(!hold.dirty, "committed, so the tree is clean");
        assert!(hold.orphan_commits);
        assert!(remove_worktree_blocking(f.path(), w.to_str().unwrap(), false).is_err());

        remove_worktree_blocking(f.path(), w.to_str().unwrap(), true).unwrap();
    }

    /// Claiming is what makes the work safe: the branch keeps the commits, so
    /// the directory is free to go.
    #[test]
    fn claiming_a_branch_makes_the_worktree_removable_again() {
        let f = Fixture::new();
        let w = scratch("claimed");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();
        fs::write(w.join("b.txt"), "work\n").unwrap();
        git_in(&w, &["add", "b.txt"]);
        git_in(&w, &["commit", "--quiet", "-m", "agent work"]);

        claim_worktree_branch_blocking(w.to_str().unwrap(), "feat/agent-work").unwrap();
        assert_eq!(symbolic_branch(&w).as_deref(), Some("feat/agent-work"));

        let hold = worktree_hold_blocking(w.to_str().unwrap()).unwrap();
        assert!(!hold.holds_work(), "the branch holds the commits now: {hold:?}");
        remove_worktree_blocking(f.path(), w.to_str().unwrap(), false).unwrap();

        // The branch outlived the directory, which is the point.
        let out = Command::new("git")
            .current_dir(&f.repo)
            .args(["branch", "--list", "feat/agent-work"])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&out.stdout).trim().is_empty());
    }

    #[test]
    fn a_claim_refuses_a_name_that_is_taken_or_malformed() {
        let f = Fixture::new();
        let w = scratch("names");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        assert!(claim_worktree_branch_blocking(w.to_str().unwrap(), "master").is_err());
        assert!(claim_worktree_branch_blocking(w.to_str().unwrap(), "bad name").is_err());
        // `--help` exits 0 and creates nothing, so it must be caught by name.
        assert!(claim_worktree_branch_blocking(w.to_str().unwrap(), "--help").is_err());
        assert!(symbolic_branch(&w).is_none(), "still detached");

        let _ = remove_worktree_blocking(f.path(), w.to_str().unwrap(), true);
    }

    /// The one that matters: removing a worktree must not reach through a link
    /// into the main checkout. A real `node_modules` was destroyed this way
    /// while this feature was being written.
    #[test]
    fn removing_a_worktree_leaves_the_shared_directories_alone() {
        let f = Fixture::new();
        let deps = f.repo.join("node_modules");
        fs::create_dir_all(deps.join("some-package")).unwrap();
        fs::write(deps.join("some-package/index.js"), "module.exports = 1\n").unwrap();

        let w = scratch("shared");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        let linked = w.join("node_modules");
        // Linking can legitimately fail (no permission, no junction support);
        // the removal below is the assertion either way.
        let was_linked = fs::symlink_metadata(&linked).is_ok();
        if was_linked {
            assert!(linked.join("some-package/index.js").is_file(), "link resolves");
        }

        remove_worktree_blocking(f.path(), w.to_str().unwrap(), true).unwrap();

        assert!(
            deps.join("some-package/index.js").is_file(),
            "the main checkout's node_modules was emptied through the link"
        );
    }

    /// Build output must never be shared, whatever the filesystem can do. On a
    /// volume with copy-on-write the worktree gets its own `target`; on one
    /// without, it gets none and the build makes it. What it must never get is
    /// a link, because two worktrees of one package share an artifact slot and
    /// the second build silently replaces the first's binary.
    #[test]
    fn a_worktree_never_shares_build_output_with_the_main_checkout() {
        let f = Fixture::new();
        let out = f.repo.join("target/debug");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("app"), "main checkout\n").unwrap();

        let w = scratch("build-output");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        let theirs = w.join("target");
        if let Ok(meta) = fs::symlink_metadata(&theirs) {
            assert!(!meta.file_type().is_symlink(), "target was shared by link");
            // A clone starts identical and diverges. Writing to it is the whole
            // point, so the main checkout has to be unaffected by that write.
            fs::write(theirs.join("debug/app"), "worktree\n").unwrap();
            assert_eq!(fs::read_to_string(out.join("app")).unwrap(), "main checkout\n");
        }

        let _ = remove_worktree_blocking(f.path(), w.to_str().unwrap(), true);
        assert_eq!(
            fs::read_to_string(out.join("app")).unwrap(),
            "main checkout\n",
            "removing the worktree reached into the main checkout's target"
        );
    }

    #[test]
    fn unlinking_never_touches_a_real_directory() {
        let dir = scratch("real");
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules/keep.txt"), "mine\n").unwrap();

        unlink_shared_artifacts(&dir);

        assert!(dir.join("node_modules/keep.txt").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reserving_moves_a_worktree_onto_an_existing_branch() {
        let f = Fixture::new();
        git_in(&f.repo, &["branch", "feat/started-earlier"]);
        let w = scratch("reserve");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        reserve_worktree_branch_blocking(w.to_str().unwrap(), "feat/started-earlier").unwrap();
        assert_eq!(symbolic_branch(&w).as_deref(), Some("feat/started-earlier"));

        let _ = remove_worktree_blocking(f.path(), w.to_str().unwrap(), true);
    }

    /// The message has to name the holder: "already checked out" with no
    /// location is the least actionable git error there is.
    #[test]
    fn reserving_a_branch_another_worktree_holds_says_where_it_is() {
        let f = Fixture::new();
        let a = scratch("holder");
        let b = scratch("wants-it");
        add_detached_worktree_blocking(f.path(), a.to_str().unwrap()).unwrap();
        add_detached_worktree_blocking(f.path(), b.to_str().unwrap()).unwrap();
        claim_worktree_branch_blocking(a.to_str().unwrap(), "feat/taken").unwrap();

        let err = reserve_worktree_branch_blocking(b.to_str().unwrap(), "feat/taken").unwrap_err();
        assert!(err.contains("feat/taken"), "{err}");
        assert!(err.contains("already checked out"), "{err}");
        assert!(symbolic_branch(&b).is_none(), "b stayed detached");

        // The branch the main checkout is on is held too, and by the same rule.
        let err = reserve_worktree_branch_blocking(b.to_str().unwrap(), "master").unwrap_err();
        assert!(err.contains("already checked out"), "{err}");

        let _ = remove_worktree_blocking(f.path(), a.to_str().unwrap(), true);
        let _ = remove_worktree_blocking(f.path(), b.to_str().unwrap(), true);
    }

    #[test]
    fn reserving_refuses_a_branch_that_does_not_exist() {
        let f = Fixture::new();
        let w = scratch("missing");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();
        let err = reserve_worktree_branch_blocking(w.to_str().unwrap(), "feat/never").unwrap_err();
        assert!(err.contains("no local branch"), "{err}");
        let _ = remove_worktree_blocking(f.path(), w.to_str().unwrap(), true);
    }

    #[test]
    fn an_id_cannot_climb_out_of_its_base() {
        let base = Path::new("/data/worktrees");
        assert_eq!(scoped_dir_for(base, "../../etc"), base.join("------etc"));
        assert_eq!(scoped_dir_for(base, "th_1-2"), base.join("th_1-2"));
        // Whatever it is given, the result stays one level under the base.
        for id in ["", "..", "/abs", "C:\\win", "a/b"] {
            let p = scoped_dir_for(base, id);
            assert_eq!(p.parent(), Some(base), "{id} escaped to {p:?}");
        }
    }

    #[test]
    fn adding_refuses_a_path_that_is_already_there() {
        let f = Fixture::new();
        let w = scratch("taken");
        fs::create_dir_all(&w).unwrap();
        assert!(add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&w);
    }
}

#[cfg(test)]
mod tests {
    use super::{find_repos_blocking, repo_relative};
    use std::fs;
    use std::path::Path;

    #[test]
    fn repo_relative_rejects_escapes() {
        assert!(repo_relative("src/lib.rs").is_ok());
        assert!(repo_relative("./src/lib.rs").is_ok());
        assert!(repo_relative("../../etc/passwd").is_err());
        assert!(repo_relative("src/../../etc/passwd").is_err());
        assert!(repo_relative("/etc/passwd").is_err());
        #[cfg(windows)]
        {
            assert!(repo_relative("C:/Windows/win.ini").is_err());
            assert!(repo_relative("//server/share/x").is_err());
        }
    }

    fn mk(base: &Path, rel: &str) {
        fs::create_dir_all(base.join(rel)).unwrap();
    }

    #[test]
    fn finds_nested_repos_and_respects_skips() {
        let base = std::env::temp_dir().join(format!("boite-scan-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        mk(&base, "app/.git");
        mk(&base, "app/sub/.git"); // inside a found repo: not descended into
        mk(&base, "group/lib/.git");
        mk(&base, "node_modules/dep/.git"); // skip list
        mk(&base, ".hidden/repo/.git"); // hidden dir
        mk(&base, "a/b/c/deep/.git"); // level 4, beyond max_depth 3
        mk(&base, "worktree");
        fs::write(base.join("worktree/.git"), "gitdir: ../app/.git/worktrees/x").unwrap();

        let found = find_repos_blocking(base.to_str().unwrap(), 3).unwrap();
        let mut rels: Vec<String> = found
            .iter()
            .map(|p| {
                p.trim_start_matches(base.to_str().unwrap())
                    .trim_start_matches(['/', '\\'])
                    .replace('\\', "/")
            })
            .collect();
        rels.sort();
        assert_eq!(rels, vec!["app", "group/lib", "worktree"]);

        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod branch_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRepo {
        path: PathBuf,
    }

    impl TestRepo {
        fn new() -> Self {
            // A clock alone is not enough to make this unique. macOS reports
            // microseconds through the nanosecond API, so two of these threads
            // starting in the same microsecond built the same path, ran
            // `git init` into it at once, and one of them died copying a
            // template hook that the other had just written. The counter makes
            // the name unique whatever the clock's resolution.
            static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "boite-git-branch-test-{}-{nonce}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            run_git(&path, &["init", "--quiet"]);
            run_git(&path, &["config", "user.name", "Boite Test"]);
            run_git(&path, &["config", "user.email", "boite@example.test"]);
            run_git(&path, &["branch", "-M", "master"]);
            fs::write(path.join("tracked.txt"), "initial\n").unwrap();
            run_git(&path, &["add", "tracked.txt"]);
            run_git(&path, &["commit", "--quiet", "-m", "initial"]);
            Self { path }
        }

        fn path(&self) -> &str {
            self.path.to_str().unwrap()
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn run_git(path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Both messages are what `gh` 2.x actually prints, captured from it rather
    /// than written from memory.
    #[test]
    fn gh_refusals_are_told_apart() {
        let signed_out = classify_gh_failure(
            Some(4),
            "To get started with GitHub CLI, please run:  gh auth login\n\
             Alternatively, populate the GH_TOKEN environment variable…",
        );
        match signed_out {
            PrLookup::Failed { auth, ref detail } => {
                assert!(auth, "exit 4 is the case the user can act on");
                assert!(detail.contains("gh auth login"));
            }
            _ => panic!("a signed-out gh has something to say"),
        }

        // Not GitHub at all: nothing to report and nothing to fix, so it reads
        // like a machine with no gh on it.
        let elsewhere = classify_gh_failure(
            Some(1),
            "none of the git remotes configured for this repository point to a \
             known GitHub host. To tell gh about a new GitHub host, please use \
             `gh auth login`",
        );
        assert!(matches!(elsewhere, PrLookup::Unavailable));

        // Anything else is passed on as-is rather than guessed at.
        let other = classify_gh_failure(Some(1), "");
        match other {
            PrLookup::Failed { auth, ref detail } => {
                assert!(!auth);
                assert_eq!(detail, "gh exited with 1");
            }
            _ => panic!("an unexplained failure is still a failure"),
        }
    }

    /// The whole point of resolving the sha rather than displaying it: an agent
    /// that reports a commit nobody made must not read as one that made it.
    #[test]
    fn a_sha_the_repository_never_saw_is_unknown() {
        let repo = TestRepo::new();
        let state = commit_state_blocking(repo.path(), "0123456789abcdef0123456789abcdef01234567");
        assert!(!state.known);
        assert!(!state.pushed);

        // Not a sha at all, and the `--`-shaped case an argument parser would
        // take for its own flag.
        for bogus in ["", "HEAD", "--all", "zzzzzzz"] {
            assert!(!commit_state_blocking(repo.path(), bogus).known, "{bogus}");
        }
    }

    #[test]
    fn a_real_commit_carries_its_subject_and_branch() {
        let repo = TestRepo::new();
        let sha = run_git(&repo.path, &["rev-parse", "HEAD"]);
        let state = commit_state_blocking(repo.path(), &sha);
        assert!(state.known);
        assert_eq!(state.short, sha[..7]);
        assert_eq!(state.subject.as_deref(), Some("initial"));
        assert_eq!(state.branch.as_deref(), Some("master"));
        // Nothing has been pushed anywhere: no remote exists.
        assert!(!state.pushed);
    }

    /// "Pushed" has to mean the commit is on a remote-tracking branch. A local
    /// branch being ahead says nothing about where its commits are.
    #[test]
    fn pushed_follows_the_remote_not_the_local_branch() {
        let repo = TestRepo::new();
        let bare = repo.path.with_extension("remote.git");
        run_git(&repo.path, &["init", "--bare", "--quiet", bare.to_str().unwrap()]);
        run_git(&repo.path, &["remote", "add", "origin", bare.to_str().unwrap()]);
        run_git(&repo.path, &["push", "--quiet", "-u", "origin", "master"]);

        let pushed = run_git(&repo.path, &["rev-parse", "HEAD"]);
        assert!(commit_state_blocking(repo.path(), &pushed).pushed);

        fs::write(repo.path.join("tracked.txt"), "more\n").unwrap();
        run_git(&repo.path, &["commit", "--quiet", "-am", "local only"]);
        let local = run_git(&repo.path, &["rev-parse", "HEAD"]);
        let state = commit_state_blocking(repo.path(), &local);
        assert!(state.known);
        assert!(!state.pushed, "a commit that never left must not read as pushed");

        let _ = fs::remove_dir_all(&bare);
    }

    /// Work pushed from a branch this clone no longer has still belongs to that
    /// branch, and its name is the only way to ask about a pull request.
    #[test]
    fn a_branch_name_survives_the_local_branch_going_away() {
        let repo = TestRepo::new();
        let bare = repo.path.with_extension("remote2.git");
        run_git(&repo.path, &["init", "--bare", "--quiet", bare.to_str().unwrap()]);
        run_git(&repo.path, &["remote", "add", "origin", bare.to_str().unwrap()]);
        run_git(&repo.path, &["checkout", "--quiet", "-b", "feature/gone"]);
        fs::write(repo.path.join("tracked.txt"), "work\n").unwrap();
        run_git(&repo.path, &["commit", "--quiet", "-am", "the work"]);
        run_git(&repo.path, &["push", "--quiet", "origin", "feature/gone"]);
        let sha = run_git(&repo.path, &["rev-parse", "HEAD"]);

        // Back to master and the local branch is deleted, exactly as it is after
        // a merged pull request is cleaned up.
        run_git(&repo.path, &["checkout", "--quiet", "master"]);
        run_git(&repo.path, &["branch", "-D", "feature/gone"]);

        let state = commit_state_blocking(repo.path(), &sha);
        assert!(state.pushed);
        assert_eq!(
            state.branch.as_deref(),
            Some("feature/gone"),
            "the remote ref carries the name, minus its remote"
        );

        let _ = fs::remove_dir_all(&bare);
    }

    #[test]
    fn creates_lists_and_carries_changes_between_branches() {
        let repo = TestRepo::new();
        switch_branch_blocking(repo.path(), "feature/test", true, false).unwrap();
        fs::write(repo.path.join("tracked.txt"), "modified\n").unwrap();

        let result = switch_branch_blocking(repo.path(), "master", false, false).unwrap();
        assert!(!result.stashed);
        assert_eq!(symbolic_branch(&repo.path).as_deref(), Some("master"));
        assert_eq!(fs::read_to_string(repo.path.join("tracked.txt")).unwrap(), "modified\n");

        let branches = branches_blocking(repo.path()).unwrap();
        assert!(branches.iter().any(|b| b.name == "feature/test"));
        assert!(branches.iter().any(|b| b.name == "master" && b.current));
    }

    #[test]
    fn stashes_tracked_and_untracked_changes_before_switching() {
        let repo = TestRepo::new();
        switch_branch_blocking(repo.path(), "feature/test", true, false).unwrap();
        fs::write(repo.path.join("tracked.txt"), "modified\n").unwrap();
        fs::write(repo.path.join("untracked.txt"), "new\n").unwrap();

        let result = switch_branch_blocking(repo.path(), "master", false, true).unwrap();
        assert!(result.stashed);
        assert_eq!(symbolic_branch(&repo.path).as_deref(), Some("master"));
        assert_eq!(run_git(&repo.path, &["status", "--porcelain"]), "");
        assert!(!run_git(&repo.path, &["stash", "list"]).is_empty());
    }

    #[test]
    fn rejects_invalid_and_duplicate_branch_names() {
        let repo = TestRepo::new();
        assert!(switch_branch_blocking(repo.path(), "bad:name", true, false).is_err());
        assert!(switch_branch_blocking(repo.path(), "master", true, false).is_err());
        // `--help` is the dangerous one: git would treat it as an option, print
        // help, exit 0, and leave us reporting a success with no branch made.
        assert!(switch_branch_blocking(repo.path(), "--help", true, false).is_err());
        assert_eq!(symbolic_branch(&repo.path).as_deref(), Some("master"));
    }
}


