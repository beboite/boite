//! Claude's transcripts, and the one registry Boite can act on.
//!
//! The only store of the eight that is more than a read. `~/.claude/ide/*.lock`
//! is a live registry with a pid per session, so a session can be told from a
//! stale entry, stopped, and followed when its thread changes project.
//!
//! Its transcripts live under a directory named after the working directory
//! with the separators flattened, which is why a thread that moves has to have
//! its file carried across: claude looks for the transcript under the folder it
//! is started in, and the work would otherwise be invisible from the new one.

use super::*;

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
    cwd: Option<String>,
    #[serde(rename = "waitingFor")]
    waiting_for: Option<String>,
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
    /// One of `busy`, `waiting`, `shell`, `idle`. Claude's own four-state view of
    /// what it is doing, rewritten as each of those begins and ends:
    ///
    /// - `busy`: a turn is in flight. Subagents get no entry of their own (the
    ///   Task tool runs them in the parent process, appending their turns to the
    ///   parent transcript with `isSidechain`), so the parent reads `busy` for as
    ///   long as one works. That is the only signal Boite has that survives a
    ///   terminal going quiet for minutes.
    /// - `waiting`: blocked on the user. A permission prompt, a plan to approve,
    ///   an elicitation, any open dialog. The turn is not over and the answer is
    ///   the only thing that will end it.
    /// - `shell`: the turn is over, but a shell it launched is still running.
    /// - `idle`: nothing in flight.
    ///
    /// An idle agent can be released without losing anything; the other three are
    /// all mid-something.
    ///
    /// None means the entry carried no `status` key at all, which is what a claude
    /// build predating the field writes. Kept apart from any of the four rather
    /// than folded into `busy`: this is the status source of truth now, and a
    /// default of "a turn is in flight" would pin every claude thread Running for
    /// the life of the process, veto auto-sleep and never fire a notification.
    pub status: Option<String>,
    /// What it is waiting for, when claude named it: `sandbox request`,
    /// `input needed`, `dialog open`, or the open dialog's own label. Only ever
    /// set alongside `waiting`.
    pub waiting_for: Option<String>,
    /// The directory the session runs in, as claude recorded it. Lets a caller
    /// place a session it has no id for yet.
    pub cwd: String,
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
                status: parsed.status,
                waiting_for: parsed.waiting_for,
                cwd: parsed.cwd.unwrap_or_default(),
            });
        }
    }
    live
}

/// One claude registry entry as a turn, or nothing at all when it declared no
/// status.
///
/// Absence is not a state. Every other reader in this file answers "no answer"
/// when it cannot tell, and this one has to as well: folded into `busy`, a claude
/// build that does not write the field would pin every one of its threads Running
/// with nothing able to clear it, veto auto-sleep and never fire a notification.
/// Silence falls back to the screen rows and the TTL, which can clear it.
/// A state that is present but unrecognised still reads as `busy` downstream:
/// that one is a format this does not know rather than a fact nobody stated.
pub(super) fn claude_turn(s: LiveClaudeSession) -> Option<AgentTurn> {
    Some(AgentTurn {
        kind: "claude".into(),
        session_id: s.id,
        cwd: s.cwd,
        state: s.status?,
        waiting_for: s.waiting_for,
    })
}

fn encode_claude_project_dir(p: &str) -> String {
    p.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .to_lowercase()
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

/// Whether the transcript is already sitting in the destination.
///
/// Asked when the source has nothing: a thread moved out and back finds its own
/// copy waiting, and reporting that as unreachable would throw away a
/// conversation that is right there.
fn source_already_at_target(projects: &Path, session_id: &str, to_cwd: &str) -> bool {
    projects
        .join(encode_claude_project_dir(&normalize(to_cwd)))
        .join(format!("{session_id}.jsonl"))
        .is_file()
}

/// The copy itself, over a `projects` directory the caller names — which is what
/// makes it testable without a `~/.claude` on the machine running the suite.
/// Answers whether the session is reachable from `to_cwd` once this returns.
pub(super) fn migrate_claude_transcript(
    projects: &Path,
    session_id: &str,
    from_cwd: &str,
    to_cwd: &str,
) -> Result<bool, String> {
    // Same folder: nothing to carry, and the session was already reachable.
    if normalize(from_cwd) == normalize(to_cwd) {
        return Ok(true);
    }
    let source = projects
        .join(encode_claude_project_dir(&normalize(from_cwd)))
        .join(format!("{session_id}.jsonl"));
    if !source.is_file() {
        // The thread may never have had a transcript here — a session captured
        // in a worktree, a claude that wrote nowhere. Not an error, but the
        // caller has to know: replaying this id over there would fail, so the
        // thread starts a fresh conversation instead.
        return Ok(source_already_at_target(projects, session_id, to_cwd));
    }

    let target_dir = projects.join(encode_claude_project_dir(&normalize(to_cwd)));
    fs::create_dir_all(&target_dir).map_err(|e| format!("cannot open the target folder: {e}"))?;
    let target = target_dir.join(format!("{session_id}.jsonl"));
    // Already there — the same thread moved back, or two threads share a cwd.
    // Overwriting would replace a transcript with an older copy of itself.
    if target.is_file() {
        return Ok(true);
    }
    fs::copy(&source, &target).map_err(|e| format!("cannot copy the transcript: {e}"))?;
    Ok(true)
}

/// `own_pid` is the process the calling thread's PTY spawned, when it has one.
/// The session that process holds open is the one the thread is meant to bind
/// to, so it survives the liveness filter below; every other live session is
/// still skipped.
pub fn find_claude_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
    own_pid: Option<u32>,
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
    //
    // A session held by our own PTY's process is not a reason to skip: it is
    // the thread's session, and the whole point of the scan is to bind it.
    // Skipping it left an interactive claude unbindable for as long as it ran,
    // which is its entire life — and the resume that needed the binding then
    // had nothing to replay. Liveness at *replay* time is a separate question,
    // re-asked at launch by buildResumeArgsAsync.
    let live: HashSet<String> = live_claude_sessions()
        .into_iter()
        .filter(|s| own_pid.is_none_or(|p| s.pid != p))
        .map(|s| s.id)
        .collect();

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use crate::session::claude_said;

    #[test]
    fn a_captured_id_is_read_off_its_own_entry() {
        let live = [claude_said("a", "busy", "/w/one"), claude_said("b", "idle", "/w/two")];
        assert_eq!(
            declared_turn(&live, "claude", Some("a"), "/w/one"),
            DeclaredTurn::Busy
        );
        assert_eq!(
            declared_turn(&live, "claude", Some("b"), "/w/two"),
            DeclaredTurn::Idle
        );
    }

    #[test]
    fn a_captured_id_that_is_not_live_never_borrows_a_neighbour() {
        // The thread's agent has gone, or predates whatever records this.
        // Answering from the directory would hand it someone else's state.
        let live = [claude_said("a", "busy", "/w/one")];
        assert_eq!(
            declared_turn(&live, "claude", Some("gone"), "/w/one"),
            DeclaredTurn::Unknown
        );
    }

    #[test]
    fn an_uncaptured_thread_is_placed_by_its_directory() {
        // The seconds before capture are part of the agent's first turn, which is
        // where a long subagent run would otherwise read as idle.
        let live = [claude_said("a", "busy", "/w/one")];
        assert_eq!(
            declared_turn(&live, "claude", None, "/w/one"),
            DeclaredTurn::Busy
        );
        assert_eq!(
            declared_turn(&live, "claude", Some(""), "/w/one"),
            DeclaredTurn::Busy
        );
    }

    #[test]
    fn directory_matching_ignores_separator_and_case() {
        let live = [claude_said("a", "busy", r"C:\Work\One\")];
        assert_eq!(
            declared_turn(&live, "claude", None, "c:/work/one"),
            DeclaredTurn::Busy
        );
    }

    #[test]
    fn two_sessions_in_one_directory_answer_nothing() {
        let live = [claude_said("a", "busy", "/w/one"), claude_said("b", "idle", "/w/one")];
        assert_eq!(
            declared_turn(&live, "claude", None, "/w/one"),
            DeclaredTurn::Unknown
        );
    }

    #[test]
    fn an_unplaceable_thread_answers_nothing() {
        let live = [claude_said("a", "busy", "/w/one")];
        assert_eq!(
            declared_turn(&live, "claude", None, "/w/other"),
            DeclaredTurn::Unknown
        );
        assert_eq!(declared_turn(&live, "claude", None, ""), DeclaredTurn::Unknown);
        assert_eq!(declared_turn(&[], "claude", None, "/w/one"), DeclaredTurn::Unknown);
    }

    #[test]
    fn a_session_with_no_recorded_directory_is_placed_by_nobody() {
        // Ported from `agent-registry.test.ts`, which had the guard this did not.
        // `/` normalises to the empty string, so without it a thread at the root
        // of a drive was handed the state of every session that recorded nothing.
        let live = [claude_said("a", "busy", "")];
        assert_eq!(
            declared_turn(&live, "claude", None, "/w/one"),
            DeclaredTurn::Unknown
        );
        assert_eq!(declared_turn(&live, "claude", None, "/"), DeclaredTurn::Unknown);
    }

    #[test]
    fn a_claude_entry_with_no_status_says_nothing_at_all() {
        // This is the status source of truth now. A build that writes no `status`
        // key must produce no turn, so the screen rows and the TTL get the thread.
        // Reading it as `busy` would pin it Running with nothing able to clear
        // it, which is the bug this whole loop exists to not have.
        let entry = |status: Option<&str>| LiveClaudeSession {
            id: "a".into(),
            pid: 1,
            kind: "interactive".into(),
            status: status.map(str::to_string),
            waiting_for: None,
            cwd: "/w/one".into(),
        };
        assert_eq!(claude_turn(entry(None)), None);
        assert_eq!(
            claude_turn(entry(Some("idle"))).map(|t| t.state),
            Some("idle".to_string())
        );
        // Present but unreadable is a format we do not know, not a fact nobody
        // stated: it survives as a turn and reads busy downstream.
        let unknown = claude_turn(entry(Some("starting"))).expect("a stated state is a turn");
        assert_eq!(
            declared_turn(&[unknown], "claude", Some("a"), "/w/one"),
            DeclaredTurn::Busy
        );
    }

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

    /// A `~/.claude/projects` of our own, so the suite never reads the machine's.
    fn projects_fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("boite-migrate-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_transcript(projects: &Path, cwd: &str, session_id: &str, body: &str) -> PathBuf {
        let dir = projects.join(encode_claude_project_dir(&normalize(cwd)));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{session_id}.jsonl"));
        fs::write(&path, body).unwrap();
        path
    }

    /// The whole point of the move: claude searches by directory, so a thread
    /// that changed project finds nothing under the new one until the file is
    /// there. The original stays put — a conversation is never left in flight.
    #[test]
    fn a_transcript_follows_the_thread_to_the_new_folder() {
        let projects = projects_fixture("moves");
        let source = seed_transcript(&projects, "/w/from", "sess-1", "{\"a\":1}\n");

        let moved = migrate_claude_transcript(&projects, "sess-1", "/w/from", "/w/to").unwrap();

        assert!(moved);
        assert!(source.is_file(), "the original is kept");
        let landed = projects
            .join(encode_claude_project_dir("/w/to"))
            .join("sess-1.jsonl");
        assert_eq!(fs::read_to_string(landed).unwrap(), "{\"a\":1}\n");
    }

    /// A transcript already at the destination is the newer one — the thread
    /// came back, or two threads share a folder. Copying over it would replace a
    /// live conversation with an older copy of itself.
    #[test]
    fn an_existing_transcript_is_never_overwritten() {
        let projects = projects_fixture("existing");
        seed_transcript(&projects, "/w/from", "sess-2", "old\n");
        let target = seed_transcript(&projects, "/w/to", "sess-2", "newer\n");

        assert!(migrate_claude_transcript(&projects, "sess-2", "/w/from", "/w/to").unwrap());
        assert_eq!(fs::read_to_string(target).unwrap(), "newer\n");
    }

    /// The answer is "can this be resumed over there", not "did I copy
    /// something". A thread whose claude never wrote a transcript still moves —
    /// it just has to start a fresh conversation, and the caller only knows to
    /// drop the session id because this says false.
    #[test]
    fn nothing_to_carry_reads_as_nothing_to_resume() {
        let projects = projects_fixture("empty");
        assert!(!migrate_claude_transcript(&projects, "ghost", "/w/from", "/w/to").unwrap());
    }

    /// A CLI that files by time or by database was always reachable from
    /// anywhere, and so is a move that does not change folder. Both keep their
    /// session id.
    #[test]
    fn a_session_that_never_moved_stays_resumable() {
        assert!(migrate_session_blocking("codex", "sess-3", "/w/from", "/w/to").unwrap());
        assert!(migrate_session_blocking("claude", "sess-3", "/w/same", "/w/same").unwrap());
    }

    /// A thread that moved out and came back finds its own copy waiting. The
    /// source is empty by then, and calling that unreachable would throw away a
    /// conversation sitting in the destination.
    #[test]
    fn a_transcript_already_waiting_at_the_destination_counts() {
        let projects = projects_fixture("returned");
        seed_transcript(&projects, "/w/to", "sess-4", "here\n");
        assert!(migrate_claude_transcript(&projects, "sess-4", "/w/from", "/w/to").unwrap());
    }
}
