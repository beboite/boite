use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Serialize)]
pub struct RepoInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
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
    pub refs: Vec<String>,
}

fn git(path: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(path);
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
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
    }
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<Vec<ChangeEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || status_blocking(&path))
        .await
        .map_err(|e| format!("git_status task failed: {e}"))?
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
        "--untracked-files=all",
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
    let mut cmd = git(p);
    cmd.args([
        "log",
        "--branches",
        "--tags",
        "--remotes",
        "HEAD",
        "--topo-order",
        "--date-order",
        &format!("-n{}", limit),
        &format!("--skip={}", skip),
        "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e",
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
        let mut fields = trimmed.split('\u{1f}');
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
        commits.push(Commit {
            sha,
            short_sha,
            parents,
            author,
            email,
            time,
            summary,
            refs,
        });
    }
    Ok(commits)
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
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || commit_blocking(&path, &message))
        .await
        .map_err(|e| format!("git_commit task failed: {e}"))?
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
