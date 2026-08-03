use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use tauri::ipc::Channel;

use boite_core::pty::{EventSink, PtyEvent};
use boite_core::transcript::{self, Scrollback};

use crate::commands::WirePtyEvent;

/// Scrollback kept per detached local PTY, so a reattaching terminal is not
/// blank until the next byte. A recent screen, not a history: the history is
/// the transcript file behind it.
///
/// This used to be a `VecDeque` and a constant here, and the server had a
/// different one that also tracked an absolute offset. Two rings, one of which
/// could answer "what have I missed" and one of which could not, so a reattach
/// on a local workspace repainted the whole screen and a reattach on a remote
/// one did not. Neither behaviour was a decision.
const RING_CAP: usize = 256 * 1024;

// Output sink for a local PTY with a *detachable* channel plus a scrollback
// ring. On a workspace switch the desktop detaches (channel = None) instead of
// killing, so the child keeps running and buffering; reattaching swaps a fresh
// channel in and replays the ring. `send` never returns false: the reader must
// outlive a detach. A real exit still ends the reader (EOF after the process
// dies or kill_all), which is what removes the PTY from the manager.
pub struct LocalSink {
    channel: Mutex<Option<Channel<WirePtyEvent>>>,
    ring: Mutex<Scrollback>,
    last_title: Mutex<Option<String>>,
}

impl LocalSink {
    /// A sink with no memory beyond its ring. For a terminal opened before the
    /// app knew where to put transcripts.
    pub fn new(channel: Channel<WirePtyEvent>) -> Self {
        Self {
            channel: Mutex::new(Some(channel)),
            ring: Mutex::new(Scrollback::new(RING_CAP)),
            last_title: Mutex::new(None),
        }
    }

    /// The same, writing everything this terminal prints to `dir`.
    ///
    /// A transcript that cannot be opened is not a terminal that fails to
    /// start: the caller gets a sink either way, and only the memory is lost.
    pub fn recording(channel: Channel<WirePtyEvent>, dir: &Path, thread_id: &str) -> Self {
        let mut ring = Scrollback::new(RING_CAP);
        if let Some(path) = transcript::path_for(dir, thread_id) {
            ring.to_file(&path);
        }
        Self {
            channel: Mutex::new(Some(channel)),
            ring: Mutex::new(ring),
            last_title: Mutex::new(None),
        }
    }

    pub fn set_channel(&self, channel: Option<Channel<WirePtyEvent>>) {
        *lock(&self.channel) = channel;
    }

    // Push the buffered scrollback + last title into the freshly attached
    // channel so the repainted terminal shows the screen before the next write.
    pub fn replay(&self) {
        let guard = lock(&self.channel);
        let Some(channel) = guard.as_ref() else {
            return;
        };
        let ring = lock(&self.ring);
        if !ring.is_empty() {
            let _ = channel.send(WirePtyEvent::Output {
                data: BASE64.encode(ring.snapshot()),
            });
        }
        if let Some(title) = lock(&self.last_title).clone() {
            let _ = channel.send(WirePtyEvent::Title { value: title });
        }
    }
}

impl EventSink for LocalSink {
    fn send(&self, event: PtyEvent) -> bool {
        match &event {
            PtyEvent::Output(bytes) => lock(&self.ring).extend(bytes),
            PtyEvent::Title(value) => {
                *lock(&self.last_title) = Some(value.clone());
            }
            // The end of a run is the one moment the transcript has to be on
            // disk: nothing else will call this sink again.
            PtyEvent::Exit(_) | PtyEvent::Error(_) => lock(&self.ring).flush(),
        }
        if let Some(channel) = lock(&self.channel).as_ref() {
            let wire = match event {
                PtyEvent::Output(bytes) => WirePtyEvent::Output {
                    data: BASE64.encode(&bytes),
                },
                PtyEvent::Title(value) => WirePtyEvent::Title { value },
                PtyEvent::Exit(code) => WirePtyEvent::Exit { code },
                PtyEvent::Error(message) => WirePtyEvent::Error { message },
            };
            let _ = channel.send(wire);
        }
        true
    }
}

struct LocalSession {
    pty_id: String,
    sink: Arc<LocalSink>,
}

// Maps a thread id to its (possibly detached) local PTY so a workspace switch
// can detach instead of kill and a return can reattach.
#[derive(Default, Clone)]
pub struct LocalSessions {
    inner: Arc<Mutex<HashMap<String, LocalSession>>>,
}

impl LocalSessions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, thread_id: String, pty_id: String, sink: Arc<LocalSink>) {
        lock(&self.inner).insert(thread_id, LocalSession { pty_id, sink });
    }

    pub fn get(&self, thread_id: &str) -> Option<(String, Arc<LocalSink>)> {
        lock(&self.inner)
            .get(thread_id)
            .map(|s| (s.pty_id.clone(), s.sink.clone()))
    }

    /// Every thread that still has a PTY here, attached or detached.
    ///
    /// For the snapshot, which exists to be compared against what the rows
    /// claim: a thread whose status says `running` and whose id is not in this
    /// list is the shape of nearly every "my terminal is dead" report.
    pub fn all(&self) -> Vec<(String, String)> {
        lock(&self.inner)
            .iter()
            .map(|(thread_id, s)| (thread_id.clone(), s.pty_id.clone()))
            .collect()
    }

    pub fn detach_by_pty(&self, pty_id: &str) {
        if let Some(s) = lock(&self.inner).values().find(|s| s.pty_id == pty_id) {
            s.sink.set_channel(None);
        }
    }

    pub fn remove_by_pty(&self, pty_id: &str) {
        lock(&self.inner).retain(|_, s| s.pty_id != pty_id);
    }
}

// A poisoned PTY lock is never recoverable mid-session anyway; take the inner
// guard so a panicked sibling thread doesn't cascade into the whole adapter.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
