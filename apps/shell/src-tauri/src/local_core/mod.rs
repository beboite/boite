//! The local core: what a start depends on, the state the shell keeps about
//! it, and the one resolution every caller of `core_endpoint` waits on.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, Webview};

use crate::channel::Channel;
use crate::platform::{self, job, job::CoreJob};
use crate::window::{show_main, Reveal, REVEAL_AFTER, REVEAL_ANYWAY};
use crate::{quota_window, resident};

pub(crate) mod health;
mod locate;
mod resolve;
mod spawn;
mod starting;
#[cfg(test)]
mod tests;

pub(crate) use locate::resolve_data_dir;
use locate::{core_command, CoreCommand};
use resolve::resolve_core;
use spawn::Spawned;
use starting::{read_starting, Starting};

/// How long a core the shell started gets to answer. A warm start takes about
/// a second; the first start of a freshly installed sidecar, scanned by the
/// antivirus on a slow disk, took several times that, so the margin is wide.
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// How often the wait on a starting core looks again. The check is a flag read
/// until the ready line came, so 10 ms costs nothing, and at 120 ms the window
/// opened 60 ms late on average for a core that is up in about as long.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Serialize)]
pub struct CoreEndpoint {
    pub url: String,
    pub token: String,
}

#[derive(Default)]
struct Slot {
    endpoint: Option<CoreEndpoint>,
    /// The process behind `endpoint`, to notice once it has exited.
    pid: Option<u32>,
    /// How that core started, as `core.json` says: a process that started
    /// later wears its number only because the core exited.
    start: health::CoreStart,
    error: Option<String>,
    done: bool,
    /// Bumped each time a new resolution starts, so that of several callers
    /// who find the same dead core only the first starts another.
    generation: u64,
    /// The last time that resolution saw the core announce work before it
    /// serves (`core.starting.json`), or started its own once the core it
    /// waited on exited during that work. Callers follow it rather than read
    /// the file themselves.
    announced: Option<Instant>,
    /// How many times a caller went to sleep on this slot, and how many times
    /// it woke to a later deadline than the one it slept to: a test moves the
    /// sighting once its caller sleeps and serves once it read the move.
    #[cfg(test)]
    sleeps: u32,
    #[cfg(test)]
    extended: u32,
}

/// Everything a start of the core depends on, decided once when the app is
/// set up and never read from the environment again.
#[derive(Clone)]
pub(crate) struct Launch {
    /// The data directory, resolved once: the core is told it with
    /// `--data-dir`, so the shell and the core can never look in two places.
    directory: PathBuf,
    /// An error here is only reported when a core has to be started, since a
    /// running core can be adopted without one.
    command: Result<CoreCommand, String>,
    resources: Option<PathBuf>,
    resident: bool,
    /// The shell's own version. A running core that reports another version
    /// belongs to the install an update replaced, and is stopped.
    version: String,
    /// The installed split bundle, even when a reinstall keeps the same version.
    bundle_hash: Option<String>,
    /// How long a started core gets to answer `/health`.
    timeout: Duration,
}

impl Launch {
    pub(crate) fn new(channel: Channel, directory: PathBuf, resources: Option<PathBuf>, version: String) -> Self {
        let command = core_command(channel, &directory);
        let bundle_hash = command.as_ref().ok().and_then(CoreCommand::bundle_hash);
        Self {
            command,
            bundle_hash,
            directory,
            resources,
            resident: resident_core(),
            version,
            timeout: START_TIMEOUT,
        }
    }

    /// How long a caller of `core_endpoint` may wait on one resolution: the
    /// start itself, plus stopping an older core first.
    fn patience(&self) -> Duration {
        self.timeout + resident::GRACE + Duration::from_secs(5)
    }
}

pub struct CoreState {
    slot: (Mutex<Slot>, Condvar),
    child: Mutex<Option<Spawned>>,
    /// Held for the life of the shell process: see `job::CoreJob`.
    job: Mutex<Option<CoreJob>>,
    /// The core this shell adopted rather than started. On Windows the open
    /// handle pins its pid, as the `Child` does for a started core, so once
    /// it exits no other process can wear the number while the shell holds it.
    adopted: Mutex<Option<platform::process::Watched>>,
    launch: Launch,
    /// Set while an update installs: the core was stopped so the installer can
    /// replace its files, and nothing may start it again from the old ones.
    held: AtomicBool,
}

/// The refusal a caller gets while an update installs.
const HELD: &str = "the core is stopped while the app update installs";

/// Normal installations keep the core alive. Automation can request owned lifetime.
fn resident_core() -> bool { std::env::var("BOITE_CORE_RESIDENT").as_deref() != Ok("0") }

impl CoreState {
    pub(crate) fn new(launch: Launch) -> Self {
        Self {
            slot: (Mutex::new(Slot::default()), Condvar::new()),
            child: Mutex::new(None),
            job: Mutex::new(None),
            adopted: Mutex::new(None),
            launch,
            held: AtomicBool::new(false),
        }
    }

    /// Waits for startup before holding reconnects, then asks the core to hand its turns to the
    /// next one and stop. A core too old for that is asked for an idle-only stop, which
    /// cancellation can still call off.
    pub(crate) fn wait_for_install(&self, control: &Mutex<crate::update_stop::InstallState>, idle_only: bool, still: impl Fn() -> bool, committed: impl Fn()) -> Result<bool, String> {
        current_endpoint(self)?;
        self.held.store(true, Ordering::SeqCst);
        let stopped = crate::update_stop::stop_for_update(&self.launch.directory, control, idle_only, still, committed);
        // The stop leaves the exit of a core this shell started to its `Child`.
        reap_child(self);
        if !matches!(stopped, Ok(true)) {
            self.release_hold();
        }
        stopped
    }

    /// The install did not happen: the next caller starts the core again.
    pub(crate) fn release_hold(&self) {
        self.held.store(false, Ordering::SeqCst);
    }

    /// Closing a client leaves a resident core running. Automation may own its child.
    pub(crate) fn kill_child(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut spawned) = guard.take() {
                let pid = spawned.child.id();
                if self.launch.resident {
                    crate::shell_log::info("core", "shell.core.kill-child", format!("leaving the resident core pid {pid} running as the shell exits"),
                        serde_json::json!({ "pid": pid, "resident": true }));
                } else {
                    crate::shell_log::info("core", "shell.core.kill-child", format!("stopping the core pid {pid} this shell owns"),
                        serde_json::json!({ "pid": pid, "resident": false }));
                    job::stop_core(&mut spawned.child);
                }
            }
        }
        // Dropping the job closes its handle, which kills whatever is still in
        // it: a core that ignored the kill, and anything it had spawned.
        if let Ok(mut guard) = self.job.lock() {
            drop(guard.take());
        }
    }
}

/// The core token rides in this answer, so the caller is checked like every
/// other: a page a browser surface loaded asks and is told no.
#[tauri::command]
pub(crate) async fn core_endpoint(app: AppHandle, webview: Webview) -> Result<CoreEndpoint, String> {
    quota_window::only_ui(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.try_state::<CoreState>().ok_or("the shell has not set up its core yet")?;
        current_endpoint(&state)
    })
    .await
    .map_err(|error| format!("the endpoint task did not finish: {error}"))?
}

/// What the core does before it serves, while it says so: the window shows it
/// in place of its plain waiting message.
#[tauri::command]
pub(crate) fn core_starting(app: AppHandle, webview: Webview) -> Result<Option<Starting>, String> {
    quota_window::only_ui(&webview)?;
    let state = app.try_state::<CoreState>().ok_or("the shell has not set up its core yet")?;
    Ok(read_starting(&state.launch.directory))
}

/// What the last resolution settled on.
struct Settled {
    outcome: Result<CoreEndpoint, String>,
    pid: Option<u32>,
    start: health::CoreStart,
    generation: u64,
}

impl Settled {
    /// A failed start, or a core whose process has since exited: a crash, a
    /// kill, "Stop this core". Either way a new resolution is due. A pid that
    /// another process got since then is the same exit, not a live core.
    fn stale(&self) -> bool {
        self.outcome.is_err() || self.pid.is_some_and(|pid| !health::same_core(pid, &self.start))
    }
}

/// The endpoint of a live core. The one found at start while its process runs;
/// otherwise the caller resolves again, which adopts or starts a core, so a
/// reload of the UI or its reconnect brings a stopped core back. Of several
/// callers only the first to see the dead core resolves; the others wait for it.
fn current_endpoint(state: &CoreState) -> Result<CoreEndpoint, String> {
    let patience = state.launch.patience();
    let settled = wait_for_endpoint(&state.slot, patience)?;
    reap_child(state);
    if !settled.stale() {
        return settled.outcome;
    }
    if claim(&state.slot, settled.generation) {
        let reason = match (&settled.outcome, settled.pid) {
            // Only the first line: the core's output under it stays in the exit record's data.stderrTail.
            (Err(error), _) => format!("the last start failed ({})", error.lines().next().unwrap_or("")),
            (Ok(_), Some(pid)) => format!("the core pid {pid} is no longer running"),
            (Ok(_), None) => "the core is gone".to_string(),
        };
        crate::shell_log::warn("core", "shell.core.restart", format!("resolving the core again: {reason}"),
            serde_json::json!({ "pid": settled.pid, "generation": settled.generation + 1 }));
        publish(&state.slot, resolve_core(state));
    }
    wait_for_endpoint(&state.slot, patience)?.outcome
}

/// Collects the exit of a core this shell started, if it exited. On Linux and
/// macOS that core is the shell's child, and a child nobody waited on stays a
/// zombie that `kill(pid, 0)` still finds, so `stale` took a crashed core for
/// a live one and nothing started another. The `Child` stays in place, with the
/// status it now holds, for `running_child` and `exited_early`.
fn reap_child(state: &CoreState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(spawned) = guard.as_mut() {
            let _ = spawned.child.try_wait();
        }
    }
}

/// Takes the slot for a new resolution if nobody did since `generation` settled.
fn claim(slot: &(Mutex<Slot>, Condvar), generation: u64) -> bool {
    let Ok(mut guard) = slot.0.lock() else { return false };
    if !guard.done || guard.generation != generation {
        return false;
    }
    *guard = Slot { generation: generation + 1, ..Slot::default() };
    true
}

/// What a resolution settled on: the endpoint, and the process behind it with
/// how it started when known.
pub(super) type Resolved = (CoreEndpoint, Option<u32>, health::CoreStart);

fn publish(slot: &(Mutex<Slot>, Condvar), outcome: Result<Resolved, String>) {
    let (lock, ready) = slot;
    if let Ok(mut guard) = lock.lock() {
        match outcome {
            Ok((endpoint, pid, start)) => {
                guard.endpoint = Some(endpoint);
                guard.pid = pid;
                guard.start = start;
            }
            Err(error) => guard.error = Some(error),
        }
        guard.done = true;
    }
    ready.notify_all();
}

/// When a caller that began waiting at `begun` gives up: `patience` after
/// that, or after the resolution's last sighting of the core at work.
fn endpoint_deadline(begun: Instant, announced: Option<Instant>, patience: Duration) -> Instant {
    announced.map_or(begun, |announced| announced.max(begun)) + patience
}

/// Waits up to `patience` for the resolution, and `patience` past the last
/// time the resolution saw the core announce work before it serves
/// (`Slot::announced`): the resolver waits a whole timeout past that moment,
/// so a caller gives up only after it does.
fn wait_for_endpoint(slot: &(Mutex<Slot>, Condvar), patience: Duration) -> Result<Settled, String> {
    let (lock, ready) = slot;
    let begun = Instant::now();
    let mut guard = lock
        .lock()
        .map_err(|_| "the core state is poisoned".to_string())?;

    #[cfg(test)]
    let mut slept_to: Option<Instant> = None;
    while !guard.done {
        let deadline = endpoint_deadline(begun, guard.announced, patience);
        let wait = deadline.saturating_duration_since(Instant::now());
        if wait.is_zero() {
            return Err("no core answered within the start timeout".to_string());
        }
        #[cfg(test)]
        {
            if slept_to.is_some_and(|earlier| deadline > earlier) {
                guard.extended += 1;
            }
            slept_to = Some(deadline);
            guard.sleeps += 1;
        }
        let (next, _) = ready
            .wait_timeout(guard, wait)
            .map_err(|_| "the core state is poisoned".to_string())?;
        guard = next;
    }

    let outcome = match (guard.endpoint.as_ref(), guard.error.as_ref()) {
        (Some(endpoint), _) => Ok(endpoint.clone()),
        (None, Some(error)) => Err(error.clone()),
        (None, None) => Err("the core resolved to nothing".to_string()),
    };
    Ok(Settled { outcome, pid: guard.pid, start: guard.start.clone(), generation: guard.generation })
}

/// The first resolution, started with the app, and the timers that show the
/// main window once it is due (`Reveal`).
pub(crate) fn start_core<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<CoreState>();
        let outcome = resolve_core(&state);
        if let Err(error) = &outcome {
            eprintln!("[shell] {error}");
        }
        publish(&state.slot, outcome);
        if handle.state::<Reveal>().due() {
            show_main(&handle);
        }
    });
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(REVEAL_AFTER);
        if handle.state::<Reveal>().due() {
            show_main(&handle);
        }
        std::thread::sleep(REVEAL_ANYWAY.saturating_sub(REVEAL_AFTER));
        if handle.state::<Reveal>().anyway() {
            show_main(&handle);
        }
    });
}
