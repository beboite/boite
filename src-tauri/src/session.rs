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

async fn run_lookup<F>(f: F) -> Option<String>
where
    F: FnOnce() -> Option<String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.ok().flatten()
}

#[derive(Deserialize)]
struct ClaudeSessionLine {
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    cwd: Option<String>,
    #[serde(alias = "workingDirectory", alias = "working_directory")]
    working_dir: Option<String>,
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

fn read_claude_session_meta(path: &Path) -> Option<(Option<String>, Option<String>)> {
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
    Some((found_session, found_cwd))
}

fn find_claude_session_blocking(
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

    for cand in candidates {
        // Exact match only. A substring test let short project dir names
        // match unrelated cwds, attaching the wrong session to a thread; the
        // cwd read from the jsonl below remains the robust fallback.
        let dir_matches = cand.dir_name_lower == target_encoded;

        let (session_id, session_cwd) =
            read_claude_session_meta(&cand.path).unwrap_or((None, None));

        let cwd_matches = session_cwd
            .as_deref()
            .map(|c| normalize(c) == target_cwd)
            .unwrap_or(false);

        if !cwd_matches && !dir_matches {
            continue;
        }

        if let Some(id) = session_id {
            if exclude.contains(&id) {
                continue;
            }
            return Some(ClaudeSessionHit {
                id,
                modified_ms: cand.modified_ms,
            });
        }
        if let Some(stem) = cand.path.file_stem().and_then(|s| s.to_str()) {
            if exclude.contains(stem) {
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

fn find_codex_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<String> {
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

    for (path, _) in files {
        if let Some((id, scwd)) = read_codex_session_meta(&path) {
            if normalize(&scwd) == target && !exclude.contains(&id) {
                return Some(id);
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

fn find_opencode_session_blocking(
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

fn find_copilot_session_blocking(
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

fn find_cursor_session_blocking(
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

fn find_antigravity_session_blocking(
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

fn build_exclude(ids: Option<Vec<String>>) -> HashSet<String> {
    ids.unwrap_or_default().into_iter().collect()
}

#[tauri::command]
pub async fn find_claude_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<ClaudeSessionHit> {
    let exclude = build_exclude(exclude_ids);
    tauri::async_runtime::spawn_blocking(move || {
        find_claude_session_blocking(cwd, after_unix_ms, &exclude)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn find_codex_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = build_exclude(exclude_ids);
    run_lookup(move || find_codex_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_opencode_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = build_exclude(exclude_ids);
    run_lookup(move || find_opencode_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_cursor_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = build_exclude(exclude_ids);
    run_lookup(move || find_cursor_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_antigravity_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = build_exclude(exclude_ids);
    run_lookup(move || find_antigravity_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_copilot_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = build_exclude(exclude_ids);
    run_lookup(move || find_copilot_session_blocking(cwd, after_unix_ms, &exclude)).await
}
