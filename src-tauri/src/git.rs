use std::collections::HashSet;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Serialize)]
pub struct RepoInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub refs_version: Option<String>,
}

#[derive(Serialize)]
pub struct ChangeEntry {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub conflicted: bool,
}

#[derive(Serialize)]
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

#[tauri::command]
pub async fn git_repo_info(path: String) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || repo_info_blocking(&path))
        .await
        .map_err(|e| format!("git_repo_info task failed: {e}"))?
}

fn repo_info_blocking(path: &str) -> Result<RepoInfo, String> {
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
    }
}

fn refs_version(path: &Path) -> Option<String> {
    let mut hasher = DefaultHasher::new();
    let mut hashed = false;

    let mut head = git(path);
    head.args(["rev-parse", "--verify", "HEAD"]);
    if let Ok(stdout) = run(head) {
        stdout.hash(&mut hasher);
        hashed = true;
    }

    let mut refs = git(path);
    refs.args([
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    ]);
    if let Ok(stdout) = run(refs) {
        stdout.hash(&mut hasher);
        hashed = true;
    }

    if hashed {
        Some(format!("{:016x}", hasher.finish()))
    } else {
        None
    }
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<Vec<ChangeEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || status_blocking(&path))
        .await
        .map_err(|e| format!("git_status task failed: {e}"))?
}

#[derive(Serialize)]
pub struct PathStatus {
    pub path: String,
    pub status: String,
}

#[tauri::command]
pub async fn git_changed_paths(path: String) -> Result<Vec<PathStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || changed_paths_blocking(&path))
        .await
        .map_err(|e| format!("git_changed_paths task failed: {e}"))?
}

fn changed_paths_blocking(path: &str) -> Result<Vec<PathStatus>, String> {
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

fn status_blocking(path: &str) -> Result<Vec<ChangeEntry>, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Ok(Vec::new());
    }
    let mut cmd = git(p);
    cmd.args([
        "status",
        "--porcelain=v2",
        "--untracked-files=no",
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
                    push_xy(&mut out, xy, path);
                }
            }
            b'2' => {
                // 2 XY sub mH mI mW hH hI Xscore path\tOrig
                let mut parts = line.splitn(10, ' ');
                let _ = parts.next();
                let xy = parts.next().unwrap_or("..");
                for _ in 0..7 {
                    parts.next();
                }
                if let Some(rest) = parts.next() {
                    let path = rest.split('\t').next().unwrap_or(rest);
                    push_xy(&mut out, xy, path);
                }
                // skip the original-path NUL record
                let orig_end = bytes[i..]
                    .iter()
                    .position(|&b| b == 0)
                    .map(|n| i + n)
                    .unwrap_or(bytes.len());
                i = orig_end + 1;
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
                    });
                }
            }
            _ => {}
        }
    }
    out
}

fn push_xy(out: &mut Vec<ChangeEntry>, xy: &str, path: &str) {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    if x != '.' && x != ' ' {
        out.push(ChangeEntry {
            path: path.to_string(),
            status: x.to_string(),
            staged: true,
            conflicted: false,
        });
    }
    if y != '.' && y != ' ' {
        out.push(ChangeEntry {
            path: path.to_string(),
            status: y.to_string(),
            staged: false,
            conflicted: false,
        });
    }
}

#[tauri::command]
pub async fn git_log(
    path: String,
    limit: u32,
    skip: u32,
) -> Result<Vec<Commit>, String> {
    tauri::async_runtime::spawn_blocking(move || log_blocking(&path, limit, skip))
        .await
        .map_err(|e| format!("git_log task failed: {e}"))?
}

fn log_blocking(path: &str, limit: u32, skip: u32) -> Result<Vec<Commit>, String> {
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

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_files(&path, "add", &files, true))
        .await
        .map_err(|e| format!("git_stage task failed: {e}"))?
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || unstage_blocking(&path, files))
        .await
        .map_err(|e| format!("git_unstage task failed: {e}"))?
}

fn unstage_blocking(path: &str, files: Vec<String>) -> Result<(), String> {
    let p = Path::new(path);
    let mut cmd = git(p);
    cmd.args(["reset", "HEAD", "--"]);
    for f in &files {
        cmd.arg(f);
    }
    run(cmd).map(|_| ())
}

#[tauri::command]
pub async fn git_discard(path: String, files: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || discard_blocking(&path, files))
        .await
        .map_err(|e| format!("git_discard task failed: {e}"))?
}

fn discard_blocking(path: &str, files: Vec<String>) -> Result<(), String> {
    let p = Path::new(path);
    let mut cmd = git(p);
    cmd.args(["checkout", "HEAD", "--"]);
    for f in &files {
        cmd.arg(f);
    }
    run(cmd).map(|_| ())
}

fn run_files(path: &str, sub: &str, files: &[String], with_dashes: bool) -> Result<(), String> {
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

#[tauri::command]
pub async fn git_fetch(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || fetch_blocking(&path))
        .await
        .map_err(|e| format!("git_fetch task failed: {e}"))?
}

const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

fn fetch_blocking(path: &str) -> Result<(), String> {
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

// Like `run`, but kills the child if it outlives `timeout`. Used for fetch,
// the only git command that touches the network and can stall.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("git not found or failed to start: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let mut err = String::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut err);
                }
                let err = err.trim().to_string();
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
                    return Err("git fetch timed out".into());
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("git wait failed: {e}")),
        }
    }
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || commit_blocking(&path, &message))
        .await
        .map_err(|e| format!("git_commit task failed: {e}"))?
}

#[derive(Serialize)]
pub struct FileVersions {
    pub head: Option<String>,
    pub index: Option<String>,
    pub work: Option<String>,
    pub binary: bool,
}

#[tauri::command]
pub async fn git_file_versions(
    path: String,
    file: String,
) -> Result<FileVersions, String> {
    tauri::async_runtime::spawn_blocking(move || file_versions_blocking(&path, &file))
        .await
        .map_err(|e| format!("git_file_versions task failed: {e}"))?
}

fn file_versions_blocking(path: &str, file: &str) -> Result<FileVersions, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }
    let rel = file.replace('\\', "/");

    let head = git_show(p, &format!("HEAD:{}", rel));
    let index = git_show(p, &format!(":{}", rel));

    let abs = p.join(&rel);
    let work = match fs::metadata(&abs) {
        Ok(meta) if meta.is_file() => match fs::read(&abs) {
            Ok(bytes) => {
                if bytes_binary(&bytes) {
                    return Ok(FileVersions {
                        head,
                        index,
                        work: None,
                        binary: true,
                    });
                }
                Some(String::from_utf8_lossy(&bytes).into_owned())
            }
            Err(_) => None,
        },
        _ => None,
    };

    let binary = head.as_deref().is_some_and(|s| s.contains('\u{0}'))
        || index.as_deref().is_some_and(|s| s.contains('\u{0}'));

    Ok(FileVersions {
        head,
        index,
        work,
        binary,
    })
}

fn git_show(repo: &Path, spec: &str) -> Option<String> {
    let mut cmd = git(repo);
    cmd.args(["show", spec]);
    match cmd.output() {
        Ok(out) if out.status.success() => {
            if bytes_binary(&out.stdout) {
                None
            } else {
                Some(String::from_utf8_lossy(&out.stdout).into_owned())
            }
        }
        _ => None,
    }
}

fn bytes_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8192)];
    head.contains(&0u8)
}

fn commit_blocking(path: &str, message: &str) -> Result<String, String> {
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
