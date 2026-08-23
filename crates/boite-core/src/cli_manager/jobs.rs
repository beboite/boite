//! What an install is doing right now, for whoever asks next.
//!
//! An install is minutes of work and a few hundred megabytes; the call that
//! starts it answers in milliseconds. So the work runs on a thread of its own and
//! leaves a snapshot here, and the panel reads snapshots — on the desktop and on
//! a phone talking to a `boite-server`, through the same bus call, with no event
//! channel written twice and no progress lost because nobody was listening yet.
//!
//! A finished job stays in the table on purpose. The panel that asks after the
//! last byte landed has to be able to read "done" rather than "no such job",
//! which is indistinguishable from "never started".

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use super::Failed;

/// How long a finished job is still worth answering about.
const KEEP_FINISHED_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Install,
    Uninstall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Asking the vendor what the current version is.
    Resolving,
    Downloading,
    /// Checking a published digest, where the vendor publishes one.
    Verifying,
    Unpacking,
    /// Moving the binary into the managed bin.
    Installing,
    /// Taking the binary back out of it.
    Removing,
    /// Removing the CLI's own data, on an uninstall that was asked to.
    Purging,
    Done,
    Failed,
    Cancelled,
}

impl Phase {
    /// Whether nothing more will happen to this job.
    pub fn settled(self) -> bool {
        matches!(self, Phase::Done | Phase::Failed | Phase::Cancelled)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub kind: Kind,
    pub phase: Phase,
    pub received: u64,
    /// `None` while the vendor sends no length, which is a progress bar with no
    /// end rather than a number to make up.
    pub total: Option<u64>,
    pub version: Option<String>,
    /// What went wrong, or what was removed. The panel shows it verbatim.
    pub message: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
}

struct Entry {
    snapshot: Snapshot,
    cancel: Arc<AtomicBool>,
}

fn table() -> &'static Mutex<HashMap<String, Entry>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Claims the slot for `id` and hands back the flag its worker has to watch.
///
/// One job per CLI: two installs of the same binary would race on the same file
/// in the managed bin, and the loser would win. A job already running is a
/// refusal rather than a queue, because the panel's other answer is a Stop button.
pub fn start(id: &str, kind: Kind) -> Result<Arc<AtomicBool>, Failed> {
    let mut jobs = table().lock();
    if let Some(entry) = jobs.get(id) {
        if !entry.snapshot.phase.settled() {
            return Err(Failed(format!(
                "{id} is already {}",
                match entry.snapshot.kind {
                    Kind::Install => "being installed",
                    Kind::Uninstall => "being removed",
                }
            )));
        }
    }
    let now = crate::now_ms();
    let cancel = Arc::new(AtomicBool::new(false));
    jobs.insert(
        id.to_string(),
        Entry {
            snapshot: Snapshot {
                id: id.to_string(),
                kind,
                phase: Phase::Resolving,
                received: 0,
                total: None,
                version: None,
                message: None,
                started_at: now,
                updated_at: now,
            },
            cancel: cancel.clone(),
        },
    );
    Ok(cancel)
}

fn touch(id: &str, edit: impl FnOnce(&mut Snapshot)) {
    let mut jobs = table().lock();
    if let Some(entry) = jobs.get_mut(id) {
        edit(&mut entry.snapshot);
        entry.snapshot.updated_at = crate::now_ms();
    }
}

pub fn phase(id: &str, phase: Phase) {
    touch(id, |snapshot| snapshot.phase = phase);
}

pub fn progress(id: &str, received: u64, total: Option<u64>) {
    touch(id, |snapshot| {
        snapshot.received = received;
        snapshot.total = total;
    });
}

pub fn version(id: &str, version: &str) {
    touch(id, |snapshot| snapshot.version = Some(version.to_string()));
}

/// The terminal write. A cancelled job says so rather than reporting the error
/// its own cancellation produced.
pub fn settle(id: &str, outcome: Result<Option<String>, Failed>) {
    let (phase, message) = match outcome {
        Ok(message) => (Phase::Done, message),
        Err(Failed(message)) if message == super::CANCELLED => (Phase::Cancelled, None),
        Err(Failed(message)) => (Phase::Failed, Some(message)),
    };
    touch(id, |snapshot| {
        snapshot.phase = phase;
        snapshot.message = message;
    });
}

/// Asks a running job to stop. Answers whether there was one.
pub fn cancel(id: &str) -> bool {
    let jobs = table().lock();
    match jobs.get(id) {
        Some(entry) if !entry.snapshot.phase.settled() => {
            entry.cancel.store(true, Ordering::Relaxed);
            true
        }
        _ => false,
    }
}

/// Forgets a settled job, which is how the panel dismisses a failure.
pub fn dismiss(id: &str) {
    let mut jobs = table().lock();
    if jobs.get(id).is_some_and(|e| e.snapshot.phase.settled()) {
        jobs.remove(id);
    }
}

/// Every job worth answering about, oldest first, with the stale ones dropped.
pub fn all() -> Vec<Snapshot> {
    let cutoff = crate::now_ms() - KEEP_FINISHED_MS;
    let mut jobs = table().lock();
    jobs.retain(|_, entry| !entry.snapshot.phase.settled() || entry.snapshot.updated_at >= cutoff);
    let mut out: Vec<Snapshot> = jobs.values().map(|entry| entry.snapshot.clone()).collect();
    out.sort_by_key(|snapshot| snapshot.started_at);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_job_per_cli_and_a_settled_one_stands_aside() {
        let id = "test-one-job";
        let cancel = start(id, Kind::Install).unwrap();
        assert!(start(id, Kind::Install).is_err(), "two jobs on one CLI");

        assert!(super::cancel(id));
        assert!(cancel.load(Ordering::Relaxed), "the worker was not told");

        settle(id, Err(Failed(super::super::CANCELLED.to_string())));
        let snapshot = all().into_iter().find(|s| s.id == id).unwrap();
        assert_eq!(snapshot.phase, Phase::Cancelled);
        assert!(snapshot.message.is_none(), "a cancellation is not an error");

        start(id, Kind::Install).expect("a settled job blocks nothing");
        settle(id, Ok(None));
        dismiss(id);
        assert!(all().iter().all(|s| s.id != id));
    }

    #[test]
    fn a_failure_keeps_what_it_said() {
        let id = "test-failure";
        start(id, Kind::Install).unwrap();
        progress(id, 512, Some(2048));
        settle(id, Err(Failed("nothing published at /x".to_string())));
        let snapshot = all().into_iter().find(|s| s.id == id).unwrap();
        assert_eq!(snapshot.phase, Phase::Failed);
        assert_eq!(snapshot.received, 512);
        assert_eq!(snapshot.message.as_deref(), Some("nothing published at /x"));
        dismiss(id);
    }
}
