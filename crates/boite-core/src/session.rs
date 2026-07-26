use std::collections::HashSet;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionHit {
    pub id: String,
    pub modified_ms: i64,
}

#[derive(Deserialize)]
struct ClaudeSessionLine {
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    cwd: Option<String>,
    #[serde(alias = "workingDirectory", alias = "working_directory")]
    working_dir: Option<String>,
}

/// What the head of a session transcript tells us about it.
struct ClaudeSessionMeta {
    session_id: Option<String>,
    cwd: Option<String>,
}

/// One entry of `~/.claude/sessions/<pid>.json`, the registry Claude keeps of
/// the sessions it currently has open.
#[derive(Deserialize)]
struct LiveSessionEntry {
    pid: Option<u32>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    kind: Option<String>,
    status: Option<String>,
}

/// A session claude has open. The kind decides what can be done about it: a
/// background one is reachable through the agent view, an interactive one
/// belongs to another terminal and cannot be joined at all.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LiveClaudeSession {
    pub id: String,
    #[serde(skip)]
    pub pid: u32,
    /// `bg` or `interactive`, straight from the registry.
    pub kind: String,
    /// `busy` while a turn is in flight, `idle` otherwise. An idle agent can be
    /// released without losing anything; a busy one is mid-answer.
    pub status: String,
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // Signal 0 checks for existence without delivering anything. EPERM means
    // the process is there but owned by someone else, which is still alive.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(unix)]
fn terminate(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) == 0 }
}

#[cfg(windows)]
fn terminate(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let ok = TerminateProcess(handle, 0) != 0;
        CloseHandle(handle);
        ok
    }
}

/// Releases a session claude is holding as a background agent, so `--resume`
/// works on it again.
///
/// Only ever a background agent: an interactive entry is someone's open
/// terminal, and killing it would take their session with it. Refusing that is
/// not a policy this should leave to the caller.
///
/// SIGTERM rather than SIGKILL — the process gets to release its claim and
/// flush its transcript. The transcript is on disk continuously either way, so
/// nothing said is lost; what ends is the turn in flight, if any.
///
/// Returns only once the process is actually gone. Signalling returns straight
/// away while the exit takes a moment, and a caller that relaunched on that
/// answer would ask about liveness while the registry still listed the session
/// — deciding to open the agent picker for an agent it had just stopped.
pub fn stop_claude_session(session_id: &str) -> bool {
    let Some(target) = live_claude_sessions()
        .into_iter()
        .find(|s| s.id == session_id && s.kind == "bg")
    else {
        return false;
    };
    if !terminate(target.pid) {
        return false;
    }
    // Bounded: a process that ignores the signal must not hold the caller. The
    // false it then gets means "still held", which routes back to the picker —
    // the behaviour from before, rather than a hang.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if !pid_alive(target.pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    false
}

pub fn live_claude_session_ids() -> HashSet<String> {
    live_claude_sessions().into_iter().map(|s| s.id).collect()
}

/// Sessions Claude has open right now, whatever kind they are.
///
/// `--resume` refuses any of these: "That session is still running as a
/// background agent. Open `claude agents` to attach to it, or stop it there
/// first to resume here." The same refusal applies to an interactive session
/// already open in another terminal, so the rule is liveness rather than the
/// kind of session — a background agent that has stopped is resumable again,
/// and must not stay hidden.
///
/// The pid is verified rather than trusted: a claude that died without
/// cleaning up would otherwise leave an entry that hides a conversation
/// forever, which is the very failure this is meant to prevent.
pub fn live_claude_sessions() -> Vec<LiveClaudeSession> {
    let mut live = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return live;
    };
    let Ok(entries) = fs::read_dir(home.join(".claude").join("sessions")) else {
        return live;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension() != Some(OsStr::new("json")) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<LiveSessionEntry>(&text) else {
            continue;
        };
        let (Some(pid), Some(id)) = (parsed.pid, parsed.session_id) else {
            continue;
        };
        if pid_alive(pid) {
            live.push(LiveClaudeSession {
                id,
                pid,
                kind: parsed.kind.unwrap_or_else(|| "interactive".into()),
                status: parsed.status.unwrap_or_else(|| "busy".into()),
            });
        }
    }
    live
}

fn normalize(p: &str) -> String {
    p.replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn encode_claude_project_dir(p: &str) -> String {
    p.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .to_lowercase()
}

fn ms_since_epoch(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn collect_files(root: &Path, out: &mut Vec<(PathBuf, i64)>, depth: usize, max_depth: usize) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_files(&entry.path(), out, depth + 1, max_depth);
        } else if file_type.is_file() {
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(modified) = meta.modified() else { continue };
            out.push((entry.path(), ms_since_epoch(modified)));
        }
    }
}

fn read_claude_session_meta(path: &Path) -> Option<ClaudeSessionMeta> {
    // Buffered: session jsonl files reach tens of MB; only the head matters.
    let reader = BufReader::new(fs::File::open(path).ok()?);
    let mut found_session: Option<String> = None;
    let mut found_cwd: Option<String> = None;
    for line in reader.lines().map_while(Result::ok).take(80) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<ClaudeSessionLine>(trimmed) else {
            continue;
        };
        if found_session.is_none() {
            found_session = parsed.session_id;
        }
        if found_cwd.is_none() {
            found_cwd = parsed.cwd.or(parsed.working_dir);
        }
        if found_session.is_some() && found_cwd.is_some() {
            break;
        }
    }
    Some(ClaudeSessionMeta {
        session_id: found_session,
        cwd: found_cwd,
    })
}

pub fn find_claude_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<ClaudeSessionHit> {
    let home = dirs::home_dir()?;
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.is_dir() {
        return None;
    }

    let target_cwd = normalize(&cwd);
    let target_encoded = encode_claude_project_dir(&target_cwd);

    struct Candidate {
        path: PathBuf,
        modified_ms: i64,
        dir_name_lower: String,
    }
    let mut candidates: Vec<Candidate> = Vec::new();

    let project_entries = fs::read_dir(&projects_dir).ok()?;
    for project_entry in project_entries.flatten() {
        let Ok(file_type) = project_entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let dir_name_lower = project_entry
            .file_name()
            .to_string_lossy()
            .to_lowercase();
        let session_entries = match fs::read_dir(project_entry.path()) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for session_entry in session_entries.flatten() {
            let path = session_entry.path();
            if path.extension() != Some(OsStr::new("jsonl")) {
                continue;
            }
            let Ok(meta) = session_entry.metadata() else {
                continue;
            };
            let Ok(modified) = meta.modified() else {
                continue;
            };
            let modified_ms = ms_since_epoch(modified);
            if modified_ms < after_unix_ms {
                continue;
            }
            candidates.push(Candidate {
                path,
                modified_ms,
                dir_name_lower: dir_name_lower.clone(),
            });
        }
    }

    candidates.sort_by_key(|c| std::cmp::Reverse(c.modified_ms));

    // Read once, not per candidate: the registry is a handful of small files,
    // but the candidate list is every transcript on the machine.
    let live = live_claude_session_ids();

    for cand in candidates {
        // Exact match only. A substring test let short project dir names
        // match unrelated cwds, attaching the wrong session to a thread; the
        // cwd read from the jsonl below remains the robust fallback.
        let dir_matches = cand.dir_name_lower == target_encoded;

        let meta = read_claude_session_meta(&cand.path);
        let (session_id, session_cwd) = match meta {
            Some(m) => (m.session_id, m.cwd),
            None => (None, None),
        };

        let cwd_matches = session_cwd
            .as_deref()
            .map(|c| normalize(c) == target_cwd)
            .unwrap_or(false);

        if !cwd_matches && !dir_matches {
            continue;
        }

        if let Some(id) = session_id {
            if exclude.contains(&id) || live.contains(&id) {
                continue;
            }
            return Some(ClaudeSessionHit {
                id,
                modified_ms: cand.modified_ms,
            });
        }
        if let Some(stem) = cand.path.file_stem().and_then(|s| s.to_str()) {
            if exclude.contains(stem) || live.contains(stem) {
                continue;
            }
            return Some(ClaudeSessionHit {
                id: stem.to_string(),
                modified_ms: cand.modified_ms,
            });
        }
    }

    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionHit {
    pub id: String,
    pub modified_ms: i64,
    /// First real user prompt, used as the thread title: codex never emits a
    /// conversation summary in its OSC title (only spinner/project/model/...).
    pub title: Option<String>,
}

#[derive(Deserialize)]
struct CodexSessionMeta {
    payload: Option<CodexPayload>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct CodexPayload {
    id: Option<String>,
    cwd: Option<String>,
}

// Injected user-role messages that precede (or interleave with) the real
// prompt in codex rollout files.
const CODEX_PROMPT_SKIP_PREFIXES: &[&str] = &[
    "# AGENTS.md instructions",
    "<environment_context",
    "<permissions",
    "<user_instructions",
    "<turn_context",
    "<INSTRUCTIONS",
];

const CODEX_TITLE_MAX_CHARS: usize = 60;

fn codex_title_from_prompt(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if CODEX_PROMPT_SKIP_PREFIXES
        .iter()
        .any(|p| trimmed.starts_with(p))
    {
        return None;
    }
    let first_line = trimmed.lines().next()?.trim();
    if first_line.is_empty() {
        return None;
    }
    let mut title: String = first_line.chars().take(CODEX_TITLE_MAX_CHARS).collect();
    if first_line.chars().count() > CODEX_TITLE_MAX_CHARS {
        title.push('…');
    }
    Some(title)
}

fn read_codex_first_prompt(path: &Path) -> Option<String> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    for line in reader.lines().map_while(Result::ok).take(400) {
        if !line.contains("\"role\":\"user\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
            continue;
        }
        let Some(payload) = v.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(|t| t.as_str()) != Some("message")
            || payload.get("role").and_then(|r| r.as_str()) != Some("user")
        {
            continue;
        }
        let Some(content) = payload.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        for item in content {
            if item.get("type").and_then(|t| t.as_str()) != Some("input_text") {
                continue;
            }
            let Some(text) = item.get("text").and_then(|t| t.as_str()) else {
                continue;
            };
            if let Some(title) = codex_title_from_prompt(text) {
                return Some(title);
            }
        }
    }
    None
}

fn read_codex_session_meta(path: &Path) -> Option<(String, String)> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    let first = reader
        .lines()
        .map_while(Result::ok)
        .take(10)
        .find(|l| !l.trim().is_empty())?;
    let meta: CodexSessionMeta = serde_json::from_str(&first).ok()?;
    if meta.kind.as_deref() != Some("session_meta") {
        return None;
    }
    let payload = meta.payload?;
    Some((payload.id?, payload.cwd?))
}

pub fn find_codex_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<CodexSessionHit> {
    let home = dirs::home_dir()?;
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.is_dir() {
        return None;
    }

    let target = normalize(&cwd);
    let mut files: Vec<(PathBuf, i64)> = Vec::new();
    collect_files(&sessions_dir, &mut files, 0, 6);
    files.retain(|(p, t)| {
        *t >= after_unix_ms && p.extension() == Some(OsStr::new("jsonl"))
    });
    files.sort_by_key(|(_, t)| std::cmp::Reverse(*t));

    for (path, modified_ms) in files {
        if let Some((id, scwd)) = read_codex_session_meta(&path) {
            if normalize(&scwd) == target && !exclude.contains(&id) {
                let title = read_codex_first_prompt(&path);
                return Some(CodexSessionHit {
                    id,
                    modified_ms,
                    title,
                });
            }
        }
    }
    None
}

fn open_readonly(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
}

fn opencode_db_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(data_home) = env::var("XDG_DATA_HOME") {
        if !data_home.trim().is_empty() {
            candidates.push(PathBuf::from(data_home).join("opencode").join("opencode.db"));
        }
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db"),
        );
    }

    if let Some(base) = dirs::data_dir() {
        candidates.push(base.join("opencode").join("opencode.db"));
    }

    if let Some(base) = dirs::data_local_dir() {
        candidates.push(base.join("opencode").join("opencode.db"));
    }

    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .or_else(|| candidates.into_iter().next())
}

fn find_opencode_session_by_activity(
    conn: &Connection,
    target: &str,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.directory, \
                    max( \
                        coalesce(s.time_updated, 0), \
                        coalesce(s.time_created, 0), \
                        coalesce((SELECT max(m.time_updated) FROM message m WHERE m.session_id = s.id), 0), \
                        coalesce((SELECT max(p.time_updated) FROM part p WHERE p.session_id = s.id), 0), \
                        coalesce((SELECT max(se.time_updated) FROM session_entry se WHERE se.session_id = s.id), 0) \
                    ) AS activity \
             FROM session s \
             ORDER BY activity DESC \
             LIMIT 100",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, i64>(2)?,
            ))
        })
        .ok()?;

    for row in rows.flatten() {
        let (id, directory, activity_ms) = row;
        if activity_ms >= after_unix_ms
            && normalize(&directory) == target
            && !exclude.contains(&id)
        {
            return Some(id);
        }
    }
    None
}

fn find_opencode_session_by_created(
    conn: &Connection,
    target: &str,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, directory, time_created \
             FROM session \
             WHERE time_created >= ? \
             ORDER BY time_created DESC \
             LIMIT 50",
        )
        .ok()?;
    let rows = stmt
        .query_map([after_unix_ms], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })
        .ok()?;

    for row in rows.flatten() {
        let (id, directory) = row;
        if normalize(&directory) == target && !exclude.contains(&id) {
            return Some(id);
        }
    }
    None
}

pub fn find_opencode_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<String> {
    let db_path = opencode_db_path()?;
    if !db_path.is_file() {
        return None;
    }

    let conn = open_readonly(&db_path).ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(250));
    let target = normalize(&cwd);

    find_opencode_session_by_activity(&conn, &target, after_unix_ms, exclude)
        .or_else(|| find_opencode_session_by_created(&conn, &target, after_unix_ms, exclude))
        .or_else(|| find_opencode_session_by_activity(&conn, &target, 0, exclude))
}

fn copilot_db_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let base = dirs::data_dir()?;
        Some(base.join("GitHub Copilot").join("session-store.db"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = dirs::home_dir()?;
        Some(home.join(".copilot").join("session-store.db"))
    }
}

pub fn find_copilot_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<String> {
    let db_path = copilot_db_path()?;
    if !db_path.is_file() {
        return None;
    }

    let conn = open_readonly(&db_path).ok()?;
    let target = normalize(&cwd);

    let mut stmt = conn
        .prepare(
            "SELECT id, cwd, created_at \
             FROM sessions \
             ORDER BY datetime(created_at) DESC \
             LIMIT 50",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, String>(2)?,
            ))
        })
        .ok()?;

    for row in rows.flatten() {
        let (id, scwd, created_at) = row;
        if normalize(&scwd) != target {
            continue;
        }
        if let Some(ts) = parse_iso_ms(&created_at) {
            if ts < after_unix_ms {
                continue;
            }
        }
        if exclude.contains(&id) {
            continue;
        }
        return Some(id);
    }
    None
}

fn parse_offset_minutes(s: &str) -> Option<i64> {
    let sign = match s.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let rest = &s[1..];
    let (h, m) = match rest.split_once(':') {
        Some((h, m)) => (h, m),
        None if rest.len() == 4 => rest.split_at(2),
        None => (rest, "0"),
    };
    let h: i64 = h.parse().ok()?;
    let m: i64 = m.parse().ok()?;
    Some(sign * (h * 60 + m))
}

fn parse_iso_ms(s: &str) -> Option<i64> {
    let trimmed = s.trim().trim_end_matches('Z');
    let (date_part, time_full) = trimmed.split_once('T').or_else(|| trimmed.split_once(' '))?;
    // Numeric offsets (+02:00, -0530) used to fail the segment-count check,
    // silently skipping the timestamp filter for Copilot sessions.
    let (time_part, offset_min) = match time_full.rfind(['+', '-']) {
        Some(idx) if idx > 0 => {
            let (t, off) = time_full.split_at(idx);
            (t, parse_offset_minutes(off).unwrap_or(0))
        }
        _ => (time_full, 0),
    };
    let date_segs: Vec<&str> = date_part.split('-').collect();
    let time_segs: Vec<&str> = time_part.split(':').collect();
    if date_segs.len() != 3 || time_segs.len() != 3 {
        return None;
    }
    let y: i64 = date_segs[0].parse().ok()?;
    let mo: i64 = date_segs[1].parse().ok()?;
    let d: i64 = date_segs[2].parse().ok()?;
    let h: i64 = time_segs[0].parse().ok()?;
    let mi: i64 = time_segs[1].parse().ok()?;
    let sec_part = time_segs[2];
    let (sec_str, frac_str) = sec_part.split_once('.').unwrap_or((sec_part, "0"));
    let s_v: i64 = sec_str.parse().ok()?;
    let frac_ms: i64 = {
        let mut f = String::from(frac_str);
        while f.len() < 3 {
            f.push('0');
        }
        f.truncate(3);
        f.parse().unwrap_or(0)
    };
    let days = days_since_epoch(y, mo, d)?;
    Some(((days * 86400 + h * 3600 + mi * 60 + s_v - offset_min * 60) * 1000) + frac_ms)
}

fn days_since_epoch(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let days_in_months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut days: i64 = 0;
    for year in 1970..y {
        days += if is_leap(year) { 366 } else { 365 };
    }
    for month in 1..m {
        days += days_in_months[(month - 1) as usize] as i64;
        if month == 2 && is_leap(y) {
            days += 1;
        }
    }
    days += d - 1;
    Some(days)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub fn find_cursor_session_blocking(
    _cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<String> {
    let home = dirs::home_dir()?;
    let chats_dir = home.join(".cursor").join("chats");
    if !chats_dir.is_dir() {
        return None;
    }

    let mut best: Option<(String, i64)> = None;
    let workspaces = fs::read_dir(&chats_dir).ok()?;
    for ws in workspaces.flatten() {
        let Ok(t) = ws.file_type() else { continue };
        if !t.is_dir() {
            continue;
        }
        let chats = match fs::read_dir(ws.path()) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for chat in chats.flatten() {
            let Ok(t) = chat.file_type() else { continue };
            if !t.is_dir() {
                continue;
            }
            let store = chat.path().join("store.db");
            let Ok(meta) = fs::metadata(&store) else {
                continue;
            };
            let Ok(modified) = meta.modified() else {
                continue;
            };
            let mtime = ms_since_epoch(modified);
            if mtime < after_unix_ms {
                continue;
            }
            let chat_id = chat.file_name().to_string_lossy().into_owned();
            if exclude.contains(&chat_id) {
                continue;
            }
            if best.as_ref().is_none_or(|(_, t)| mtime > *t) {
                best = Some((chat_id, mtime));
            }
        }
    }
    best.map(|(id, _)| id)
}

pub fn find_antigravity_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<String> {
    let home = dirs::home_dir()?;
    let cli_dir = home.join(".gemini").join("antigravity-cli");
    let cache_file = cli_dir.join("cache").join("last_conversations.json");
    let brain_dir = cli_dir.join("brain");

    let content = fs::read_to_string(&cache_file).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    let map = parsed.as_object()?;

    let target = normalize(&cwd);
    for (key, val) in map {
        if normalize(key) != target {
            continue;
        }
        let Some(id) = val.as_str() else { continue };
        if exclude.contains(id) {
            continue;
        }
        let brain = brain_dir.join(id);
        let mtime = brain
            .metadata()
            .and_then(|m| m.modified())
            .map(ms_since_epoch)
            .unwrap_or(0);
        if mtime < after_unix_ms {
            continue;
        }
        return Some(id.to_string());
    }
    None
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn grok_sessions_dir() -> Option<PathBuf> {
    if let Ok(home) = env::var("GROK_HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home).join("sessions"));
        }
    }
    Some(dirs::home_dir()?.join(".grok").join("sessions"))
}

/// Grok stores sessions under ~/.grok/sessions/<url-encoded-cwd>/<uuid7>/
/// (summary.json + updates.jsonl per session). Long cwds get a slug+hash dir
/// name with the real path in a `.cwd` file inside.
pub fn find_grok_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<String> {
    let sessions_dir = grok_sessions_dir()?;
    if !sessions_dir.is_dir() {
        return None;
    }

    let target = normalize(&cwd);
    let mut best: Option<(String, i64)> = None;

    for cwd_entry in fs::read_dir(&sessions_dir).ok()?.flatten() {
        let Ok(t) = cwd_entry.file_type() else { continue };
        if !t.is_dir() {
            continue;
        }
        let dir_name = cwd_entry.file_name().to_string_lossy().into_owned();
        let decoded_matches = normalize(&percent_decode(&dir_name)) == target;
        let cwd_file_matches = || {
            fs::read_to_string(cwd_entry.path().join(".cwd"))
                .map(|c| normalize(c.trim()) == target)
                .unwrap_or(false)
        };
        if !decoded_matches && !cwd_file_matches() {
            continue;
        }

        let Ok(sessions) = fs::read_dir(cwd_entry.path()) else {
            continue;
        };
        for session in sessions.flatten() {
            let Ok(t) = session.file_type() else { continue };
            if !t.is_dir() {
                continue;
            }
            let id = session.file_name().to_string_lossy().into_owned();
            if exclude.contains(&id) {
                continue;
            }
            let summary = session.path().join("summary.json");
            let mtime = fs::metadata(&summary)
                .or_else(|_| session.path().metadata())
                .and_then(|m| m.modified())
                .map(ms_since_epoch)
                .unwrap_or(0);
            if mtime < after_unix_ms {
                continue;
            }
            if best.as_ref().is_none_or(|(_, t)| mtime > *t) {
                best = Some((id, mtime));
            }
        }
    }
    best.map(|(id, _)| id)
}

fn hermes_db_path() -> Option<PathBuf> {
    if let Ok(home) = env::var("HERMES_HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home).join("state.db"));
        }
    }
    Some(dirs::home_dir()?.join(".hermes").join("state.db"))
}

fn hermes_ts_to_ms(v: rusqlite::types::Value) -> Option<i64> {
    use rusqlite::types::Value;
    // The sessions table's timestamp column type is not pinned upstream;
    // accept epoch seconds, epoch millis, or ISO text.
    let from_num = |n: i64| {
        if n < 100_000_000_000 {
            n * 1000
        } else {
            n
        }
    };
    match v {
        Value::Integer(i) => Some(from_num(i)),
        Value::Real(f) => Some(from_num(f as i64)),
        Value::Text(s) => parse_iso_ms(&s)
            .or_else(|| s.parse::<f64>().ok().map(|f| from_num(f as i64))),
        _ => None,
    }
}

/// Hermes keeps every session in a single SQLite db (~/.hermes/state.db);
/// the sessions table carries the cwd, so matching is a direct query.
pub fn find_hermes_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<String> {
    let db_path = hermes_db_path()?;
    if !db_path.is_file() {
        return None;
    }

    let conn = open_readonly(&db_path).ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(250));
    let target = normalize(&cwd);

    let mut stmt = conn
        .prepare(
            "SELECT id, cwd, started_at, ended_at \
             FROM sessions \
             ORDER BY started_at DESC \
             LIMIT 100",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, rusqlite::types::Value>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, rusqlite::types::Value>(2)?,
                row.get::<_, rusqlite::types::Value>(3)?,
            ))
        })
        .ok()?;

    for row in rows.flatten() {
        let (id_val, scwd, started, ended) = row;
        if normalize(&scwd) != target {
            continue;
        }
        let id = match id_val {
            rusqlite::types::Value::Text(s) => s,
            rusqlite::types::Value::Integer(i) => i.to_string(),
            _ => continue,
        };
        if exclude.contains(&id) {
            continue;
        }
        // Last activity: a resumed session keeps its old started_at, so take
        // the later of start/end. Unparseable timestamps skip the filter.
        let activity = hermes_ts_to_ms(started)
            .into_iter()
            .chain(hermes_ts_to_ms(ended))
            .max();
        if let Some(ts) = activity {
            if ts < after_unix_ms {
                continue;
            }
        }
        return Some(id);
    }
    None
}

pub fn build_exclude(ids: Option<Vec<String>>) -> HashSet<String> {
    ids.unwrap_or_default().into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Unique per process: a fixed path made these tests race any other run of
    /// the suite on the same machine — two `cargo test` invocations at once, or
    /// a leftover directory from a previous one — and fail intermittently for a
    /// reason that has nothing to do with what they check.
    fn write_session(name: &str, lines: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("boite-session-test-{}-{name}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.jsonl"));
        let mut f = fs::File::create(&path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        path
    }

    #[test]
    fn transcript_head_yields_the_id_and_the_cwd() {
        let path = write_session(
            "interactive",
            &[
                r#"{"type":"ai-title","aiTitle":"Some work","sessionId":"abc"}"#,
                r#"{"type":"user","cwd":"/Users/x/proj","sessionId":"abc"}"#,
            ],
        );
        let meta = read_claude_session_meta(&path).unwrap();
        assert_eq!(meta.session_id.as_deref(), Some("abc"));
        assert_eq!(meta.cwd.as_deref(), Some("/Users/x/proj"));
    }

    /// The liveness rule is only worth anything if a dead pid reads as dead:
    /// a registry entry left behind by a claude that crashed would otherwise
    /// hide that conversation from resume permanently.
    #[test]
    fn a_live_pid_is_told_from_a_dead_one() {
        assert!(pid_alive(std::process::id()));
        // Above any plausible live pid on the platforms we ship.
        assert!(!pid_alive(4_000_000_000));
    }
}
