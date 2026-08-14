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
) -> Option<SessionHit> {
    let sessions_dir = grok_sessions_dir()?;
    if !sessions_dir.is_dir() {
        return None;
    }

    let target = normalize(&cwd);
    let mut best: Option<(String, Option<i64>)> = None;

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
            if best.as_ref().is_none_or(|(_, t)| mtime.unwrap_or(0) > t.unwrap_or(0)) {
                best = Some((id, mtime));
            }
        }
    }
    best.map(|(id, modified_ms)| SessionHit { id, modified_ms })
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
        .map(|c| if c == '/' || c == '\\' || c == ':' { '-' } else { c })
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
}
