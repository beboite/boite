//! What the main thread is doing, and a watchdog that notices when it stops
//! answering. A synchronous `#[tauri::command]` runs on the main thread inside
//! the invoke handler, so the handler wrapper in `lib.rs` names the command in
//! a shared slot while it runs; window and WebView events leave their name in
//! another. When the main thread goes quiet, the watchdog reads both: the
//! window going "Not responding" then has a cause in `shell.N.ndjson`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Runtime};

use crate::shell_log::{self, seconds, Level};

/// A command this long on the main thread is worth a `debug` line.
const SLOW_COMMAND: Duration = Duration::from_millis(250);
/// And this long, a `warn`: the window stopped painting for that time.
const STALLED_COMMAND: Duration = Duration::from_secs(2);
/// How often the watchdog posts its no-op to the main thread.
const PING_EVERY: Duration = Duration::from_secs(1);
/// How long the main thread may leave a ping unanswered before it counts as blocked.
const BLOCKED_AFTER: Duration = Duration::from_secs(5);

static START: OnceLock<Instant> = OnceLock::new();
static COMMANDS: OnceLock<Vec<&'static str>> = OnceLock::new();
/// `(index + 1) << 48 | started ms`, so a reader never pairs one command with
/// another's start. 0 when no command runs.
static COMMAND: AtomicU64 = AtomicU64::new(0);
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
pub(crate) struct Running { index: Option<usize>, started: Instant, previous: u64 }

/// Called by the invoke handler before Tauri dispatches `name`. A name that is
/// not one of ours (a plugin's) is timed under "other".
pub(crate) fn begin(name: &str) -> Running {
    let index = COMMANDS.get().and_then(|names| names.iter().position(|known| *known == name));
    let previous = COMMAND.swap(pack(index.unwrap_or(OTHER_COMMAND), since_start()), Ordering::AcqRel);
    Running { index, started: Instant::now(), previous }
}

fn name_at(index: usize) -> &'static str {
    COMMANDS.get().and_then(|names| names.get(index).copied()).unwrap_or("other")
}

impl Drop for Running {
    fn drop(&mut self) {
        COMMAND.store(self.previous, Ordering::Release);
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

/// Notes the event the main thread is handling. Two atomic stores, no allocation.
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

fn blocked_message(blocked: Duration, blame: &Blame) -> String {
    let ms = |value: u64| seconds(Duration::from_millis(value));
    match (blame.command, blame.event) {
        (Some((command, running)), _) => format!(
            "main thread blocked for {}, command {command} started {} ago and has not returned", seconds(blocked), ms(running)),
        (None, Some((event, ago))) => format!(
            "main thread blocked for {} with no command running; the last window event was {event} {} ago", seconds(blocked), ms(ago)),
        (None, None) => format!("main thread blocked for {} with no command running and no window event seen yet", seconds(blocked)),
    }
}

/// One episode of a main thread that stopped answering.
struct Episode { since: Instant, command: &'static str }

/// The watchdog's state between ticks, apart from the thread, so a test can
/// drive it with made-up instants.
struct Watch { seq: u64, posted: Option<(u64, Instant)>, episode: Option<Episode> }

enum Verdict { Nothing, Blocked(Duration, Blame), Recovered(Duration, &'static str) }

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
        let waited = now.saturating_duration_since(posted);
        if waited < BLOCKED_AFTER || self.episode.is_some() { return Verdict::Nothing; }
        let blame = read_blame();
        self.episode = Some(Episode { since: posted, command: blame.command.map(|(name, _)| name).unwrap_or("no command") });
        Verdict::Blocked(waited, blame)
    }

    /// The watchdog itself slept far past its tick: the machine was suspended,
    /// and a ping in flight across the suspend says nothing about the main thread.
    fn rebase(&mut self, now: Instant) {
        if self.episode.is_none() {
            if let Some((_, posted)) = self.posted.as_mut() { *posted = now; }
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

/// Starts the watchdog thread. `hung` asks Windows whether it considers the
/// main window hung; it answers `None` elsewhere.
pub(crate) fn start<R: Runtime>(app: AppHandle<R>, hung: fn() -> Option<bool>) {
    let start = *START.get_or_init(Instant::now);
    let spawned = std::thread::Builder::new().name("shell-watchdog".into()).spawn(move || {
        let mut watch = Watch::new();
        let mut last_tick = Instant::now();
        loop {
            std::thread::sleep(PING_EVERY);
            let now = Instant::now();
            if now.saturating_duration_since(last_tick) > PING_EVERY * 3 { watch.rebase(now); }
            last_tick = now;
            let seq = ANSWERED_SEQ.load(Ordering::Acquire);
            let at = start + Duration::from_millis(ANSWERED_AT.load(Ordering::Acquire));
            let answered = (seq, (seq > 0).then_some(at));
            match watch.tick(now, answered, || blame(since_start())) {
                Verdict::Nothing => {}
                Verdict::Blocked(waited, blame) => {
                    let hung = hung();
                    let mut data = json!({
                        "blockedMs": waited.as_millis() as u64,
                        "command": blame.command.map(|(name, _)| name).unwrap_or("no command"),
                    });
                    if let Some((_, running)) = blame.command { data["commandRunningMs"] = json!(running); }
                    if let Some((event, ago)) = blame.event { data["lastEvent"] = json!(event); data["lastEventAgoMs"] = json!(ago); }
                    if let Some(hung) = hung { data["windowsReportsHung"] = json!(hung); }
                    let mut message = blocked_message(waited, &blame);
                    if hung == Some(true) { message.push_str("; Windows reports the window as not responding"); }
                    shell_log::error("main-thread", "shell.main-thread.blocked", message, data);
                    shell_log::flush(Duration::from_millis(500));
                }
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
    fn a_suspend_with_a_ping_in_flight_is_not_a_blocked_main_thread() {
        let mut watch = Watch::new();
        let t0 = Instant::now();
        assert_eq!(watch.next_ping(t0), Some(1));
        let resumed = t0 + Duration::from_secs(600);
        watch.rebase(resumed);
        assert!(matches!(watch.tick(resumed + Duration::from_secs(1), (0, None), idle), Verdict::Nothing));
        assert!(matches!(watch.tick(resumed + Duration::from_secs(5), (0, None), idle), Verdict::Blocked(..)));
    }

    #[test]
    fn the_message_names_the_running_command_or_the_last_event() {
        let busy = Blame { command: Some(("browser_create", 6400)), event: Some(("window.focused", 9000)) };
        assert_eq!(blocked_message(Duration::from_millis(6200), &busy),
            "main thread blocked for 6.2 s, command browser_create started 6.4 s ago and has not returned");
        assert_eq!(blocked_message(Duration::from_secs(5), &idle()),
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
        saw(Seen::ScaleChanged);
        assert_eq!(blame(since_start()).event.map(|(name, _)| name), Some("window.scale-changed"));
    }
}
