//! Codex's sessions, and the rollout log its turn state is read from.
//!
//! Two different files answer two different questions. The session file gives
//! an id and a first prompt, which is what a title is made of. The rollout log
//! is appended to as a turn runs, and the last marker in it is the only thing
//! that says whether codex is still thinking.
//!
//! A rollout that stops being written to is not a turn that ended: the process
//! may have died mid-answer. So an open marker only counts while the file is
//! fresh, and goes quiet after [`CODEX_ROLLOUT_TTL`].

use super::*;

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

/// How much of a rollout's tail is scanned for the marker that ends a turn.
///
/// Generous, because the markers bracket a whole turn and everything the agent
/// did lands in between. Not unbounded, because this runs on a timer: past this
/// the answer is `Unknown` and the terminal's own rows decide, which for codex
/// they can, since it prints an interrupt hint the whole time it works.
const CODEX_TAIL_BYTES: u64 = 256 * 1024;

/// How long a rollout can go untouched before an open turn stops counting.
///
/// Nothing else ever ages a codex answer out. Claude's registry is filtered by
/// `pid_alive` and opencode's rows close themselves, but a codex killed, crashed
/// or rebooted mid-turn leaves `task_started` as the last marker it ever wrote,
/// and the thread index keeps the row and matches it by session id for good, so
/// the thread reads busy on every poll until someone deletes the file.
///
/// Generous on purpose: the markers bracket a whole turn, and a single long tool
/// call appends nothing at all while it runs. Past it the answer is no answer,
/// and the terminal's own rows decide, which for codex they can.
const CODEX_ROLLOUT_TTL: Duration = Duration::from_secs(30 * 60);

/// Codex's thread index. The number is a schema version and has moved before
/// (`state_5.sqlite` today), so it is discovered rather than hardcoded: a bumped
/// version must degrade to "no answer" and not to "wrong answer".
fn codex_state_db() -> Option<PathBuf> {
    let dir = dirs::home_dir()?.join(".codex");
    let mut best: Option<(u32, PathBuf)> = None;
    for entry in fs::read_dir(&dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension() != Some(OsStr::new("sqlite")) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(version) = stem.strip_prefix("state_").and_then(|v| v.parse::<u32>().ok())
        else {
            continue;
        };
        if best.as_ref().is_none_or(|(seen, _)| version > *seen) {
            best = Some((version, path));
        }
    }
    best.map(|(_, path)| path)
}

/// Whether a codex turn is in flight, read off the transcript it is appending to.
///
/// Codex does keep the state we want, but only as an app-server protocol type
/// pushed over JSON-RPC to whoever spawned the process. A terminal someone else
/// started exposes none of it, so the transcript is what is left: it brackets each
/// turn with `task_started` and closes it with `task_complete` or `turn_aborted`.
/// Reading the last of those backwards is the whole answer.
///
/// `waiting` has no equivalent here. Codex knows the difference (its protocol has
/// `waitingOnApproval` and `waitingOnUserInput`) but does not write approval
/// events to the rollout, so an approval prompt is indistinguishable from a turn
/// still running. Busy is the safe side of that: it keeps auto-sleep off a thread
/// that is actually waiting for the user.
///
/// Bounded by how long ago the file was written: an open turn is only an open
/// turn while codex is still there to close it.
fn codex_rollout_state(path: &Path) -> Option<&'static str> {
    let mut file = fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let len = meta.len();
    let age = meta
        .modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok());
    let from = len.saturating_sub(CODEX_TAIL_BYTES);
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    // Dropping the first line matters only when the window clipped one in half;
    // a partial line cannot parse anyway, so this is about not scanning garbage.
    let body = if from > 0 {
        buf.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        &buf
    };
    for line in body.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<CodexRolloutLine>(line) else {
            continue;
        };
        if event.kind.as_deref() != Some("event_msg") {
            continue;
        }
        match event.payload.and_then(|p| p.kind).as_deref() {
            Some("task_started") => return bound_open_turn(age),
            Some("task_complete") | Some("turn_aborted") => return Some("idle"),
            _ => continue,
        }
    }
    None
}

/// Whether a turn left open in a rollout still counts, given the file's age.
///
/// Only the open side is bounded. A closed turn stays closed however old the
/// transcript is, and an age this could not read (a clock skewed the wrong way, a
/// filesystem that answered nothing) is not evidence of anything, so it is read
/// as fresh rather than used to demote a working thread.
fn bound_open_turn(age: Option<Duration>) -> Option<&'static str> {
    match age {
        Some(age) if age >= CODEX_ROLLOUT_TTL => None,
        _ => Some("busy"),
    }
}

#[derive(Deserialize)]
struct CodexRolloutLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<CodexRolloutPayload>,
}

#[derive(Deserialize)]
struct CodexRolloutPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
}

pub(super) fn codex_turns(queries: &[TurnQuery]) -> Vec<AgentTurn> {
    let Some(db) = codex_state_db() else {
        return Vec::new();
    };
    let Ok(conn) = open_readonly(&db) else {
        return Vec::new();
    };
    // The recent end of the index, read once. Bounded rather than filtered per
    // query because a thread with no captured id has to be found by directory,
    // and both lookups then happen in memory.
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, cwd, rollout_path FROM threads \
         WHERE archived = 0 \
         ORDER BY coalesce(updated_at_ms, updated_at * 1000) DESC LIMIT 200",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) else {
        return Vec::new();
    };
    // Codex records the cwd with Windows's extended-length prefix. Stripped here,
    // before anything compares it: left on, it matches no path a user ever picked
    // through a folder browser, and the whole codex side silently answers nothing.
    let threads: Vec<(String, String, String)> = rows
        .flatten()
        .map(|(id, cwd, rollout)| {
            (
                id,
                cwd.strip_prefix(r"\\?\").unwrap_or(&cwd).to_string(),
                rollout,
            )
        })
        .collect();

    let mut out = Vec::new();
    for query in queries.iter().filter(|q| q.kind == "codex") {
        let hit = match query.id() {
            Some(id) => threads.iter().find(|(tid, _, _)| tid == id),
            None => {
                let want = normalize(&query.cwd);
                // Newest first, so this is the most recent thread in the folder.
                // Unlike the registry agents there is no liveness here at all, so
                // a stale row is possible; the rollout markers below are what
                // actually decide, and a finished one reads idle.
                threads.iter().find(|(_, cwd, _)| normalize(cwd) == want)
            }
        };
        let Some((id, cwd, rollout)) = hit else {
            continue;
        };
        let Some(state) = codex_rollout_state(Path::new(rollout)) else {
            continue;
        };
        out.push(AgentTurn {
            kind: "codex".into(),
            session_id: id.clone(),
            cwd: cwd.clone(),
            state: state.into(),
            waiting_for: None,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_rollout_markers_decide_the_turn() {
        // Codex brackets a turn with these and writes nothing else that says so,
        // because the status it does track never reaches the transcript.
        let dir = std::env::temp_dir().join(format!("boite-codex-turn-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, lines: &[&str]| {
            let path = dir.join(name);
            fs::write(&path, lines.join("
")).unwrap();
            path
        };

        let started = write(
            "started.jsonl",
            &[
                r#"{"type":"session_meta","payload":{"id":"a","cwd":"/w"}}"#,
                r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
                r#"{"type":"response_item","payload":{"type":"message"}}"#,
            ],
        );
        assert_eq!(codex_rollout_state(&started), Some("busy"));

        let done = write(
            "done.jsonl",
            &[
                r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
                r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
                r#"{"type":"event_msg","payload":{"type":"token_count"}}"#,
            ],
        );
        assert_eq!(codex_rollout_state(&done), Some("idle"));

        // An interrupted turn is over too; only the marker differs.
        let aborted = write(
            "aborted.jsonl",
            &[
                r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
                r#"{"type":"event_msg","payload":{"type":"turn_aborted"}}"#,
            ],
        );
        assert_eq!(codex_rollout_state(&aborted), Some("idle"));

        // The newest marker wins: a second turn opened after the first closed.
        let again = write(
            "again.jsonl",
            &[
                r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
                r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
                r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
            ],
        );
        assert_eq!(codex_rollout_state(&again), Some("busy"));

        // No marker in reach is not an answer. The terminal's own rows decide,
        // which for codex they can: it prints an interrupt hint while it works.
        let quiet = write(
            "quiet.jsonl",
            &[r#"{"type":"session_meta","payload":{"id":"a","cwd":"/w"}}"#],
        );
        assert_eq!(codex_rollout_state(&quiet), None);
        assert_eq!(codex_rollout_state(&dir.join("missing.jsonl")), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_open_codex_turn_stops_counting_once_the_rollout_goes_stale() {
        // Codex killed, crashed or rebooted mid-turn leaves `task_started` as the
        // last marker it will ever write. There is no pid to check and the thread
        // index keeps the row forever, so without this the thread reads busy on
        // every poll until someone deletes the file.
        assert_eq!(bound_open_turn(Some(Duration::from_secs(0))), Some("busy"));
        assert_eq!(
            bound_open_turn(Some(CODEX_ROLLOUT_TTL - Duration::from_secs(1))),
            Some("busy")
        );
        assert_eq!(bound_open_turn(Some(CODEX_ROLLOUT_TTL)), None);
        assert_eq!(
            bound_open_turn(Some(CODEX_ROLLOUT_TTL * 100)),
            None
        );
        // An age nothing could read is not evidence a turn ended.
        assert_eq!(bound_open_turn(None), Some("busy"));
    }
}
