//! The six stores Boite can only read.
//!
//! Copilot, cursor, antigravity, grok, hermes and pi. Grouped because they are
//! the same shape of answer: open whatever the editor keeps, find the newest
//! session recorded for this directory, hand back an id and when it was last
//! touched. None of them says whether a turn is in flight, so none of them
//! contributes to the sidebar's activity dot.
//!
//! Four are sqlite and two are directories of files, and that is the whole
//! variation. What differs beyond it is where the store lives per platform,
//! which is the first function in each pair.

use super::*;

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
) -> Option<SessionHit> {
    let db_path = copilot_db_path()?;
    if !db_path.is_file() {
        return None;
    }

    let conn = open_readonly(&db_path).ok()?;
    find_copilot_session_in(&conn, &normalize(&cwd), after_unix_ms, exclude)
}

/// Whether copilot would take this id back. False only when the store is
/// readable and says the session holds nothing: every other answer is "yes",
/// because a launch must not be held back by a question we could not put.
///
/// This exists for ids captured before the store was asked for turns. They are
/// already saved on threads, and each relaunch replays one and gets refused.
pub fn copilot_session_resumable(session_id: &str) -> bool {
    let Some(db_path) = copilot_db_path() else {
        return true;
    };
    if !db_path.is_file() {
        return true;
    }
    let Ok(conn) = open_readonly(&db_path) else {
        return true;
    };
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM turns WHERE session_id = ?1)",
        [session_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|found| found == 1)
    .unwrap_or(true)
}

/// The query itself, over an open connection, so a fixture can exercise it.
fn find_copilot_session_in(
    conn: &Connection,
    target: &str,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
    // A row appears the moment copilot starts, before a word is exchanged, and
    // it refuses to resume one of those: "No session, task, or name matched
    // '<uuid>'". Capturing it anyway is worse than capturing nothing — the id
    // is replayed at every relaunch and fails every time, while the real
    // conversation sits one row away. A turn is the first thing there is to
    // come back to, so it is what makes a session worth remembering.
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.cwd, s.created_at \
             FROM sessions s \
             WHERE EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id) \
             ORDER BY datetime(s.created_at) DESC \
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
        // Unparseable timestamps skip the filter rather than the row, as they
        // always have, and travel out as "unknown".
        let ts = parse_iso_ms(&created_at);
        if let Some(ts) = ts {
            if ts < after_unix_ms {
                continue;
            }
        }
        if exclude.contains(&id) {
            continue;
        }
        return Some(SessionHit {
            id,
            modified_ms: ts,
        });
    }
    None
}

pub fn find_cursor_session_blocking(
    _cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
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
    // The mtime is the store.db's own, so it is always known here: a chat whose
    // metadata could not be read was skipped above.
    best.map(|(id, modified_ms)| SessionHit {
        id,
        modified_ms: Some(modified_ms),
    })
}

pub fn find_antigravity_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
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
            .ok();
        if mtime.unwrap_or(0) < after_unix_ms {
            continue;
        }
        return Some(SessionHit {
            id: id.to_string(),
            modified_ms: mtime,
        });
    }
    None
}

pub(super) fn grok_sessions_dir() -> Option<PathBuf> {
    if let Ok(home) = env::var("GROK_HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home).join("sessions"));
        }
    }
    Some(dirs::home_dir()?.join(".grok").join("sessions"))
}

/// The directory name grok builds for a working directory: the path as given,
/// trailing separators dropped, then percent-encoded the way a URL encodes a
/// path segment. Unreserved characters (`A-Z a-z 0-9 - _ . ~`) stay; everything
/// else becomes `%HH`. `D:\Dev\boite` is `D%3A%5CDev%5Cboite`.
///
/// Names longer than 255 bytes are a different shape (slug plus hash, real
/// path in `.cwd`). This function does not invent that shape: a name grok
/// would not look for is worse than no name. Callers that need an existing
/// long group ask [`grok_dir_for`].
pub(super) fn grok_dir_name(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches(['/', '\\']);
    let mut out = String::with_capacity(trimmed.len());
    for &b in trimmed.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push(
                    char::from_digit((b >> 4) as u32, 16)
                        .unwrap()
                        .to_ascii_uppercase(),
                );
                out.push(
                    char::from_digit((b & 0xf) as u32, 16)
                        .unwrap()
                        .to_ascii_uppercase(),
                );
            }
        }
    }
    out
}

fn grok_decoded_matches(dir_name: &str, target: &str) -> bool {
    normalize(&percent_decode(dir_name)) == target
}

/// The group directory grok uses for this cwd, when one already exists.
///
/// A link is an answer: a worktree's store is one, and migrate has to follow
/// it into the pool rather than report the conversation missing.
pub(super) fn grok_dir_for(root: &Path, cwd: &str) -> Option<PathBuf> {
    let want = grok_dir_name(cwd);
    if !want.is_empty() && want.len() <= 255 {
        let direct = root.join(&want);
        if fs::symlink_metadata(&direct).is_ok() {
            return Some(direct);
        }
    }
    let target = normalize(cwd);
    for entry in fs::read_dir(root).ok()?.flatten() {
        let Ok(t) = entry.file_type() else { continue };
        if !t.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if grok_decoded_matches(&name, &target) {
            return Some(entry.path());
        }
        if t.is_symlink() {
            // `.cwd` lives in the pool. Reading it through another
            // worktree's link would match the project path against every
            // sibling, and migrate would pick a random one.
            continue;
        }
        if fs::read_to_string(entry.path().join(".cwd"))
            .map(|c| normalize(c.trim()) == target)
            .unwrap_or(false)
        {
            return Some(entry.path());
        }
    }
    None
}

/// Name to give a worktree or pool group. Percent-encoded when that is what
/// grok will look for; an existing slug+hash group when the encoded name
/// would overflow 255 bytes. Empty when grok would use a slug we cannot
/// invent, so share stays silent rather than pointing at a name grok never
/// opens.
pub(super) fn grok_group_name(root: &Path, cwd: &str) -> String {
    let encoded = grok_dir_name(cwd);
    if encoded.len() <= 255 {
        return encoded;
    }
    grok_dir_for(root, cwd)
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default()
}

/// Grok stores sessions under ~/.grok/sessions/<url-encoded-cwd>/<uuid7>/
/// (summary.json + updates.jsonl per session). Long cwds get a slug+hash dir
/// name with the real path in a `.cwd` file inside.
pub fn find_grok_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
    let sessions_dir = grok_sessions_dir()?;
    if !sessions_dir.is_dir() {
        return None;
    }
    find_grok_session_in(&sessions_dir, &cwd, after_unix_ms, exclude)
}

fn find_grok_session_in(
    sessions_dir: &Path,
    cwd: &str,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
    let target = normalize(cwd);
    let mut best: Option<(String, Option<i64>)> = None;

    for cwd_entry in fs::read_dir(sessions_dir).ok()?.flatten() {
        let Ok(t) = cwd_entry.file_type() else {
            continue;
        };
        let dir_name = cwd_entry.file_name().to_string_lossy().into_owned();
        let decoded_matches = grok_decoded_matches(&dir_name, &target);
        if t.is_symlink() {
            // This thread's own worktree link: follow it. Another worktree's
            // link onto the same pool: skip. Matching on `.cwd` is not safe
            // here, because read follows the link and the pool's `.cwd` is
            // the project path, which would match every sibling.
            //
            // A Windows junction often reports `is_dir() == false`, so the
            // symlink check has to come first or we never open the one link
            // this thread is allowed to follow.
            if !decoded_matches {
                continue;
            }
        } else if !t.is_dir() {
            continue;
        } else if !decoded_matches {
            let cwd_file_matches = fs::read_to_string(cwd_entry.path().join(".cwd"))
                .map(|c| normalize(c.trim()) == target)
                .unwrap_or(false);
            if !cwd_file_matches {
                continue;
            }
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
            // Kept as an Option so an unreadable one stays "unknown" all the
            // way out; it still sorts and filters as 0, which is what it did
            // when the value was flattened here.
            let mtime = fs::metadata(&summary)
                .or_else(|_| session.path().metadata())
                .and_then(|m| m.modified())
                .map(ms_since_epoch)
                .ok();
            if mtime.unwrap_or(0) < after_unix_ms {
                continue;
            }
            if best
                .as_ref()
                .is_none_or(|(_, t)| mtime.unwrap_or(0) > t.unwrap_or(0))
            {
                best = Some((id, mtime));
            }
        }
    }
    best.map(|(id, modified_ms)| SessionHit { id, modified_ms })
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("cannot open the target folder: {e}"))?;
    let entries = fs::read_dir(from).map_err(|e| format!("cannot read the session: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read the session: {e}"))?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let ft = entry
            .file_type()
            .map_err(|e| format!("cannot read the session: {e}"))?;
        if ft.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("cannot copy the transcript: {e}"))?;
        }
    }
    Ok(())
}

/// Carries a grok session directory to the folder a thread is moving to.
///
/// Same rule as claude's, one shape down: grok files by encoded cwd, so a
/// thread that changes project changes the directory `--resume` looks in. The
/// session is a directory of files rather than one jsonl, copied under the
/// id it already has.
///
/// Answers reachability, not "did I copy something": `false` means replaying
/// the id over there would find nothing, and the thread should start fresh.
pub(super) fn migrate_grok_transcript(
    session_id: &str,
    from_cwd: &str,
    to_cwd: &str,
) -> Result<bool, String> {
    let Some(root) = grok_sessions_dir() else {
        return Ok(false);
    };
    migrate_grok_transcript_in(&root, session_id, from_cwd, to_cwd)
}

fn migrate_grok_transcript_in(
    root: &Path,
    session_id: &str,
    from_cwd: &str,
    to_cwd: &str,
) -> Result<bool, String> {
    if normalize(from_cwd) == normalize(to_cwd) {
        return Ok(true);
    }
    let source = grok_dir_for(root, from_cwd).map(|dir| dir.join(session_id));
    let target_dir = {
        let encoded = grok_dir_name(to_cwd);
        if !encoded.is_empty() && encoded.len() <= 255 {
            root.join(encoded)
        } else {
            match grok_dir_for(root, to_cwd) {
                Some(dir) => dir,
                None => {
                    return Ok(false);
                }
            }
        }
    };
    let Some(source) = source.filter(|p| p.is_dir()) else {
        return Ok(target_dir.join(session_id).is_dir());
    };
    let target = target_dir.join(session_id);
    // Already there: the same thread moved back, or two threads share a cwd.
    // Overwriting would replace a transcript with an older copy of itself.
    if target.is_dir() {
        return Ok(true);
    }
    copy_tree(&source, &target)?;
    Ok(true)
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
        Value::Text(s) => {
            parse_iso_ms(&s).or_else(|| s.parse::<f64>().ok().map(|f| from_num(f as i64)))
        }
        _ => None,
    }
}

/// Hermes keeps every session in a single SQLite db (~/.hermes/state.db);
/// the sessions table carries the cwd, so matching is a direct query.
pub fn find_hermes_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
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
        return Some(SessionHit {
            id,
            modified_ms: activity,
        });
    }
    None
}

/// Where pi files its sessions. Two overrides, in the order pi reads them:
/// `PI_CODING_AGENT_SESSION_DIR` replaces the directory outright (flat, no
/// per-project subdirectory), `PI_CODING_AGENT_DIR` moves the whole config tree
/// and keeps the layout. The bool says which of the two shapes came back.
pub(super) fn pi_sessions_root() -> Option<(PathBuf, bool)> {
    if let Ok(dir) = env::var("PI_CODING_AGENT_SESSION_DIR") {
        if !dir.trim().is_empty() {
            return Some((PathBuf::from(dir), true));
        }
    }
    if let Ok(dir) = env::var("PI_CODING_AGENT_DIR") {
        if !dir.trim().is_empty() {
            return Some((PathBuf::from(dir).join("sessions"), false));
        }
    }
    Some((
        dirs::home_dir()?.join(".pi").join("agent").join("sessions"),
        false,
    ))
}

/// The directory name pi builds for a working directory: one leading separator
/// dropped, then every `/`, `\` and `:` turned into `-`, wrapped in `--`. So
/// `D:\Dev\boite` is `--D--Dev-boite--`, the drive's colon and its separator
/// each contributing a dash.
pub(super) fn pi_dir_name(cwd: &str) -> String {
    let trimmed = cwd
        .strip_prefix('/')
        .or_else(|| cwd.strip_prefix('\\'))
        .unwrap_or(cwd);
    let body: String = trimmed
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' {
                '-'
            } else {
                c
            }
        })
        .collect();
    format!("--{body}--")
}

/// The `cwd` pi recorded on this session file, read off its header.
///
/// The header is the first line and carries `{"type":"session",…,"cwd":…}`, so
/// one line is read rather than a transcript that runs to megabytes.
fn pi_session_header(path: &Path) -> Option<(String, String)> {
    let file = fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let id = parsed.get("id")?.as_str()?.to_string();
    let cwd = parsed.get("cwd")?.as_str().unwrap_or_default().to_string();
    Some((id, cwd))
}

/// The directory pi would file this cwd's sessions in, when one already exists.
/// Matched case-insensitively for the same reason the finder does it.
fn pi_dir_for(root: &Path, cwd: &str) -> Option<PathBuf> {
    let want = pi_dir_name(cwd);
    for entry in fs::read_dir(root).ok()?.flatten() {
        if entry.file_type().ok()?.is_dir()
            && entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(&want)
        {
            return Some(entry.path());
        }
    }
    None
}

/// Carries a pi transcript to the folder a thread is moving to.
///
/// Same rule as claude's, one shape down: pi files by encoded cwd too, so a
/// thread that changes project changes the directory `/resume` and `--session`
/// look in. The file name is `<timestamp>_<uuid>.jsonl` rather than the id
/// alone, so the source is found by suffix and copied under the name it already
/// has — a session pi lists by its header id either way.
///
/// Answers reachability, not "did I copy something": `false` means replaying
/// the id over there would find nothing, and the thread should start fresh.
pub(super) fn migrate_pi_transcript(
    session_id: &str,
    from_cwd: &str,
    to_cwd: &str,
) -> Result<bool, String> {
    if normalize(from_cwd) == normalize(to_cwd) {
        return Ok(true);
    }
    let Some((root, flat)) = pi_sessions_root() else {
        return Ok(false);
    };
    // One flat directory serves every project, so nothing moves and nothing
    // becomes unreachable.
    if flat {
        return Ok(true);
    }
    let suffix = format!("_{session_id}.jsonl");
    let source = pi_dir_for(&root, from_cwd).and_then(|dir| {
        fs::read_dir(dir).ok()?.flatten().find_map(|e| {
            e.file_name()
                .to_string_lossy()
                .ends_with(&suffix)
                .then(|| e.path())
        })
    });
    let target_dir = root.join(pi_dir_name(to_cwd));
    let Some(source) = source else {
        // Never written here, or already carried over by an earlier move.
        return Ok(pi_dir_for(&root, to_cwd)
            .and_then(|dir| {
                fs::read_dir(dir).ok().map(|files| {
                    files
                        .flatten()
                        .any(|e| e.file_name().to_string_lossy().ends_with(&suffix))
                })
            })
            .unwrap_or(false));
    };
    fs::create_dir_all(&target_dir).map_err(|e| format!("cannot open the target folder: {e}"))?;
    let Some(name) = source.file_name() else {
        return Ok(false);
    };
    let target = target_dir.join(name);
    // Already there: the same thread moved back, or two threads share a cwd.
    // Overwriting would replace a transcript with an older copy of itself.
    if target.is_file() {
        return Ok(true);
    }
    fs::copy(&source, &target).map_err(|e| format!("cannot copy the transcript: {e}"))?;
    Ok(true)
}

/// Pi keeps one JSONL file per session under
/// `~/.pi/agent/sessions/--<encoded cwd>--/<timestamp>_<uuid>.jsonl`.
///
/// The encoded directory is a narrowing step and not the answer: pi encodes the
/// path as it was given, so a thread whose cwd differs only in the case of the
/// drive letter would miss its own folder. The name is matched case-insensitively
/// and then every candidate's header is read, which is what actually decides —
/// the same field pi itself resumes on, rather than a name derived twice.
pub fn find_pi_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
    let (root, flat) = pi_sessions_root()?;
    if !root.is_dir() {
        return None;
    }

    let mut dirs: Vec<PathBuf> = Vec::new();
    if flat {
        dirs.push(root);
    } else {
        let want = pi_dir_name(&cwd);
        for entry in fs::read_dir(&root).ok()?.flatten() {
            let Ok(t) = entry.file_type() else { continue };
            if !t.is_dir() {
                continue;
            }
            if entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(&want)
            {
                dirs.push(entry.path());
            }
        }
    }

    let target = normalize(&cwd);
    let mut best: Option<(String, i64)> = None;
    for dir in dirs {
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension() != Some(OsStr::new("jsonl")) {
                continue;
            }
            let Ok(mtime) = file.metadata().and_then(|m| m.modified()) else {
                continue;
            };
            let mtime = ms_since_epoch(mtime);
            if mtime < after_unix_ms {
                continue;
            }
            if best.as_ref().is_some_and(|(_, t)| mtime <= *t) {
                continue;
            }
            let Some((id, session_cwd)) = pi_session_header(&path) else {
                continue;
            };
            if normalize(&session_cwd) != target {
                continue;
            }
            if exclude.contains(&id) {
                continue;
            }
            best = Some((id, mtime));
        }
    }
    // The mtime is the transcript's own, so it is always known here: a file
    // whose metadata could not be read was skipped above.
    best.map(|(id, modified_ms)| SessionHit {
        id,
        modified_ms: Some(modified_ms),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    /// Copilot's store, cut down to what the query touches.
    fn copilot_fixture(rows: &[(&str, &str, &str, usize)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, created_at TEXT);\
             CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL);",
        )
        .unwrap();
        for (id, cwd, created_at, turns) in rows {
            conn.execute(
                "INSERT INTO sessions (id, cwd, created_at) VALUES (?1, ?2, ?3)",
                [id, cwd, created_at],
            )
            .unwrap();
            for _ in 0..*turns {
                conn.execute("INSERT INTO turns (session_id) VALUES (?1)", [id])
                    .unwrap();
            }
        }
        conn
    }

    /// The shell copilot opens at launch is the newest row in the store and has
    /// nothing in it. Captured, it was replayed at every relaunch and refused
    /// every time — "No session, task, or name matched" — while the real
    /// conversation sat one row below it.
    #[test]
    fn an_empty_copilot_session_is_not_captured() {
        let conn = copilot_fixture(&[
            ("shell", "/proj", "2026-07-27T10:13:00.000Z", 0),
            ("real", "/proj", "2026-07-27T10:12:00.000Z", 2),
        ]);
        let hit = find_copilot_session_in(&conn, "/proj", 0, &HashSet::new());
        assert_eq!(hit.as_ref().map(|h| h.id.as_str()), Some("real"));
        // And it carries when that row was created, so the caller can tell the
        // session apart from a neighbour's.
        assert_eq!(
            hit.and_then(|h| h.modified_ms),
            parse_iso_ms("2026-07-27T10:12:00.000Z"),
        );
    }

    /// Nothing to come back to yet is a reason to capture nothing, not a reason
    /// to fall back on somebody else's conversation.
    #[test]
    fn nothing_spoken_yet_captures_nothing() {
        let conn = copilot_fixture(&[("shell", "/proj", "2026-07-27T10:13:00.000Z", 0)]);
        assert_eq!(
            find_copilot_session_in(&conn, "/proj", 0, &HashSet::new()),
            None
        );
    }

    /// The rest of the filtering has to keep working over the new query.
    #[test]
    fn cwd_and_exclusions_still_apply() {
        let conn = copilot_fixture(&[
            ("elsewhere", "/other", "2026-07-27T10:14:00.000Z", 3),
            ("ours", "/proj", "2026-07-27T10:13:00.000Z", 1),
        ]);
        assert_eq!(
            find_copilot_session_in(&conn, "/proj", 0, &HashSet::new())
                .as_ref()
                .map(|h| h.id.as_str()),
            Some("ours")
        );
        let taken: HashSet<String> = ["ours".to_string()].into_iter().collect();
        assert_eq!(find_copilot_session_in(&conn, "/proj", 0, &taken), None);
    }

    /// Pi's own encoding, which decides which directory is even opened. A drive
    /// letter spends two characters — the colon and the separator after it — so
    /// a single-dash guess would look in a folder that does not exist.
    #[test]
    fn pi_encodes_a_cwd_the_way_pi_does() {
        assert_eq!(pi_dir_name("/home/u/proj"), "--home-u-proj--");
        assert_eq!(pi_dir_name(r"D:\Dev\boite"), "--D--Dev-boite--");
        // Exactly one leading separator is dropped, as in pi's own regex: the
        // second one stays and becomes a dash like any other.
        assert_eq!(pi_dir_name("//srv/share"), "---srv-share--");
    }

    /// Grok's own encoding, read off the groups it left on disk: colon and
    /// backslash become `%3A` / `%5C`, a dot in `.boite` stays a dot.
    #[test]
    fn grok_encodes_a_cwd_the_way_grok_does() {
        assert_eq!(grok_dir_name(r"C:\Users\mtsu"), "C%3A%5CUsers%5Cmtsu");
        assert_eq!(
            grok_dir_name(r"D:\Dev\Collab\boite\.boite\worktrees\abc"),
            "D%3A%5CDev%5CCollab%5Cboite%5C.boite%5Cworktrees%5Cabc"
        );
        assert_eq!(grok_dir_name("/home/u/proj"), "%2Fhome%2Fu%2Fproj");
        assert_eq!(
            grok_dir_name(r"D:\Dev\boite\"),
            grok_dir_name(r"D:\Dev\boite")
        );
    }

    fn grok_fixture(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("boite-grok-store-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_grok(root: &Path, cwd: &str, id: &str, body: &str) -> PathBuf {
        let dir = root.join(grok_dir_name(cwd)).join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("summary.json"), body).unwrap();
        dir
    }

    #[test]
    fn grok_finds_the_newest_session_of_this_folder() {
        let root = grok_fixture("newest");
        seed_grok(&root, "/w/proj", "old", "{}");
        let newer = seed_grok(&root, "/w/proj", "new", "{}");
        // Force an mtime order the filesystem would not otherwise guarantee.
        let later = SystemTime::now() + Duration::from_secs(2);
        fs::File::options()
            .write(true)
            .open(newer.join("summary.json"))
            .unwrap()
            .set_modified(later)
            .unwrap();
        seed_grok(&root, "/w/other", "elsewhere", "{}");

        let hit = find_grok_session_in(&root, "/w/proj", 0, &HashSet::new());
        assert_eq!(hit.as_ref().map(|h| h.id.as_str()), Some("new"));
    }

    #[test]
    fn grok_follows_this_thread_link_and_skips_a_sibling() {
        let root = grok_fixture("links");
        seed_grok(&root, "/w/proj", "sess", "{\"ok\":1}");
        let pool = root.join(grok_dir_name("/w/proj"));
        crate::git::artifacts::link_dir(&pool, &root.join(grok_dir_name("/w/one"))).unwrap();
        crate::git::artifacts::link_dir(&pool, &root.join(grok_dir_name("/w/two"))).unwrap();

        assert_eq!(
            find_grok_session_in(&root, "/w/one", 0, &HashSet::new())
                .as_ref()
                .map(|h| h.id.as_str()),
            Some("sess")
        );
        assert_eq!(
            find_grok_session_in(&root, "/w/proj", 0, &HashSet::new())
                .as_ref()
                .map(|h| h.id.as_str()),
            Some("sess")
        );
        assert_eq!(
            find_grok_session_in(&root, "/w/two", 0, &HashSet::new())
                .as_ref()
                .map(|h| h.id.as_str()),
            Some("sess")
        );
    }

    #[test]
    fn a_grok_session_follows_the_thread_to_the_new_folder() {
        let root = grok_fixture("moves");
        let source = seed_grok(&root, "/w/from", "sess-1", "{\"a\":1}");

        let moved = migrate_grok_transcript_in(&root, "sess-1", "/w/from", "/w/to").unwrap();

        assert!(moved);
        assert!(source.is_dir(), "the original is kept");
        let landed = root
            .join(grok_dir_name("/w/to"))
            .join("sess-1")
            .join("summary.json");
        assert_eq!(fs::read_to_string(landed).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn an_existing_grok_session_is_never_overwritten() {
        let root = grok_fixture("existing");
        seed_grok(&root, "/w/from", "sess-2", "old");
        let target = seed_grok(&root, "/w/to", "sess-2", "newer");

        assert!(migrate_grok_transcript_in(&root, "sess-2", "/w/from", "/w/to").unwrap());
        assert_eq!(
            fs::read_to_string(target.join("summary.json")).unwrap(),
            "newer"
        );
    }

    #[test]
    fn nothing_to_carry_for_grok_reads_as_nothing_to_resume() {
        let root = grok_fixture("empty");
        assert!(!migrate_grok_transcript_in(&root, "ghost", "/w/from", "/w/to").unwrap());
    }
}
