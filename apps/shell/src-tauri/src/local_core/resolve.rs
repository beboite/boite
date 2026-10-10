//! One resolution of the core: adopt the one `core.json` names, stop one an
//! older install left running, or start this shell's own and wait for it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::health::{endpoint_of, health, probe, read_core_file, Probe};
use super::spawn::spawn_core;
use super::{CoreEndpoint, CoreState, HELD, POLL_INTERVAL};
use crate::shell_log::{self, Level};
use serde_json::json;
use crate::platform::{self, job};
use crate::resident;

/// The ready flag of a core this shell started earlier and that is still
/// running, so a new resolution waits on it rather than starting a second
/// core the data directory's lock would refuse. A core that has exited is
/// dropped here, after its exit status and last lines are logged.
fn running_child(state: &CoreState) -> Option<Arc<AtomicBool>> {
    let mut guard = state.child.lock().ok()?;
    let polled = guard.as_mut()?.child.try_wait();
    let status = match polled {
        Ok(None) => return guard.as_ref().map(|spawned| spawned.ready.clone()),
        Ok(Some(status)) => Some(status),
        Err(_) => None,
    };
    let spawned = guard.take()?;
    drop(guard);
    if let Some(status) = status { log_exit(&spawned, status, "after it started serving"); }
    None
}

/// The `shell.core.exited` record: exit status, and the core's last lines
/// under `stderrTail`, which stays on this machine and is withheld from every
/// anonymized view. A clean exit (an update, "Stop this core") is lifecycle,
/// not a problem.
fn log_exit(spawned: &super::spawn::Spawned, status: std::process::ExitStatus, when: &str) {
    spawned.settle();
    let tail = spawned.output.tail().join(" | ");
    let cut = tail.char_indices().rev().nth(299).map_or(tail.as_str(), |(index, _)| &tail[index..]);
    let level = if status.success() { Level::Info } else { Level::Error };
    shell_log::log(level, "core", "shell.core.exited", format!("the core pid {} exited ({status}) {when}", spawned.child.id()), None,
        json!({ "pid": spawned.child.id(), "exitCode": status.code(), "stderrTail": if cut.is_empty() { None } else { Some(cut) } }));
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
    log_exit(&spawned, status, "before it was ready");
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
            match probe(&existing, &launch.version, launch.bundle_hash.as_deref()) {
                Probe::Current => {
                    shell_log::info("core", "shell.core.attached", format!("attached to the running core pid {} on port {}",
                        existing.pid.map(|pid| pid.to_string()).unwrap_or_else(|| "unknown".into()), existing.port),
                        json!({ "pid": existing.pid, "port": existing.port }));
                    return Ok((endpoint_of(&existing), existing.pid));
                }
                Probe::Stale(version) => {
                    eprintln!("[shell] the running core is version {version} and this shell {}: stopping it", launch.version);
                    shell_log::info("core", "shell.core.stale", format!("the running core is version {version} and this shell {}: stopping it", launch.version),
                        json!({ "pid": existing.pid, "coreVersion": version.to_string(), "shellVersion": launch.version }));
                    resident::stop_local_core(&launch.directory, resident::GRACE).map_err(|error| {
                        format!("the core of version {version} an earlier install left running could not be stopped: {error}")
                    })?;
                }
                Probe::Absent => {}
            }
            before = Some(existing.identity());
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("[shell] {error}");
            shell_log::warn("core", "shell.core.file-unreadable", format!("core.json could not be read, so a core is started: {error}"), json!({}));
        }
    }

    let ready = match running_child(state) {
        Some(ready) => ready,
        None => {
            // Asked again here: stopping an older core above takes seconds.
            if state.held.load(Ordering::SeqCst) {
                return Err(HELD.to_string());
            }
            let (spawned, job) = spawn_core(launch).inspect_err(|error| {
                shell_log::error("core", "shell.core.spawn-failed", format!("the core could not be started: {error}"), json!({}));
            })?;
            shell_log::info("core", "shell.core.spawned", format!("started the core as pid {} ({})", spawned.child.id(),
                if launch.resident { "resident, it outlives this window" } else { "owned, it stops with this window" }),
                json!({ "pid": spawned.child.id(), "resident": launch.resident }));
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
                        let took = started.elapsed();
                        shell_log::timed(Level::Info, "core", "shell.core.ready",
                            format!("the core pid {pid} answered on port {} after {} ms", found.port, took.as_millis()),
                            took, json!({ "pid": pid, "port": found.port }));
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
        shell_log::error("core", "shell.core.timeout", format!("the resident core has not answered within {} s and is left starting", launch.timeout.as_secs()),
            json!({ "timeoutMs": launch.timeout.as_millis() as u64, "resident": true }));
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
    shell_log::error("core", "shell.core.timeout", format!("the core did not answer /health within {} s and was stopped", launch.timeout.as_secs()),
        json!({ "timeoutMs": launch.timeout.as_millis() as u64, "resident": false }));
    Err(format!(
        "the core did not write {} and answer /health within {} s{output}",
        file.display(),
        launch.timeout.as_secs()
    ))
}
