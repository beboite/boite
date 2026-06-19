use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use tauri::ipc::Channel;

use boite_core::pty::{EventSink, PtyEvent};

use crate::commands::WirePtyEvent;

// Scrollback kept per detached local PTY so a reattaching terminal isn't blank
// until the next byte. Matches tmux-ish "recent screen" behavior, not full
// history.
const RING_CAP: usize = 256 * 1024;

// Output sink for a local PTY with a *detachable* channel plus a scrollback
// ring. On a workspace switch the desktop detaches (channel = None) instead of
// killing, so the child keeps running and buffering; reattaching swaps a fresh
// channel in and replays the ring. `send` never returns false: the reader must
// outlive a detach. A real exit still ends the reader (EOF after the process
// dies or kill_all), which is what removes the PTY from the manager.
pub struct LocalSink {
    channel: Mutex<Option<Channel<WirePtyEvent>>>,
    ring: Mutex<VecDeque<u8>>,
    last_title: Mutex<Option<String>>,
}

impl LocalSink {
    pub fn new(channel: Channel<WirePtyEvent>) -> Self {
        Self {
            channel: Mutex::new(Some(channel)),
            ring: Mutex::new(VecDeque::new()),
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
            let bytes: Vec<u8> = ring.iter().copied().collect();
            let _ = channel.send(WirePtyEvent::Output {
                data: BASE64.encode(&bytes),
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
            PtyEvent::Output(bytes) => {
                let mut ring = lock(&self.ring);
                ring.extend(bytes.iter().copied());
                let overflow = ring.len().saturating_sub(RING_CAP);
                if overflow > 0 {
                    ring.drain(0..overflow);
                }
            }
            PtyEvent::Title(value) => {
                *lock(&self.last_title) = Some(value.clone());
            }
            _ => {}
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
