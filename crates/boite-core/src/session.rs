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

/// A session matched by one of the detectors that answer with an id alone.
///
/// `modified_ms` is when the store last saw activity on it, and is what lets
/// the caller decide whether the session belongs to the thread that asked
/// rather than to a neighbour. It is optional because some stores keep a
/// timestamp this code cannot always read — an unparseable column, a file whose
/// metadata failed. None means "unknown", never "long ago": inventing a zero
/// would read as activity in 1970 and lose the session to a check it can no
/// longer pass.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionHit {
    pub id: String,
    pub modified_ms: Option<i64>,
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
    pub status: String,
    /// What it is waiting for, when claude named it: `sandbox request`,
    /// `input needed`, `dialog open`, or the open dialog's own label. Only ever
    /// set alongside `waiting`.
    pub waiting_for: Option<String>,
    /// The directory the session runs in, as claude recorded it. Lets a caller
    /// place a session it has no id for yet.
    pub cwd: String,
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
                waiting_for: parsed.waiting_for,
                cwd: parsed.cwd.unwrap_or_default(),
            });
        }
    }
    live
}

/// What claude says about a thread's turn, or that it has nothing to say.
///
/// Four of these are claude's own states, one is the absence of an answer. They
/// are kept distinct rather than collapsed to working/not-working because two of
/// them mean "do not touch this thread" for different reasons: `Waiting` needs the
/// user and `Shell` has a command still running, and neither is a finished turn
/// even though neither is the agent thinking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeclaredTurn {
    /// A turn is in flight, subagents included.
    Busy,
    /// Blocked on the user: a permission prompt, a plan to approve, any dialog.
    /// The turn ends when the answer arrives and not before.
    Waiting,
    /// The turn is over, but a shell claude launched is still running.
    Shell,
    /// Nothing in flight.
    Idle,
    /// The registry has nothing to say about this thread.
    Unknown,
}

impl DeclaredTurn {
    /// Whether the thread is mid-something. False only for a genuinely finished
    /// turn; `Unknown` is not an answer and answers false here too, so callers
    /// must check for it separately when that distinction matters.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            DeclaredTurn::Busy | DeclaredTurn::Waiting | DeclaredTurn::Shell
        )
    }
}

/// Places a thread in claude's session registry and reads its turn off it.
///
/// By id when the thread has captured one: that is the precise question, and a
/// miss answers `Unknown` rather than falling back to the directory. An id that
/// is not in the registry means claude is not holding that session (it exited, or
/// it predates the registry), and a neighbour's state must not stand in for it.
///
/// By directory otherwise, and only when exactly one live session claims it. The
/// window before a session id is captured is a few seconds of the agent's first
/// turn, which is routinely its longest, so leaving it unanswerable is how a
/// thread gets called idle while a subagent works. Two sessions in one directory
/// answers `Unknown`: with per-thread worktrees that does not normally happen,
/// and guessing between them would light or sleep the wrong thread.
pub fn declared_turn(
    sessions: &[LiveClaudeSession],
    session_id: Option<&str>,
    cwd: &str,
) -> DeclaredTurn {
    let read = |s: &LiveClaudeSession| match s.status.as_str() {
        "idle" => DeclaredTurn::Idle,
        "waiting" => DeclaredTurn::Waiting,
        "shell" => DeclaredTurn::Shell,
        // `busy`, and anything else. An unset or unrecognised status comes from a
        // claude whose registry format this does not know, and calling that
        // finished is the one wrong answer that loses work to auto-sleep.
        _ => DeclaredTurn::Busy,
    };
    if let Some(id) = session_id.filter(|id| !id.is_empty()) {
        return match sessions.iter().find(|s| s.id == id) {
            Some(s) => read(s),
            None => DeclaredTurn::Unknown,
        };
    }
    if cwd.is_empty() {
        return DeclaredTurn::Unknown;
    }
    let want = normalize(cwd);
    let mut found = None;
    for s in sessions.iter().filter(|s| normalize(&s.cwd) == want) {
        if found.is_some() {
            return DeclaredTurn::Unknown;
        }
        found = Some(s);
    }
    found.map(read).unwrap_or(DeclaredTurn::Unknown)
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

/// Whether this CLI files its transcripts under the directory it ran in.
///
/// Only claude does. The others key their store by time (codex), by an internal
/// database (cursor, antigravity) or by a flat session list (opencode, copilot,
/// grok, hermes), so a session of theirs resumes from anywhere and a move has
/// nothing to carry.
pub fn session_store_is_cwd_scoped(kind: &str) -> bool {
    kind == "claude"
}

/// Carries a transcript to the directory the thread is moving to, and answers
/// whether the conversation can be resumed from there.
///
/// Claude looks a session up in `~/.claude/projects/<encoded cwd>/`, so a thread
/// that changes project changes the directory claude searches and `--resume`
/// stops finding anything. Copying the file into the destination is what keeps
/// the conversation reachable from the new folder.
///
/// The answer is reachability rather than "did I copy something", because that
/// is the question the caller has: `false` means replaying the id over there
/// would fail, and the thread should start a fresh conversation instead of
/// launching with a `--resume` nothing backs. A CLI that does not file by
/// directory therefore answers `true` without touching anything — its sessions
/// were always reachable from anywhere.
///
/// Copied, never moved. A move that half-succeeded would leave the conversation
/// nowhere, and the original costs a file: the session monitor already excludes
/// ids a thread holds, so the leftover is not picked up as a second session.
///
/// The `cwd` recorded inside the transcript is left alone. It is history — what
/// the earlier turns actually ran against — and claude writes the new directory
/// on the lines it appends from here on.
pub fn migrate_session_blocking(
    kind: &str,
    session_id: &str,
    from_cwd: &str,
    to_cwd: &str,
) -> Result<bool, String> {
    if !session_store_is_cwd_scoped(kind) {
        return Ok(true);
    }
    // A session id ends up as a file name; nothing else may.
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("not a session id".into());
    }
    let home = dirs::home_dir().ok_or("no home directory")?;
    migrate_claude_transcript(
        &home.join(".claude").join("projects"),
        session_id,
        from_cwd,
        to_cwd,
    )
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
fn migrate_claude_transcript(
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
) -> Option<SessionHit> {
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
            // The query already folded every table's timestamp into one; a row
            // whose columns were all null lands on 0, which is no timestamp.
            return Some(SessionHit {
                id,
                modified_ms: (activity_ms > 0).then_some(activity_ms),
            });
        }
    }
    None
}

fn find_opencode_session_by_created(
    conn: &Connection,
    target: &str,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
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
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .ok()?;

    for row in rows.flatten() {
        let (id, directory, created_ms) = row;
        if normalize(&directory) == target && !exclude.contains(&id) {
            // Creation is the only time this fallback knows about. It is the
            // right one here: it only runs for a session no activity row
            // covers, which is one nothing has happened on since.
            return Some(SessionHit {
                id,
                modified_ms: created_ms.filter(|ms| *ms > 0),
            });
        }
    }
    None
}

pub fn find_opencode_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
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

pub fn build_exclude(ids: Option<Vec<String>>) -> HashSet<String> {
    ids.unwrap_or_default().into_iter().collect()
}

#[cfg(test)]
mod turn_tests {
    use super::*;

    fn entry(id: &str, status: &str, cwd: &str) -> LiveClaudeSession {
        LiveClaudeSession {
            id: id.into(),
            pid: 1,
            kind: "interactive".into(),
            status: status.into(),
            waiting_for: None,
            cwd: cwd.into(),
        }
    }

    #[test]
    fn each_claude_state_maps_to_its_own_answer() {
        // The four claude writes, plus the catch-all. Collapsing waiting or shell
        // into idle is what let a thread be called finished while a permission
        // prompt sat unanswered, or while a shell it started still ran.
        let live = [
            entry("busy", "busy", "/w/1"),
            entry("waiting", "waiting", "/w/2"),
            entry("shell", "shell", "/w/3"),
            entry("idle", "idle", "/w/4"),
        ];
        assert_eq!(declared_turn(&live, Some("busy"), ""), DeclaredTurn::Busy);
        assert_eq!(
            declared_turn(&live, Some("waiting"), ""),
            DeclaredTurn::Waiting
        );
        assert_eq!(declared_turn(&live, Some("shell"), ""), DeclaredTurn::Shell);
        assert_eq!(declared_turn(&live, Some("idle"), ""), DeclaredTurn::Idle);
    }

    #[test]
    fn only_a_finished_turn_is_inactive() {
        assert!(DeclaredTurn::Busy.is_active());
        assert!(DeclaredTurn::Waiting.is_active());
        assert!(DeclaredTurn::Shell.is_active());
        assert!(!DeclaredTurn::Idle.is_active());
        // Not an answer, so not an assertion of activity either.
        assert!(!DeclaredTurn::Unknown.is_active());
    }

    #[test]
    fn a_captured_id_is_read_off_its_own_entry() {
        let live = [entry("a", "busy", "/w/one"), entry("b", "idle", "/w/two")];
        assert_eq!(declared_turn(&live, Some("a"), "/w/one"), DeclaredTurn::Busy);
        assert_eq!(declared_turn(&live, Some("b"), "/w/two"), DeclaredTurn::Idle);
    }

    #[test]
    fn a_captured_id_that_is_not_live_never_borrows_a_neighbour() {
        // The thread's claude has gone, or predates the registry. Answering from
        // the directory here would hand it the state of whoever else is there.
        let live = [entry("a", "busy", "/w/one")];
        assert_eq!(
            declared_turn(&live, Some("gone"), "/w/one"),
            DeclaredTurn::Unknown
        );
    }

    #[test]
    fn an_uncaptured_thread_is_placed_by_its_directory() {
        // The seconds before capture are part of the agent's first turn, which is
        // where a long subagent run would otherwise read as idle.
        let live = [entry("a", "busy", "/w/one")];
        assert_eq!(declared_turn(&live, None, "/w/one"), DeclaredTurn::Busy);
        assert_eq!(declared_turn(&live, Some(""), "/w/one"), DeclaredTurn::Busy);
    }

    #[test]
    fn directory_matching_ignores_separator_and_case() {
        let live = [entry("a", "busy", "C:\\Work\\One\\")];
        assert_eq!(declared_turn(&live, None, "c:/work/one"), DeclaredTurn::Busy);
    }

    #[test]
    fn two_sessions_in_one_directory_answer_nothing() {
        let live = [entry("a", "busy", "/w/one"), entry("b", "idle", "/w/one")];
        assert_eq!(declared_turn(&live, None, "/w/one"), DeclaredTurn::Unknown);
    }

    #[test]
    fn an_unplaceable_thread_answers_nothing() {
        let live = [entry("a", "busy", "/w/one")];
        assert_eq!(declared_turn(&live, None, "/w/other"), DeclaredTurn::Unknown);
        assert_eq!(declared_turn(&live, None, ""), DeclaredTurn::Unknown);
        assert_eq!(declared_turn(&[], None, "/w/one"), DeclaredTurn::Unknown);
    }

    #[test]
    fn an_unrecognised_status_is_treated_as_a_turn_in_flight() {
        // Calling a status we cannot read "finished" is what would let auto-sleep
        // kill a working PTY.
        let live = [entry("a", "starting", "/w/one"), entry("b", "", "/w/two")];
        assert_eq!(declared_turn(&live, Some("a"), "/w/one"), DeclaredTurn::Busy);
        assert_eq!(declared_turn(&live, Some("b"), "/w/two"), DeclaredTurn::Busy);
    }
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

    /// The id becomes a file name. A traversal in it would write a `.jsonl`
    /// anywhere the app can reach.
    #[test]
    fn an_id_that_is_not_an_id_is_refused() {
        for junk in ["", "../../evil", "a/b", "a\\b", "a.jsonl"] {
            assert!(
                migrate_session_blocking("claude", junk, "/w/from", "/w/to").is_err(),
                "{junk}"
            );
        }
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
