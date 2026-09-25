//! One resolution of the core: adopt the one `core.json` names, stop one an
//! older install left running, or start this shell's own and wait for it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::health::{endpoint_of, health, probe, read_core_file, Probe};
use super::spawn::spawn_core;
use super::{CoreEndpoint, CoreState, HELD, POLL_INTERVAL};
use crate::platform::{self, job};
use crate::resident;

/// The ready flag of a core this shell started earlier and that is still
/// running, so a new resolution waits on it rather than starting a second
/// core the data directory's lock would refuse. A core that has exited is
/// dropped here.
fn running_child(state: &CoreState) -> Option<Arc<AtomicBool>> {
    let mut guard = state.child.lock().ok()?;
    let running = guard.as_mut().is_some_and(|spawned| matches!(spawned.child.try_wait(), Ok(None)));
    if running {
        return guard.as_ref().map(|spawned| spawned.ready.clone());
    }
    guard.take();
    None
}

/// Why the core this shell started is gone, if it exited: its exit status
/// and the last lines it printed, the reason a user or a bug report needs.
fn exited_early(state: &CoreState) -> Option<String> {
    let spawned = {
        let mut guard = state.child.lock().ok()?;
        let status = guard.as_mut()?.child.try_wait().ok()??;
        let spawned = guard.take()?;
        (spawned, status)
    };
    if let Ok(mut job) = state.job.lock() { job.take(); }
    let (spawned, status) = spawned;
    spawned.settle();
    Some(format!("the core exited ({status}) before it was ready{}", spawned.output.quoted()))
}

/// Finds the core this shell talks to: the one `core.json` names when it runs
/// this shell's version, else one this shell starts. A core of another version
/// is the one an update or a reinstall left running: it is stopped first,
/// since it holds the data directory's lock and speaks an older protocol.
pub(super) fn resolve_core(state: &CoreState) -> Result<(CoreEndpoint, Option<u32>), String> {
    if state.held.load(Ordering::SeqCst) {
        return Err(HELD.to_string());
    }
    let launch = &state.launch;
    let file = launch.directory.join("core.json");

    // The run `core.json` described before this start: the wait below must
    // not take it for the core it is waiting on.
    let mut before = None;
    match read_core_file(&file) {
        Ok(Some(existing)) => {
            match probe(&existing, &launch.version) {
                Probe::Current => return Ok((endpoint_of(&existing), existing.pid)),
                Probe::Stale(version) => {
                    eprintln!("[shell] the running core is version {version} and this shell {}: stopping it", launch.version);
                    resident::stop_local_core(&launch.directory, resident::GRACE).map_err(|error| {
                        format!("the core of version {version} an earlier install left running could not be stopped: {error}")
                    })?;
                }
                Probe::Absent => {}
            }
            before = Some(existing.identity());
        }
        Ok(None) => {}
        Err(error) => eprintln!("[shell] {error}"),
    }

    let ready = match running_child(state) {
        Some(ready) => ready,
        None => {
            // Asked again here: stopping an older core above takes seconds.
            if state.held.load(Ordering::SeqCst) {
                return Err(HELD.to_string());
            }
            let (spawned, job) = spawn_core(launch)?;
            let ready = spawned.ready.clone();
            if let Ok(mut guard) = state.child.lock() { *guard = Some(spawned); }
            if let Ok(mut guard) = state.job.lock() { *guard = job; }
            ready
        }
    };

    let started = Instant::now();
    loop {
        if let Some(reason) = exited_early(state) {
            return Err(reason);
        }
        if launch.resident || ready.load(Ordering::Acquire) || started.elapsed() > Duration::from_secs(1) {
            if let Ok(Some(found)) = read_core_file(&file) {
                let fresh = before != Some(found.identity());
                // Any version: this is the core the shell just started.
                if let Some(pid) = found.pid.filter(|pid| fresh && platform::process::alive(*pid)) {
                    if health(found.port, pid).is_some() {
                        return Ok((endpoint_of(&found), Some(pid)));
                    }
                }
            }
        }
        if started.elapsed() >= launch.timeout {
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    // A slow resident core is left to finish: killing it would only make the
    // next try start from nothing again. That next try adopts it.
    if launch.resident && running_child(state).is_some() {
        return Err(format!(
            "the core has not answered within {} s; it is still starting, and trying again picks it up",
            launch.timeout.as_secs()
        ));
    }
    let output = match state.child.lock().ok().and_then(|mut guard| guard.take()) {
        Some(mut spawned) => {
            job::stop_core(&mut spawned.child);
            spawned.settle();
            spawned.output.quoted()
        }
        None => String::new(),
    };
    if let Ok(mut guard) = state.job.lock() { drop(guard.take()); }
    Err(format!(
        "the core did not write {} and answer /health within {} s{output}",
        file.display(),
        launch.timeout.as_secs()
    ))
}
