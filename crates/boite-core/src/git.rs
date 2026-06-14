use std::collections::HashSet;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
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

fn git(path: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(path);
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    // Never block on an interactive credential/auth prompt: fail fast instead
    // of hanging a background fetch forever.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");
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

    let mut info = RepoInfo {
        is_repo: true,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        refs_version: refs_version(p),
        commit_count: commit_count(p),
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

    let (head, head_binary) = git_show(p, &format!("HEAD:{}", head_rel));
    let (index, index_binary) = git_show(p, &format!(":{}", rel));

    let abs = p.join(&rel);
    let mut work_binary = false;
    let work = match fs::metadata(&abs) {
        Ok(meta) if meta.is_file() => match fs::read(&abs) {
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
