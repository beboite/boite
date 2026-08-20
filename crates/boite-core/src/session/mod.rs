//! What the agents left on disk, read back.
//!
//! Every coding agent keeps its own record of a conversation somewhere on the
//! machine, in its own format, under its own idea of where a project lives.
//! Boite reads nine of them so a terminal can come back on the session it was
//! on, and so the sidebar can say what each agent is doing right now.
//!
//! One file per store, because they have nothing in common but the questions
//! asked of them:
//!
//! - [`claude`] is the only one Boite can also *drive*: it holds a live
//!   registry with pids in it, so a session can be stopped and a transcript can
//!   be carried to a new folder.
//! - [`codex`] keeps a rollout log, which is what its turn state is read from.
//! - [`opencode`] keeps a sqlite database of messages.
//! - [`editors`] is the six that Boite can only ever read for *which*
//!   conversation: copilot, cursor, antigravity, grok, hermes and pi. Grok is
//!   the exception on the turn: its `updates.jsonl` brackets one the way a
//!   codex rollout does, so it also contributes to the sidebar's activity
//!   dot. The other five still do not.
//!
//! What stays here is what more than one of them needs, and the vocabulary they
//! all answer in: [`SessionHit`], [`AgentTurn`], [`TurnQuery`],
//! [`DeclaredTurn`]. The submodules can see it because a private item in a
//! parent module is visible to its descendants, which is why this split is a
//! move rather than a rewrite.
//!
//! Nothing here decides *which* session a thread should resume. That is
//! `command::sessions`, which takes the hit and compares it against what the
//! caller already holds.

pub mod claude;
mod codex;
mod editors;
mod opencode;
mod shared;

pub use claude::{
    find_claude_session_blocking, live_claude_sessions, stop_claude_session,
    ClaudeSessionHit, LiveClaudeSession,
};
pub use codex::{find_codex_session_blocking, CodexSessionHit};
pub use editors::{
    copilot_session_resumable, find_antigravity_session_blocking,
    find_copilot_session_blocking, find_cursor_session_blocking,
    find_grok_session_blocking, find_hermes_session_blocking, find_pi_session_blocking,
};
pub use opencode::find_opencode_session_blocking;
pub use shared::{share_session_stores, unshare_session_stores};
pub(crate) use editors::{grok_dir_name, grok_sessions_dir};

use std::collections::HashSet;

use std::env;

use std::ffi::OsStr;

use std::fs;

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

use std::path::{Path, PathBuf};

use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OpenFlags};

use serde::{Deserialize, Serialize};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
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

/// Every process on the machine mapped to its parent, read once.
///
/// One pass rather than one lookup per hop: the answer is only ever used to walk
/// a handful of chains, and each of the three platforms pays for the enumeration
/// and not for the walk.
#[cfg(windows)]
fn process_parents() -> std::collections::HashMap<u32, u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = std::collections::HashMap::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                out.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    out
}

#[cfg(target_os = "linux")]
fn process_parents() -> std::collections::HashMap<u32, u32> {
    let mut out = std::collections::HashMap::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        // The command name sits in parentheses and may itself contain spaces and
        // parentheses, so the fields are counted from the last `)` rather than
        // from the start: state, then ppid.
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        let _state = fields.next();
        if let Some(ppid) = fields.next().and_then(|s| s.parse::<u32>().ok()) {
            out.insert(pid, ppid);
        }
    }
    out
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_parents() -> std::collections::HashMap<u32, u32> {
    let mut out = std::collections::HashMap::new();
    // No /proc on macOS, and the sysctl form needs a per-process call anyway.
    // One `ps` is the cheaper of the two and needs no unsafe block.
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
    else {
        return out;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        if let (Some(pid), Some(ppid)) = (fields.next(), fields.next()) {
            if let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) {
                out.insert(pid, ppid);
            }
        }
    }
    out
}

/// The processes a PTY is responsible for: the one it spawned, and everything
/// that one started.
///
/// A thread's agent is not always the process the PTY spawned. `fastpick` picks
/// a harness and then *runs* it, so a fastpick thread's claude is a grandchild;
/// a wrap shell adds another level. Comparing pids alone therefore answered "not
/// ours" for every launcher-started agent, and the one place that matters is
/// session capture: the thread's own live session was filtered out as somebody
/// else's, never captured, and the relaunch had no id to resume. Every fastpick
/// thread in the database had an empty `session_id`, which is what that looks
/// like from the outside.
pub(super) struct ProcessTree {
    root: u32,
    parents: std::collections::HashMap<u32, u32>,
}

impl ProcessTree {
    pub(super) fn rooted_at(root: u32) -> Self {
        Self {
            root,
            parents: process_parents(),
        }
    }

    /// Whether `pid` is the root or one of its descendants.
    ///
    /// Bounded: a parent map read while processes come and go can name a pid
    /// that has already been recycled onto a different one, and an unbounded
    /// walk over a cycle built that way would never return.
    pub(super) fn contains(&self, pid: u32) -> bool {
        let mut current = pid;
        for _ in 0..16 {
            if current == self.root {
                return true;
            }
            match self.parents.get(&current) {
                // pid 0 is the idle process on Windows and the reaper's parent
                // on unix: either way it is the top, not another hop.
                Some(&parent) if parent != 0 && parent != current => current = parent,
                _ => return false,
            }
        }
        false
    }

    #[cfg(test)]
    fn from_parents(root: u32, parents: &[(u32, u32)]) -> Self {
        Self {
            root,
            parents: parents.iter().copied().collect(),
        }
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

/// What one agent says about one of its sessions, in the one shape every agent is
/// reduced to before anything downstream looks at it.
///
/// The agents disagree wildly on where this lives: claude writes a registry file
/// per process, codex only leaves markers in the transcript it appends, opencode
/// only records it in a SQLite row, grok appends ACP session updates to a
/// jsonl. Reading each one is a per-agent job; deciding what a thread's dot
/// should say is not, so they meet here.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurn {
    /// The agent that said it, matching Boite's icon keys.
    pub kind: String,
    pub session_id: String,
    /// As the agent recorded it. Callers normalise before comparing.
    pub cwd: String,
    /// `busy`, `waiting`, `shell` or `idle`. Only claude ever says the middle two.
    pub state: String,
    /// Claude's own label for what it is blocked on. Never set by the others.
    pub waiting_for: Option<String>,
}

/// A thread Boite wants an answer for. Reading these stores is not free, so the
/// caller says which threads it actually has rather than having every agent's
/// whole history enumerated on a timer.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnQuery {
    pub kind: String,
    pub session_id: Option<String>,
    pub cwd: String,
}

impl TurnQuery {
    fn id(&self) -> Option<&str> {
        self.session_id.as_deref().filter(|id| !id.is_empty())
    }
}

/// Places a thread among what the agents said, and reads its turn off that.
///
/// Same rule whatever the agent. By id when the thread has captured one: that is
/// the precise question, and a miss answers `Unknown` rather than falling back to
/// the directory. An id that is not there means the agent is not holding that
/// session (it exited, or it predates whatever records this), and a neighbour's
/// state must not stand in for it.
///
/// By directory otherwise, and only when exactly one live session claims it. The
/// window before a session id is captured is a few seconds of the agent's first
/// turn, which is routinely its longest, so leaving it unanswerable is how a
/// thread gets called idle while a subagent works. Two sessions in one directory
/// answers `Unknown`: with per-thread worktrees that does not normally happen,
/// and guessing between them would light or sleep the wrong thread.
///
/// `kind` scopes the search before any of that. Two agents in one directory is
/// ordinary, and a codex thread has no business being handed a claude answer.
pub fn declared_turn(
    turns: &[AgentTurn],
    kind: &str,
    session_id: Option<&str>,
    cwd: &str,
) -> DeclaredTurn {
    let read = |t: &AgentTurn| match t.state.as_str() {
        "idle" => DeclaredTurn::Idle,
        "waiting" => DeclaredTurn::Waiting,
        "shell" => DeclaredTurn::Shell,
        // `busy`, and anything else. An unset or unrecognised state comes from an
        // agent whose format this does not know, and calling that finished is the
        // one wrong answer that loses work to auto-sleep.
        _ => DeclaredTurn::Busy,
    };
    let mine = || turns.iter().filter(|t| t.kind == kind);
    if let Some(id) = session_id.filter(|id| !id.is_empty()) {
        return match mine().find(|t| t.session_id == id) {
            Some(t) => read(t),
            None => DeclaredTurn::Unknown,
        };
    }
    if cwd.is_empty() {
        return DeclaredTurn::Unknown;
    }
    let want = normalize(cwd);
    let mut found = None;
    // A session that recorded no cwd is placeable by nobody. Without the guard a
    // query for `/` normalises to the empty string and matches every one of them.
    for t in mine().filter(|t| !t.cwd.is_empty() && normalize(&t.cwd) == want) {
        if found.is_some() {
            return DeclaredTurn::Unknown;
        }
        found = Some(t);
    }
    found.map(read).unwrap_or(DeclaredTurn::Unknown)
}

/// Everything the agents behind these threads say about themselves right now.
///
/// One pass per agent rather than one per thread: each of the four costs a
/// directory read or a database open, and doing that per thread on a timer is how
/// a status sweep turns into the most expensive thing in the app.
pub fn agent_turns(queries: &[TurnQuery]) -> Vec<AgentTurn> {
    let mut out = Vec::new();
    let has = |kind: &str| queries.iter().any(|q| q.kind == kind);
    if has("claude") {
        out.extend(live_claude_sessions().into_iter().filter_map(claude::claude_turn));
    }
    if has("codex") {
        out.extend(codex::codex_turns(queries));
    }
    if has("opencode") {
        out.extend(opencode::opencode_turns(queries));
    }
    if has("grok") {
        out.extend(editors::grok_turns(queries));
    }
    out
}

fn normalize(p: &str) -> String {
    p.replace('\\', "/")
        .trim_end_matches('/')
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

/// Whether this CLI files its transcripts under the directory it ran in.
///
/// Claude, grok and pi do. The others key their store by time (codex), by an
/// internal database (cursor, antigravity) or by a flat session list (opencode,
/// copilot, hermes), so a session of theirs resumes from anywhere and a move
/// has nothing to carry.
pub fn session_store_is_cwd_scoped(kind: &str) -> bool {
    matches!(kind, "claude" | "grok" | "pi")
}

/// Carries a transcript to the directory the thread is moving to, and answers
/// whether the conversation can be resumed from there.
///
/// Claude looks a session up in `~/.claude/projects/<encoded cwd>/`, grok in
/// `~/.grok/sessions/<encoded cwd>/`, pi in its encoded folder, so a thread
/// that changes project changes the directory those CLIs search and `--resume`
/// stops finding anything. Copying the transcript into the destination is what
/// keeps the conversation reachable from the new folder.
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
    if kind == "pi" {
        return editors::migrate_pi_transcript(session_id, from_cwd, to_cwd);
    }
    if kind == "grok" {
        return editors::migrate_grok_transcript(session_id, from_cwd, to_cwd);
    }
    let home = dirs::home_dir().ok_or("no home directory")?;
    claude::migrate_claude_transcript(
        &home.join(".claude").join("projects"),
        session_id,
        from_cwd,
        to_cwd,
    )
}

fn open_readonly(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
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

pub fn build_exclude(ids: Option<Vec<String>>) -> HashSet<String> {
    ids.unwrap_or_default().into_iter().collect()
}

/// One agent's answer about one session, for the tests below and for the ones
/// in the submodules.
///
/// A free function rather than a helper inside a test module, because every
/// store's tests build these and a copy per file is four copies of one shape.
#[cfg(test)]
pub(super) fn turn(kind: &str, id: &str, state: &str, cwd: &str) -> AgentTurn {
    AgentTurn {
        kind: kind.into(),
        session_id: id.into(),
        cwd: cwd.into(),
        state: state.into(),
        waiting_for: None,
    }
}

/// What claude's registry says about one session, for the tests here and in
/// `claude`.
#[cfg(test)]
pub(super) fn claude_said(id: &str, state: &str, cwd: &str) -> AgentTurn {
    turn("claude", id, state, cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_declared_state_maps_to_its_own_answer() {
        // The four claude writes, plus the catch-all. Collapsing waiting or shell
        // into idle is what let a thread be called finished while a permission
        // prompt sat unanswered, or while a shell it started still ran.
        let live = [
            claude_said("busy", "busy", "/w/1"),
            claude_said("waiting", "waiting", "/w/2"),
            claude_said("shell", "shell", "/w/3"),
            claude_said("idle", "idle", "/w/4"),
        ];
        let ask = |id| declared_turn(&live, "claude", Some(id), "");
        assert_eq!(ask("busy"), DeclaredTurn::Busy);
        assert_eq!(ask("waiting"), DeclaredTurn::Waiting);
        assert_eq!(ask("shell"), DeclaredTurn::Shell);
        assert_eq!(ask("idle"), DeclaredTurn::Idle);
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
    fn an_unrecognised_state_is_treated_as_a_turn_in_flight() {
        // Calling a state we cannot read "finished" is what would let auto-sleep
        // kill a working PTY.
        let live = [claude_said("a", "starting", "/w/one"), claude_said("b", "", "/w/two")];
        assert_eq!(
            declared_turn(&live, "claude", Some("a"), "/w/one"),
            DeclaredTurn::Busy
        );
        assert_eq!(
            declared_turn(&live, "claude", Some("b"), "/w/two"),
            DeclaredTurn::Busy
        );
    }

    #[test]
    fn an_agent_is_never_handed_another_agents_answer() {
        // Two agents in one directory is ordinary, and both may be mid-turn. The
        // kind is checked before the id and before the directory, so neither the
        // id collision nor the shared folder can cross the wires.
        let live = [
            claude_said("shared", "busy", "/w/one"),
            turn("codex", "shared", "idle", "/w/one"),
            turn("grok", "g", "busy", "/w/one"),
        ];
        assert_eq!(
            declared_turn(&live, "claude", Some("shared"), "/w/one"),
            DeclaredTurn::Busy
        );
        assert_eq!(
            declared_turn(&live, "codex", Some("shared"), "/w/one"),
            DeclaredTurn::Idle
        );
        assert_eq!(
            declared_turn(&live, "grok", Some("g"), "/w/one"),
            DeclaredTurn::Busy
        );
        // By directory, each agent sees exactly one candidate rather than two.
        assert_eq!(
            declared_turn(&live, "claude", None, "/w/one"),
            DeclaredTurn::Busy
        );
        assert_eq!(
            declared_turn(&live, "codex", None, "/w/one"),
            DeclaredTurn::Idle
        );
        // An agent nobody reported stays unanswered rather than borrowing.
        assert_eq!(
            declared_turn(&live, "opencode", None, "/w/one"),
            DeclaredTurn::Unknown
        );
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

    /// The launcher case, which is what a fastpick thread is: the PTY spawned
    /// the shell, the shell spawned fastpick, fastpick spawned claude, and the
    /// session in the registry belongs to the last of the four.
    #[test]
    fn a_session_started_by_a_launcher_still_belongs_to_the_pty() {
        let tree = ProcessTree::from_parents(100, &[(200, 100), (300, 200), (400, 300)]);
        assert!(tree.contains(100), "the pty's own child");
        assert!(tree.contains(400), "claude, three hops down");
        // A claude in someone else's terminal is still someone else's.
        assert!(!tree.contains(999));
    }

    /// A parent map is read while processes come and go, so it can name a pid
    /// that has been recycled onto one of its own descendants. Walking that
    /// without a bound would never return, freezing every session scan.
    #[test]
    fn a_cycle_in_the_parent_map_does_not_hang_the_walk() {
        let tree = ProcessTree::from_parents(1, &[(10, 11), (11, 10)]);
        assert!(!tree.contains(10));
        // Its own parent, which is the shortest cycle there is.
        let tree = ProcessTree::from_parents(1, &[(10, 10)]);
        assert!(!tree.contains(10));
    }

    /// pid 0 is the idle process on Windows and the top of the chain on unix.
    /// Treating it as another hop would walk into whatever the map says about
    /// it, and a root of 0 would then own the entire machine.
    #[test]
    fn the_walk_stops_at_pid_zero() {
        let tree = ProcessTree::from_parents(0, &[(10, 0)]);
        assert!(!tree.contains(10));
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
