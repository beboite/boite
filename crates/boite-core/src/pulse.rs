//! The workspace pulse: what happened, as a bounded ring, and how a caller
//! waits on it.
//!
//! An orchestrator's whole waiting strategy is one long-poll on this module.
//! The cost model depends on it: a poll loop repays the shape of the workspace
//! at every tick, while a wait here costs one wake per event. So the rules are
//! engineering rather than assertion:
//!
//! - the timeout is capped at [`MAX_TIMEOUT_MS`] — a torn connection repairs
//!   itself quickly, ten-minute holds do not;
//! - one live wait per calling thread: a second wait from the same thread
//!   supersedes the first, which returns [`Outcome::Superseded`] so the agent
//!   learns it doubled itself instead of reading a lying timeout;
//! - at most [`MAX_WAITERS`] live waits in the whole process; the next one is
//!   refused immediately with the `PULSE_BUSY` sentence.
//!
//! The storage half lives on [`crate::store::Store`]: `append_moment` writes
//! and prunes the ring, `read_moments` answers with a truncation flag when a
//! cursor fell out of it. This module is the coordination half, and it is
//! std-only: `boite-core` takes no async runtime, so the wait is a condvar and
//! each transport wraps it in whatever it already uses.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};

/// How many rows the `moments` table keeps. A sleeper that misses more than
/// this wakes to `truncated: true` and a fresh roster, never to silence.
pub const RING_CAP: i64 = 5000;

/// The longest one wait may hold, in milliseconds.
pub const MAX_TIMEOUT_MS: u64 = 120_000;

/// The default when the caller says nothing.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// How many waits may be live at once, process-wide.
pub const MAX_WAITERS: usize = 8;

/// One row of the pulse.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Moment {
    pub seq: i64,
    pub kind: String,
    pub project_id: Option<String>,
    pub object_id: Option<String>,
    pub detail: String,
    pub source: String,
    pub at: i64,
}

/// How a wait ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Something was appended while waiting. Read the ring again.
    Woken,
    /// Nothing happened. A timeout is an answer, never an error.
    TimedOut,
    /// The same caller opened a second wait; this one is the first.
    Superseded,
}

struct Slot {
    /// Bumped when the same key registers again, which is what supersedes.
    epoch: u64,
}

#[derive(Default)]
struct State {
    slots: HashMap<String, Slot>,
}

/// The registry of live waits. One per process, shared by every transport.
///
/// `Debug` names itself and stops: `Ready` derives `Debug` and carries one of
/// these, and there is nothing in a condvar worth printing into a log.
#[derive(Default)]
pub struct Waiters {
    state: Mutex<State>,
    changed: Condvar,
    generation: AtomicU64,
}

impl std::fmt::Debug for Waiters {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Waiters")
    }
}

impl Waiters {
    pub fn new() -> Arc<Waiters> {
        Arc::new(Waiters::default())
    }

    /// Wakes every live wait. Called after each append.
    pub fn notify(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let _guard = self.state.lock();
        self.changed.notify_all();
    }

    /// Blocks until something is appended, the timeout lapses, or the same
    /// caller asks again. `key` names the caller — a thread id — and is what
    /// the one-wait-per-caller rule is kept on.
    pub fn wait(&self, key: &str, timeout_ms: u64) -> Result<Outcome, String> {
        let timeout = Duration::from_millis(timeout_ms.min(MAX_TIMEOUT_MS));
        let seen = self.generation.load(Ordering::SeqCst);
        let my_epoch;
        {
            let mut state = self.state.lock();
            match state.slots.get_mut(key) {
                Some(slot) => {
                    // The earlier wait wakes on this bump and reads itself as
                    // superseded; this call takes the slot over.
                    slot.epoch += 1;
                    my_epoch = slot.epoch;
                    self.changed.notify_all();
                }
                None => {
                    if state.slots.len() >= MAX_WAITERS {
                        return Err(format!(
                            "PULSE_BUSY: {MAX_WAITERS} waits are already live, \
                             and a ninth would starve the others. Try again in a moment."
                        ));
                    }
                    my_epoch = 0;
                    state.slots.insert(key.to_string(), Slot { epoch: 0 });
                }
            }
        }
        let deadline = std::time::Instant::now() + timeout;
        let mut state = self.state.lock();
        loop {
            let outcome = match state.slots.get(key) {
                // The slot moved on without this wait: a newer call owns it.
                Some(slot) if slot.epoch != my_epoch => Some(Outcome::Superseded),
                _ if self.generation.load(Ordering::SeqCst) != seen => Some(Outcome::Woken),
                _ => None,
            };
            if let Some(outcome) = outcome {
                // Only the current owner tears the slot down; a superseded
                // wait leaving would tear down its successor's registration.
                if outcome != Outcome::Superseded {
                    state.slots.remove(key);
                }
                return Ok(outcome);
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                state.slots.remove(key);
                return Ok(Outcome::TimedOut);
            }
            self.changed.wait_for(&mut state, deadline - now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_append_wakes_a_wait_and_a_quiet_ring_times_out() {
        let waiters = Waiters::new();
        let woken = {
            let waiters = waiters.clone();
            std::thread::spawn(move || waiters.wait("t1", 5_000))
        };
        // Give the wait time to park before waking it.
        std::thread::sleep(Duration::from_millis(50));
        waiters.notify();
        assert_eq!(woken.join().unwrap().unwrap(), Outcome::Woken);

        assert_eq!(waiters.wait("t1", 10).unwrap(), Outcome::TimedOut);
    }

    #[test]
    fn a_second_wait_from_the_same_thread_supersedes_the_first() {
        let waiters = Waiters::new();
        let first = {
            let waiters = waiters.clone();
            std::thread::spawn(move || waiters.wait("t1", 5_000))
        };
        std::thread::sleep(Duration::from_millis(50));
        let second = {
            let waiters = waiters.clone();
            std::thread::spawn(move || waiters.wait("t1", 5_000))
        };
        assert_eq!(first.join().unwrap().unwrap(), Outcome::Superseded);
        // The second is a live wait of its own, and an append still reaches it.
        std::thread::sleep(Duration::from_millis(50));
        waiters.notify();
        assert_eq!(second.join().unwrap().unwrap(), Outcome::Woken);
    }

    #[test]
    fn the_ninth_wait_is_refused_by_name() {
        let waiters = Waiters::new();
        let held: Vec<_> = (0..MAX_WAITERS)
            .map(|i| {
                let waiters = waiters.clone();
                std::thread::spawn(move || waiters.wait(&format!("t{i}"), 5_000))
            })
            .collect();
        std::thread::sleep(Duration::from_millis(100));
        let refusal = waiters.wait("one-too-many", 5_000).unwrap_err();
        assert!(refusal.contains("PULSE_BUSY"), "{refusal}");
        waiters.notify();
        for handle in held {
            assert_eq!(handle.join().unwrap().unwrap(), Outcome::Woken);
        }
    }

    // The 120 s cap itself is one `min` in `wait` and one in
    // `Conduct::decode`; a live test of it would hold a runner for two
    // minutes, which is exactly what the cap exists to forbid.
}
