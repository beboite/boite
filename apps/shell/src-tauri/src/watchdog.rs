//! What the main thread is doing, and a watchdog that notices when it stops
//! answering. A synchronous `#[tauri::command]` runs on the main thread inside
//! the invoke handler, so the handler wrapper in `lib.rs` names the command in
//! a shared slot while it runs; window and WebView events leave their name in
//! another. When the main thread goes quiet, the watchdog reads both: the
//! window going "Not responding" then has a cause in `shell.N.ndjson`.
//!
//! An episode that does not end writes `still-blocked` lines on a widening
//! schedule, so a shell Windows kills at shutdown still leaves how long it hung.
//! On Windows, past 30 s with the window reported hung, the watchdog also
//! writes a minidump of the process for the main thread's stack.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Runtime};

use crate::platform;
use crate::shell_log::{self, seconds, Level};

/// A command this long on the main thread is worth a `debug` line.
const SLOW_COMMAND: Duration = Duration::from_millis(250);
/// And this long, a `warn`: the window stopped painting for that time.
const STALLED_COMMAND: Duration = Duration::from_secs(2);
/// How often the watchdog posts its no-op to the main thread.
const PING_EVERY: Duration = Duration::from_secs(1);
/// How long the main thread may leave a ping unanswered before it counts as blocked.
const BLOCKED_AFTER: Duration = Duration::from_secs(5);
/// When an open episode writes its first `still-blocked` lines, from its start;
/// after the last one, every [`STILL_BLOCKED_EVERY`].
const STILL_BLOCKED_AT: [Duration; 3] = [Duration::from_secs(30), Duration::from_secs(120), Duration::from_secs(600)];
const STILL_BLOCKED_EVERY: Duration = Duration::from_secs(30 * 60);
/// Hang dumps kept in the log directory, the one just written included.
const KEEP_DUMPS: usize = 2;
const DUMP_PREFIX: &str = "shell-hang-";
const DUMP_SUFFIX: &str = ".dmp";

static START: OnceLock<Instant> = OnceLock::new();
static COMMANDS: OnceLock<Vec<&'static str>> = OnceLock::new();
/// `(index + 1) << 48 | started ms`, so a reader never pairs one command with
/// another's start. 0 when no command runs.
static COMMAND: AtomicU64 = AtomicU64::new(0);
/// The packed value of every command still running, oldest first. Invokes can
/// overlap (several windows, plugins) and end in any order, so the slot always
/// names the newest one still running rather than whatever a finished one saw.
static RUNNING: Mutex<Vec<u64>> = Mutex::new(Vec::new());
/// The same packing for the last window or WebView event.
static EVENT: AtomicU64 = AtomicU64::new(0);
/// The last ping the main thread ran, and when.
static ANSWERED_SEQ: AtomicU64 = AtomicU64::new(0);
static ANSWERED_AT: AtomicU64 = AtomicU64::new(0);

const TIME_BITS: u32 = 48;
const TIME_MASK: u64 = (1 << TIME_BITS) - 1;
/// An index no registered command has, read back as "other".
const OTHER_COMMAND: usize = 0xFFFE;

fn since_start() -> u64 { START.get_or_init(Instant::now).elapsed().as_millis() as u64 & TIME_MASK }
fn pack(index: usize, at: u64) -> u64 { ((index as u64 + 1) << TIME_BITS) | (at & TIME_MASK) }
fn unpack(value: u64) -> Option<(usize, u64)> {
    let index = value >> TIME_BITS;
    (index > 0).then(|| ((index - 1) as usize, value & TIME_MASK))
}

/// `local_core :: core_endpoint` as `stringify!` writes it, to the name the UI invokes.
fn command_name(path: &'static str) -> &'static str { path.rsplit("::").next().unwrap_or(path).trim() }

/// The registered commands, from the list `lib.rs` hands Tauri.
pub(crate) fn register_commands(paths: &[&'static str]) {
    START.get_or_init(Instant::now);
    let _ = COMMANDS.set(paths.iter().copied().map(command_name).collect());
}

/// While alive, the slot names this command. Dropping it records a slow one.
pub(crate) struct Running { index: Option<usize>, started: Instant, packed: u64 }

/// Called by the invoke handler before Tauri dispatches `name`. A name that is
/// not one of ours (a plugin's) is timed under "other".
pub(crate) fn begin(name: &str) -> Running {
    let index = COMMANDS.get().and_then(|names| names.iter().position(|known| *known == name));
    let packed = pack(index.unwrap_or(OTHER_COMMAND), since_start());
    {
        let mut running = RUNNING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        running.push(packed);
        COMMAND.store(packed, Ordering::Release);
    }
    Running { index, started: Instant::now(), packed }
}

fn name_at(index: usize) -> &'static str {
    COMMANDS.get().and_then(|names| names.get(index).copied()).unwrap_or("other")
}

impl Drop for Running {
    fn drop(&mut self) {
        {
            let mut running = RUNNING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(at) = running.iter().rposition(|value| *value == self.packed) { running.remove(at); }
            COMMAND.store(running.last().copied().unwrap_or(0), Ordering::Release);
        }
        let took = self.started.elapsed();
        if took < SLOW_COMMAND { return; }
        let command = self.index.map(name_at).unwrap_or("other");
        let level = if took >= STALLED_COMMAND { Level::Warn } else { Level::Debug };
        shell_log::timed(level, "ipc", "shell.command.slow",
            format!("command {command} held the main thread for {} ms", took.as_millis()),
            took, json!({ "command": command }));
    }
}

/// The window and WebView events the watchdog can name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Seen {
    Focused, Blurred, Resized, Moved, ScaleChanged, CloseRequested, Minimized,
    Shown, Hidden, PageLoadStarted, PageLoadFinished, TrayEvent, MenuEvent, ThemeChanged, Other,
}

const SEEN: [Seen; 15] = [
    Seen::Focused, Seen::Blurred, Seen::Resized, Seen::Moved, Seen::ScaleChanged, Seen::CloseRequested, Seen::Minimized,
    Seen::Shown, Seen::Hidden, Seen::PageLoadStarted, Seen::PageLoadFinished, Seen::TrayEvent, Seen::MenuEvent, Seen::ThemeChanged, Seen::Other,
];

impl Seen {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Seen::Focused => "window.focused",
            Seen::Blurred => "window.blurred",
            Seen::Resized => "window.resized",
            Seen::Moved => "window.moved",
            Seen::ScaleChanged => "window.scale-changed",
            Seen::CloseRequested => "window.close-requested",
            Seen::Minimized => "window.minimized",
            Seen::Shown => "window.shown",
            Seen::Hidden => "window.hidden",
            Seen::PageLoadStarted => "webview.page-load-started",
            Seen::PageLoadFinished => "webview.page-load-finished",
            Seen::TrayEvent => "tray.event",
            Seen::MenuEvent => "tray.menu",
            Seen::ThemeChanged => "window.theme-changed",
            Seen::Other => "other",
        }
    }
}

/// Notes the event the main thread is handling. One atomic store, no allocation.
pub(crate) fn saw(event: Seen) {
    let index = SEEN.iter().position(|known| *known == event).unwrap_or(SEEN.len() - 1);
    EVENT.store(pack(index, since_start()), Ordering::Release);
}

/// What the main thread was busy with, read by the watchdog while it is blocked.
#[derive(Debug, PartialEq, Eq)]
struct Blame {
    /// The running command and how long it has run.
    command: Option<(&'static str, u64)>,
    /// The last event and how long ago it came.
    event: Option<(&'static str, u64)>,
}

fn blame(now: u64) -> Blame {
    let command = unpack(COMMAND.load(Ordering::Acquire))
        .map(|(index, at)| (name_at(index), now.saturating_sub(at)));
    let event = unpack(EVENT.load(Ordering::Acquire))
        .map(|(index, at)| (SEEN.get(index).copied().unwrap_or(Seen::Other).name(), now.saturating_sub(at)));
    Blame { command, event }
}

/// `lead` is "main thread blocked for" on the first line of an episode and
/// "main thread still blocked after" on the later ones.
fn blocked_message(lead: &str, blocked: Duration, blame: &Blame) -> String {
    let ms = |value: u64| seconds(Duration::from_millis(value));
    match (blame.command, blame.event) {
        (Some((command, running)), _) => format!(
            "{lead} {}, command {command} started {} ago and has not returned", seconds(blocked), ms(running)),
        (None, Some((event, ago))) => format!(
            "{lead} {} with no command running; the last window event was {event} {} ago", seconds(blocked), ms(ago)),
        (None, None) => format!("{lead} {} with no command running and no window event seen yet", seconds(blocked)),
    }
}

/// How long after an episode began its `line`th `still-blocked` record is due,
/// counting from 0: 30 s, 2 min, 10 min, then every 30 min.
fn still_blocked_due(line: u32) -> Duration {
    match STILL_BLOCKED_AT.get(line as usize) {
        Some(due) => *due,
        None => STILL_BLOCKED_AT[STILL_BLOCKED_AT.len() - 1]
            + STILL_BLOCKED_EVERY * (line - STILL_BLOCKED_AT.len() as u32 + 1),
    }
}

/// One episode of a main thread that stopped answering.
struct Episode { since: Instant, command: &'static str, still_blocked_lines: u32 }

/// The watchdog's state between ticks, apart from the thread, so a test can
/// drive it with made-up instants.
struct Watch { seq: u64, posted: Option<(u64, Instant)>, episode: Option<Episode> }

enum Verdict { Nothing, Blocked(Duration, Blame), StillBlocked(Duration, Blame), Recovered(Duration, &'static str) }

impl Watch {
    fn new() -> Self { Self { seq: 0, posted: None, episode: None } }

    /// Looks at the ping in flight. `answered` is the last sequence the main
    /// thread ran and when, as an `Instant`.
    fn tick(&mut self, now: Instant, answered: (u64, Option<Instant>), read_blame: impl FnOnce() -> Blame) -> Verdict {
        let Some((seq, posted)) = self.posted else { return Verdict::Nothing };
        if answered.0 >= seq {
            self.posted = None;
            return match self.episode.take() {
                Some(episode) => {
                    let at = answered.1.unwrap_or(now).max(episode.since);
                    Verdict::Recovered(at.duration_since(episode.since), episode.command)
                }
                None => Verdict::Nothing,
            };
        }
        if let Some(episode) = self.episode.as_mut() {
            let blocked = now.saturating_duration_since(episode.since);
            if blocked < still_blocked_due(episode.still_blocked_lines) { return Verdict::Nothing; }
            // A late tick can pass several marks at once: one line, and the next mark is ahead.
            while still_blocked_due(episode.still_blocked_lines) <= blocked { episode.still_blocked_lines += 1; }
            return Verdict::StillBlocked(blocked, read_blame());
        }
        let waited = now.saturating_duration_since(posted);
        if waited < BLOCKED_AFTER { return Verdict::Nothing; }
        let blame = read_blame();
        self.episode = Some(Episode {
            since: posted, command: blame.command.map(|(name, _)| name).unwrap_or("no command"), still_blocked_lines: 0,
        });
        Verdict::Blocked(waited, blame)
    }

    /// The watchdog itself slept `slept` past its tick: the machine was
    /// suspended, and a ping in flight across the suspend says nothing about
    /// the main thread. An episode already reported moves its start forward
    /// by the same time, so its recovery does not count the suspend.
    fn rebase(&mut self, now: Instant, slept: Duration) {
        match self.episode.as_mut() {
            Some(episode) => episode.since = (episode.since + slept).min(now),
            None => if let Some((_, posted)) = self.posted.as_mut() { *posted = now; },
        }
    }

    /// The next ping's sequence, unless one is still in flight: a blocked
    /// thread would only pile them up.
    fn next_ping(&mut self, now: Instant) -> Option<u64> {
        if self.posted.is_some() { return None; }
        self.seq += 1;
        self.posted = Some((self.seq, now));
        Some(self.seq)
    }
}

/// The child windows of other processes under one process's window: on
/// Windows, WebView2's browser process owns the page's window inside the shell's.
#[derive(Debug, PartialEq, Eq)]
struct ForeignChild { pid: u32, windows: u32, hung: u32 }

/// `(pid, hung)` per child window, grouped by process in the order first seen.
fn group_children(windows: &[(u32, bool)]) -> Vec<ForeignChild> {
    let mut grouped: Vec<ForeignChild> = Vec::new();
    for &(pid, hung) in windows {
        let at = match grouped.iter().position(|child| child.pid == pid) {
            Some(at) => at,
            None => { grouped.push(ForeignChild { pid, windows: 0, hung: 0 }); grouped.len() - 1 }
        };
        grouped[at].windows += 1;
        grouped[at].hung += u32::from(hung);
    }
    grouped
}

/// `8812 not responding, 9020 responding`: a process counts as not responding
/// when one of its windows is.
fn describe_children(children: &[ForeignChild]) -> String {
    children.iter()
        .map(|child| format!("{} {}", child.pid, if child.hung > 0 { "not responding" } else { "responding" }))
        .collect::<Vec<_>>().join(", ")
}

/// The fields and message every blocked and still-blocked line carries.
fn describe(lead: &str, blocked: Duration, blame: &Blame, hung: Option<bool>) -> (String, serde_json::Value) {
    let mut data = json!({
        "blockedMs": blocked.as_millis() as u64,
        "command": blame.command.map(|(name, _)| name).unwrap_or("no command"),
    });
    if let Some((_, running)) = blame.command { data["commandRunningMs"] = json!(running); }
    if let Some((event, ago)) = blame.event { data["lastEvent"] = json!(event); data["lastEventAgoMs"] = json!(ago); }
    if let Some(hung) = hung { data["windowsReportsHung"] = json!(hung); }
    if let Some(thread) = platform::watch::main_thread_id() { data["mainThreadId"] = json!(thread); }
    let mut message = blocked_message(lead, blocked, blame);
    if hung == Some(true) { message.push_str("; Windows reports the window as not responding"); }
    (message, data)
}

/// `shell-hang-20261014T153012Z.dmp`, UTC to the second: fixed width, so names
/// sort in time order.
fn dump_name(unix_ms: u64) -> String {
    let secs = unix_ms / 1000;
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    // Howard Hinnant's days-to-civil conversion.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{DUMP_PREFIX}{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z{DUMP_SUFFIX}", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// The hang dumps among `names` beyond the `keep` newest, which go.
fn dumps_to_delete(names: impl IntoIterator<Item = String>, keep: usize) -> Vec<String> {
    let mut dumps: Vec<String> = names.into_iter()
        .filter(|name| name.starts_with(DUMP_PREFIX) && name.ends_with(DUMP_SUFFIX)).collect();
    dumps.sort_unstable_by(|a, b| b.cmp(a));
    dumps.split_off(keep.min(dumps.len()))
}

fn prune_dumps(directory: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else { return };
    let names = entries.filter_map(|entry| entry.ok()?.file_name().into_string().ok());
    for name in dumps_to_delete(names, KEEP_DUMPS) { let _ = std::fs::remove_file(directory.join(name)); }
}

/// One dump per run.
static DUMPED: AtomicBool = AtomicBool::new(false);

/// Writes a minidump of this process from a thread of its own, so a dump that
/// stalls never stops the still-blocked lines. Returns the path it writes to.
fn start_dump() -> Option<PathBuf> {
    let directory = shell_log::directory()?;
    if DUMPED.swap(true, Ordering::AcqRel) { return None; }
    let path = directory.join(dump_name(shell_log::unix_ms()));
    let target = path.clone();
    let spawned = std::thread::Builder::new().name("shell-hang-dump".into()).spawn(move || {
        let started = Instant::now();
        let thread = platform::watch::main_thread_id();
        match platform::watch::write_dump(&target) {
            Ok(bytes) => {
                prune_dumps(directory);
                let mut data = json!({ "path": target.display().to_string(), "bytes": bytes });
                if let Some(thread) = thread { data["mainThreadId"] = json!(thread); }
                shell_log::timed(Level::Warn, "main-thread", "shell.main-thread.dumped",
                    format!("wrote a dump of the hung shell to {} ({} MB); the main thread is thread {}",
                        target.display(), bytes / (1024 * 1024), thread.map(|id| id.to_string()).unwrap_or_else(|| "unknown".into())),
                    started.elapsed(), data);
            }
            Err(error) => {
                let _ = std::fs::remove_file(&target);
                shell_log::warn("main-thread", "shell.main-thread.dump-failed",
                    format!("the hang dump could not be written: {error}"), json!({ "path": target.display().to_string() }));
            }
        }
        shell_log::flush(Duration::from_millis(500));
    });
    match spawned {
        Ok(_) => Some(path),
        Err(error) => {
            shell_log::warn("main-thread", "shell.main-thread.dump-failed",
                format!("the hang dump thread could not start: {error}"), json!({}));
            None
        }
    }
}

/// A still-blocked line: the episode's duration, the same blame, the windows
/// of other processes inside the main window and, once Windows calls the
/// window hung, the dump's path.
fn still_blocked(blocked: Duration, blame: &Blame) {
    let hung = platform::watch::main_window_hung();
    let (mut message, mut data) = describe("main thread still blocked after", blocked, blame, hung);
    if let Some(windows) = platform::watch::foreign_child_windows() {
        let children = group_children(&windows);
        data["foreignWindows"] = json!(windows.len());
        data["foreignHungWindows"] = json!(windows.iter().filter(|(_, hung)| *hung).count());
        if !children.is_empty() {
            let described = describe_children(&children);
            message.push_str(&format!("; processes with windows inside it: {described}"));
            data["foreignProcesses"] = json!(described);
        }
    }
    if hung == Some(true) {
        if let Some(path) = start_dump() {
            message.push_str(&format!("; writing a dump to {}", path.display()));
            data["dumpPath"] = json!(path.display().to_string());
        }
    }
    shell_log::error("main-thread", "shell.main-thread.still-blocked", message, data);
    shell_log::flush(Duration::from_millis(500));
}

/// Starts the watchdog thread. On Windows it also asks whether Windows
/// considers the main window hung; elsewhere that answer is absent.
pub(crate) fn start<R: Runtime>(app: AppHandle<R>) {
    let start = *START.get_or_init(Instant::now);
    let spawned = std::thread::Builder::new().name("shell-watchdog".into()).spawn(move || {
        let mut watch = Watch::new();
        let mut last_tick = Instant::now();
        loop {
            std::thread::sleep(PING_EVERY);
            let now = Instant::now();
            let gap = now.saturating_duration_since(last_tick);
            if gap > PING_EVERY * 3 { watch.rebase(now, gap - PING_EVERY); }
            last_tick = now;
            let seq = ANSWERED_SEQ.load(Ordering::Acquire);
            let at = start + Duration::from_millis(ANSWERED_AT.load(Ordering::Acquire));
            let answered = (seq, (seq > 0).then_some(at));
            match watch.tick(now, answered, || blame(since_start())) {
                Verdict::Nothing => {}
                Verdict::Blocked(waited, blame) => {
                    let (message, data) = describe("main thread blocked for", waited, &blame, platform::watch::main_window_hung());
                    shell_log::error("main-thread", "shell.main-thread.blocked", message, data);
                    shell_log::flush(Duration::from_millis(500));
                }
                Verdict::StillBlocked(blocked, blame) => still_blocked(blocked, &blame),
                Verdict::Recovered(total, command) => {
                    shell_log::timed(Level::Warn, "main-thread", "shell.main-thread.recovered",
                        format!("main thread answered again after being blocked for {} (command: {command})", seconds(total)),
                        total, json!({ "blockedMs": total.as_millis() as u64, "command": command }));
                }
            }
            if let Some(seq) = watch.next_ping(now) {
                let posted = app.run_on_main_thread(move || {
                    ANSWERED_AT.store(start.elapsed().as_millis() as u64, Ordering::Release);
                    ANSWERED_SEQ.store(seq, Ordering::Release);
                });
                // The event loop is gone: the app is exiting.
                if posted.is_err() { break; }
            }
        }
    });
    if let Err(error) = spawned {
        shell_log::warn("main-thread", "shell.watchdog.unavailable",
            format!("the main-thread watchdog could not start: {error}"), json!({}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle() -> Blame { Blame { command: None, event: Some(("window.resized", 7200)) } }

    #[test]
    fn a_blocked_main_thread_is_one_record_per_episode_then_one_recovery() {
        let mut watch = Watch::new();
        let t0 = Instant::now();
        let at = |seconds: u64| t0 + Duration::from_secs(seconds);
        assert_eq!(watch.next_ping(t0), Some(1));
        // Answered in time: nothing to say.
        assert!(matches!(watch.tick(at(1), (1, Some(t0)), idle), Verdict::Nothing));
        assert_eq!(watch.next_ping(at(1)), Some(2));
        for second in 2..6 { assert!(matches!(watch.tick(at(second), (1, Some(t0)), idle), Verdict::Nothing)); }
        assert_eq!(watch.next_ping(at(5)), None, "a ping in flight is not doubled");
        match watch.tick(at(6), (1, Some(t0)), idle) {
            Verdict::Blocked(waited, blame) => { assert_eq!(waited, Duration::from_secs(5)); assert_eq!(blame, idle()); }
            _ => panic!("expected a blocked verdict"),
        }
        for second in 7..12 { assert!(matches!(watch.tick(at(second), (1, Some(t0)), idle), Verdict::Nothing)); }
        match watch.tick(at(13), (2, Some(at(12) + Duration::from_millis(400))), idle) {
            Verdict::Recovered(total, command) => { assert_eq!(total, Duration::from_millis(11_400)); assert_eq!(command, "no command"); }
            _ => panic!("expected a recovery"),
        }
        assert_eq!(watch.next_ping(at(13)), Some(3));
    }

    #[test]
    fn an_open_episode_writes_still_blocked_lines_at_30_s_2_min_10_min_then_every_30_min() {
        let due: Vec<u64> = (0..6).map(|line| still_blocked_due(line).as_secs()).collect();
        assert_eq!(due, [30, 120, 600, 2400, 4200, 6000]);
        let mut watch = Watch::new();
        let t0 = Instant::now();
        let at = |seconds: u64| t0 + Duration::from_secs(seconds);
        assert_eq!(watch.next_ping(t0), Some(1));
        assert!(matches!(watch.tick(at(5), (0, None), idle), Verdict::Blocked(..)));
        let mut lines = Vec::new();
        for second in 6..=2400 {
            if let Verdict::StillBlocked(blocked, blame) = watch.tick(at(second), (0, None), idle) {
                assert_eq!(blame, idle());
                lines.push(blocked.as_secs());
            }
        }
        assert_eq!(lines, [30, 120, 600, 2400]);
        // A tick that jumps past two marks writes one line, and the next mark is still ahead.
        assert!(matches!(watch.tick(at(6100), (0, None), idle), Verdict::StillBlocked(..)));
        assert!(matches!(watch.tick(at(7700), (0, None), idle), Verdict::Nothing));
        assert!(matches!(watch.tick(at(7800), (0, None), idle), Verdict::StillBlocked(..)));
        match watch.tick(at(7801), (1, Some(at(7800) + Duration::from_millis(500))), idle) {
            Verdict::Recovered(total, command) => { assert_eq!(total, Duration::from_millis(7_800_500)); assert_eq!(command, "no command"); }
            _ => panic!("expected a recovery"),
        }
    }

    #[test]
    fn dumps_are_named_by_utc_time_and_only_the_two_newest_stay() {
        assert_eq!(dump_name(0), "shell-hang-19700101T000000Z.dmp");
        assert_eq!(dump_name(951_782_400_000), "shell-hang-20000229T000000Z.dmp");
        assert_eq!(dump_name(1_791_991_812_345), "shell-hang-20261014T153012Z.dmp");
        let names = ["shell-hang-20261012T080000Z.dmp", "shell.0.ndjson", "shell-hang-20261014T153012Z.dmp",
            "shell-hang-20261001T000000Z.dmp", "shell-hang-notes.txt", "shell-hang-20261013T235959Z.dmp"];
        let gone = dumps_to_delete(names.iter().map(|name| name.to_string()), KEEP_DUMPS);
        assert_eq!(gone, ["shell-hang-20261012T080000Z.dmp", "shell-hang-20261001T000000Z.dmp"]);
        assert!(dumps_to_delete(["shell-hang-20261014T153012Z.dmp".to_string()], KEEP_DUMPS).is_empty());
    }

    #[test]
    fn child_windows_group_by_process_and_a_process_with_one_hung_window_is_not_responding() {
        let children = group_children(&[(8812, false), (9020, false), (8812, true)]);
        assert_eq!(children, [ForeignChild { pid: 8812, windows: 2, hung: 1 }, ForeignChild { pid: 9020, windows: 1, hung: 0 }]);
        assert_eq!(describe_children(&children), "8812 not responding, 9020 responding");
    }

    #[test]
    fn a_suspend_with_a_ping_in_flight_is_not_a_blocked_main_thread() {
        let mut watch = Watch::new();
        let t0 = Instant::now();
        assert_eq!(watch.next_ping(t0), Some(1));
        let resumed = t0 + Duration::from_secs(600);
        watch.rebase(resumed, Duration::from_secs(599));
        assert!(matches!(watch.tick(resumed + Duration::from_secs(1), (0, None), idle), Verdict::Nothing));
        assert!(matches!(watch.tick(resumed + Duration::from_secs(5), (0, None), idle), Verdict::Blocked(..)));
        // Still blocked across a second suspend: the recovery leaves the suspend out.
        let asleep = resumed + Duration::from_secs(6);
        let woke = asleep + Duration::from_secs(300);
        watch.rebase(woke, Duration::from_secs(300));
        match watch.tick(woke + Duration::from_secs(2), (1, Some(woke + Duration::from_secs(1))), idle) {
            Verdict::Recovered(total, _) => assert_eq!(total, Duration::from_secs(7)),
            _ => panic!("expected a recovery"),
        }
    }

    #[test]
    fn the_message_names_the_running_command_or_the_last_event() {
        let busy = Blame { command: Some(("browser_create", 6400)), event: Some(("window.focused", 9000)) };
        assert_eq!(blocked_message("main thread blocked for", Duration::from_millis(6200), &busy),
            "main thread blocked for 6.2 s, command browser_create started 6.4 s ago and has not returned");
        assert_eq!(blocked_message("main thread blocked for", Duration::from_secs(5), &idle()),
            "main thread blocked for 5.0 s with no command running; the last window event was window.resized 7.2 s ago");
    }

    #[test]
    fn the_slot_names_the_command_while_it_runs_and_clears_after() {
        register_commands(&["local_core :: core_endpoint", "notify", "window :: shell_ready"]);
        assert_eq!(COMMANDS.get().unwrap()[0], "core_endpoint");
        {
            let _running = begin("shell_ready");
            let now = since_start();
            assert_eq!(blame(now).command.map(|(name, _)| name), Some("shell_ready"));
        }
        assert_eq!(blame(since_start()).command, None);
        // Overlapping invokes that end out of order: the slot keeps the one still running.
        let first = begin("notify");
        let second = begin("shell_ready");
        drop(first);
        assert_eq!(blame(since_start()).command.map(|(name, _)| name), Some("shell_ready"));
        let third = begin("notify");
        drop(second);
        assert_eq!(blame(since_start()).command.map(|(name, _)| name), Some("notify"));
        drop(third);
        assert_eq!(blame(since_start()).command, None);
        saw(Seen::ScaleChanged);
        assert_eq!(blame(since_start()).event.map(|(name, _)| name), Some("window.scale-changed"));
    }
}
