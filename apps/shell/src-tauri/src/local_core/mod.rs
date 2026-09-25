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
#[cfg(test)]
mod tests;

pub(crate) use locate::resolve_data_dir;
use locate::{core_command, CoreCommand};
use resolve::resolve_core;
use spawn::Spawned;

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
    error: Option<String>,
    done: bool,
    /// Bumped each time a new resolution starts, so that of several callers
    /// who find the same dead core only the first starts another.
    generation: u64,
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
    /// How long a started core gets to answer `/health`.
    timeout: Duration,
}

impl Launch {
    pub(crate) fn new(channel: Channel, directory: PathBuf, resources: Option<PathBuf>, version: String) -> Self {
        Self {
            command: core_command(channel, &directory),
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
            launch,
            held: AtomicBool::new(false),
        }
    }

    /// Stops the local core before an installer replaces its files, and keeps
    /// it stopped: the window notices the lost core within seconds and asks for
    /// it again, which would otherwise start the old executable and lock it.
    /// An error leaves the core running and the hold released.
    pub(crate) fn stop_for_install(&self) -> Result<(), String> {
        self.held.store(true, Ordering::SeqCst);
        let stopped = resident::stop_local_core(&self.launch.directory, resident::GRACE);
        if stopped.is_err() {
            self.release_hold();
        }
        stopped.map(|_| ())
    }

    /// The install did not happen: the next caller starts the core again.
    pub(crate) fn release_hold(&self) {
        self.held.store(false, Ordering::SeqCst);
    }

    /// Closing a client leaves a resident core running. Automation may own its child.
    pub(crate) fn kill_child(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut spawned) = guard.take() {
                if !self.launch.resident { job::stop_core(&mut spawned.child); }
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

/// What the last resolution settled on.
struct Settled {
    outcome: Result<CoreEndpoint, String>,
    pid: Option<u32>,
    generation: u64,
}

impl Settled {
    /// A failed start, or a core whose process has since exited: a crash, a
    /// kill, "Stop this core". Either way a new resolution is due.
    fn stale(&self) -> bool {
        self.outcome.is_err() || self.pid.is_some_and(|pid| !platform::process::alive(pid))
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

fn publish(slot: &(Mutex<Slot>, Condvar), outcome: Result<(CoreEndpoint, Option<u32>), String>) {
    let (lock, ready) = slot;
    if let Ok(mut guard) = lock.lock() {
        match outcome {
            Ok((endpoint, pid)) => {
                guard.endpoint = Some(endpoint);
                guard.pid = pid;
            }
            Err(error) => guard.error = Some(error),
        }
        guard.done = true;
    }
    ready.notify_all();
}

fn wait_for_endpoint(slot: &(Mutex<Slot>, Condvar), patience: Duration) -> Result<Settled, String> {
    let (lock, ready) = slot;
    let deadline = Instant::now() + patience;
    let mut guard = lock
        .lock()
        .map_err(|_| "the core state is poisoned".to_string())?;

    while !guard.done {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("no core answered within the start timeout".to_string());
        }
        let (next, timeout) = ready
            .wait_timeout(guard, remaining)
            .map_err(|_| "the core state is poisoned".to_string())?;
        guard = next;
        if timeout.timed_out() && !guard.done {
            return Err("no core answered within the start timeout".to_string());
        }
    }

    let outcome = match (guard.endpoint.as_ref(), guard.error.as_ref()) {
        (Some(endpoint), _) => Ok(endpoint.clone()),
        (None, Some(error)) => Err(error.clone()),
        (None, None) => Err("the core resolved to nothing".to_string()),
    };
    Ok(Settled { outcome, pid: guard.pid, generation: guard.generation })
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
