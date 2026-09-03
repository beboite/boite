//! Pushing what this process logs at the window that is watching.
//!
//! The desktop's half of `logs.subscribe`. The bus answers whether a caller may
//! be pushed to; who to push at is the transport's own business, and here the
//! transport is one Tauri event to one webview.
//!
//! Two hops, the same shape as `boite-server`'s fanout and for the same reason.
//! The `boite_core::log` subscriber runs on whichever thread logged, inside the
//! write path, so all it does is clone the record onto a channel and return.
//! The thread below is what batches: fifty records or 250 ms, whichever comes
//! first. One event per record would put the emit on the log's own write path,
//! and a busy second writes hundreds.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// The event the webview listens on. Named like the bus method it serves.
pub const LOG_RECORD_EVENT: &str = "log://record";

/// The ceiling on one batch. The server coalesces on the same number.
const MAX_BATCH: usize = 50;

/// How long a batch waits for company before it goes.
const WINDOW: Duration = Duration::from_millis(250);

/// Whether the window asked to be pushed to.
///
/// A window with the Logs section closed costs the log nothing: the drain still
/// runs, but it emits nothing, so no record is serialized and no event crosses
/// the IPC boundary. Mirrors the server's `anyone_reads_logs`.
static WATCHING: AtomicBool = AtomicBool::new(false);

/// `logs.subscribe` arriving on this host.
pub fn set_watching(on: bool) {
    WATCHING.store(on, Ordering::Relaxed);
}

/// Whether anything is listening right now.
pub fn watching() -> bool {
    WATCHING.load(Ordering::Relaxed)
}

/// Registers the subscriber and starts the drain. Called once, from `setup`.
pub fn start(app: AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    boite_core::log::subscribe(Box::new(move |record| {
        // A record that will not serialize is dropped rather than logged about:
        // logging from inside the log's own subscriber is a loop.
        if let Ok(value) = serde_json::to_value(record) {
            let _ = tx.send(value);
        }
    }));
    std::thread::spawn(move || {
        drain(rx, |batch| {
            if !watching() {
                return;
            }
            let _ = app.emit(LOG_RECORD_EVENT, json!({ "records": batch }));
        });
    });
}

/// Turns a stream of records into batches, and hands each one to `emit`.
///
/// Split out of [`start`] so the batching can be tested without an `AppHandle`:
/// what is worth asserting is the fifty and the 250 ms, not Tauri's event bus.
///
/// A closed channel ends the loop, after handing over whatever is in hand: the
/// last thing a process said before it went away is the thing a reader wants.
pub(crate) fn drain<F: FnMut(Vec<Value>)>(rx: Receiver<Value>, mut emit: F) {
    loop {
        let Ok(first) = rx.recv() else { return };
        let mut batch = vec![first];
        let deadline = Instant::now() + WINDOW;
        let mut closed = false;
        while batch.len() < MAX_BATCH {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(record) => batch.push(record),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    closed = true;
                    break;
                }
            }
        }
        emit(batch);
        if closed {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::sync::{Arc, Mutex};

    fn record(n: usize) -> Value {
        json!({ "ts": n, "level": "info", "target": "t", "msg": format!("m{n}") })
    }

    fn batches_of(values: Vec<Value>) -> Vec<Vec<Value>> {
        let (tx, rx) = channel();
        for value in values {
            tx.send(value).unwrap();
        }
        drop(tx);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        drain(rx, move |batch| sink.lock().unwrap().push(batch));
        Arc::try_unwrap(seen).unwrap().into_inner().unwrap()
    }

    /// Fifty is a cut, not a ceiling on the whole feed.
    ///
    /// A hundred and twenty records already queued go out as fifty, fifty and
    /// twenty rather than as one event of a hundred and twenty: the point of
    /// the batch is that the window is never handed an unbounded payload, and a
    /// process writing hard produces exactly that.
    #[test]
    fn a_full_batch_goes_at_fifty_and_the_rest_follows() {
        let batches = batches_of((0..120).map(record).collect());
        assert_eq!(
            batches.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![50, 50, 20]
        );
        assert_eq!(batches[0][0]["ts"], json!(0));
        assert_eq!(batches[2][19]["ts"], json!(119));
    }

    /// A closed channel hands over what is in hand instead of dropping it.
    ///
    /// The last lines a process writes are the ones a crash report is made of,
    /// and a drain that returned on `Disconnected` without emitting would throw
    /// away up to forty-nine of them.
    #[test]
    fn a_short_batch_is_still_delivered_when_the_channel_closes() {
        let batches = batches_of((0..3).map(record).collect());
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 3);
    }

    /// Nothing written means nothing emitted, rather than an empty event on a
    /// timer.
    #[test]
    fn a_silent_process_emits_nothing() {
        assert!(batches_of(Vec::new()).is_empty());
    }

    /// A record that arrives after the window has closed belongs to the next
    /// batch, and the first one goes without waiting for it.
    #[test]
    fn the_window_closes_on_its_own_without_a_full_batch() {
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            tx.send(record(1)).unwrap();
            std::thread::sleep(WINDOW + Duration::from_millis(120));
            tx.send(record(2)).unwrap();
        });
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        drain(rx, move |batch| sink.lock().unwrap().push(batch));
        let batches = Arc::try_unwrap(seen).unwrap().into_inner().unwrap();
        assert_eq!(batches.iter().map(Vec::len).collect::<Vec<_>>(), vec![1, 1]);
    }

    /// The gate is what a window with the Logs section closed costs the log.
    #[test]
    fn the_feed_is_off_until_a_subscribe_turns_it_on() {
        assert!(!watching());
        set_watching(true);
        assert!(watching());
        set_watching(false);
        assert!(!watching());
    }
}
