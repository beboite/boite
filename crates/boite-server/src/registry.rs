use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::broadcast;

use boite_core::pty::{EventSink, PtyEvent, PtyManager, PtySpawnArgs};
use boite_core::status::{self, ThreadStatus};

use crate::events::AppEvent;

const OUTPUT_CHANNEL_CAP: usize = 256;
const WORKING_TTL: Duration = Duration::from_secs(2);
const TICK: Duration = Duration::from_millis(500);

struct StatusState {
    status: ThreadStatus,
    last_working: Option<Instant>,
}

pub struct LiveThread {
    pub thread_id: String,
    pty_id: Mutex<String>,
    ring: Mutex<Ring>,
    output: broadcast::Sender<Arc<Vec<u8>>>,
    title: Mutex<String>,
    status: Mutex<StatusState>,
    size: Mutex<(u16, u16)>,
}

impl LiveThread {
    pub fn pty_id(&self) -> String {
        self.pty_id.lock().clone()
    }
    pub fn status_str(&self) -> String {
        self.status.lock().status.as_str().to_string()
    }
    pub fn title(&self) -> Option<String> {
        let t = self.title.lock().clone();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    }
}

struct Shared {
    threads: Mutex<HashMap<String, Arc<LiveThread>>>,
    events: broadcast::Sender<AppEvent>,
}

pub struct Registry {
    pty: PtyManager,
    scrollback_bytes: usize,
    shared: Arc<Shared>,
}

pub struct AttachSnapshot {
    pub cols: u16,
    pub rows: u16,
    pub replay: Vec<u8>,
    pub rx: broadcast::Receiver<Arc<Vec<u8>>>,
}

impl Registry {
    pub fn new(scrollback_bytes: usize, events: broadcast::Sender<AppEvent>) -> Arc<Registry> {
        let shared = Arc::new(Shared {
            threads: Mutex::new(HashMap::new()),
            events,
        });
        let registry = Arc::new(Registry {
            pty: PtyManager::new(),
            scrollback_bytes,
            shared: shared.clone(),
        });
        spawn_ticker(shared);
        registry
    }

    pub fn live(&self, thread_id: &str) -> Option<Arc<LiveThread>> {
        self.shared.threads.lock().get(thread_id).cloned()
    }

    pub fn live_count(&self) -> usize {
        self.shared.threads.lock().len()
    }

    /// Current scrollback for a thread, used to re-sync a client whose
    /// broadcast receiver lagged (it missed live frames; resend the whole ring
    /// so xterm repaints rather than desyncing on a truncated escape).
    pub fn replay(&self, thread_id: &str) -> Option<Vec<u8>> {
        let live = self.live(thread_id)?;
        let snap = live.ring.lock().snapshot();
        Some(snap)
    }

    /// Snapshot of (thread_id -> (pty_id, status, title)) for thread.list.
    pub fn live_snapshot(&self) -> HashMap<String, (String, String, Option<String>)> {
        self.shared
            .threads
            .lock()
            .iter()
            .map(|(id, lt)| (id.clone(), (lt.pty_id(), lt.status_str(), lt.title())))
            .collect()
    }

    pub fn spawn(&self, thread_id: String, spec: PtySpawnArgs) -> Result<String, String> {
        // Attach-or-spawn is decided by the caller; if a stale live PTY exists
        // for this thread, replace it.
        if let Some(old) = self.shared.threads.lock().remove(&thread_id) {
            let _ = self.pty.kill(&old.pty_id(), false);
        }

        let (output, _) = broadcast::channel(OUTPUT_CHANNEL_CAP);
        let live = Arc::new(LiveThread {
            thread_id: thread_id.clone(),
            pty_id: Mutex::new(String::new()),
            ring: Mutex::new(Ring::new(self.scrollback_bytes)),
            output,
            title: Mutex::new(String::new()),
            status: Mutex::new(StatusState {
                status: ThreadStatus::Running,
                last_working: Some(Instant::now()),
            }),
            size: Mutex::new((spec.cols.max(1), spec.rows.max(1))),
        });

        let sink = Arc::new(ThreadSink {
            shared: self.shared.clone(),
            live: live.clone(),
        });

        let pty_id = self.pty.spawn(sink, spec)?;
        *live.pty_id.lock() = pty_id.clone();
        self.shared.threads.lock().insert(thread_id, live);
        Ok(pty_id)
    }

    /// Subscribe to a thread's output and snapshot its scrollback atomically so
    /// no byte is both replayed and streamed.
    pub fn attach(&self, thread_id: &str, cols: u16, rows: u16) -> Option<AttachSnapshot> {
        let live = self.live(thread_id)?;
        let pty_id = live.pty_id();
        let (replay, rx) = {
            let ring = live.ring.lock();
            (ring.snapshot(), live.output.subscribe())
        };
        // Resize the PTY to the attaching client (last attacher wins).
        let _ = self.pty.resize(&pty_id, cols, rows);
        *live.size.lock() = (cols.max(1), rows.max(1));
        let (c, r) = *live.size.lock();
        Some(AttachSnapshot {
            cols: c,
            rows: r,
            replay,
            rx,
        })
    }

    pub fn write(&self, thread_id: &str, bytes: &[u8]) -> Result<(), String> {
        let live = self.live(thread_id).ok_or("thread not live")?;
        self.pty.write(&live.pty_id(), bytes)
    }

    pub fn resize(&self, thread_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let live = self.live(thread_id).ok_or("thread not live")?;
        *live.size.lock() = (cols.max(1), rows.max(1));
        self.pty.resize(&live.pty_id(), cols, rows)
    }

    /// Kill the PTY. Blocking up to 5s when wait=true; call from a blocking
    /// context. The Exit event removes the thread from the live map.
    pub fn kill(&self, thread_id: &str, wait: bool) -> Result<(), String> {
        let pty_id = match self.live(thread_id) {
            Some(lt) => lt.pty_id(),
            None => return Ok(()),
        };
        self.pty.kill(&pty_id, wait)
    }

    pub fn pty_manager(&self) -> PtyManager {
        self.pty.clone()
    }
}

struct ThreadSink {
    shared: Arc<Shared>,
    live: Arc<LiveThread>,
}

impl ThreadSink {
    fn set_status(&self, next: ThreadStatus, exit_code: Option<i32>) {
        let changed = {
            let mut st = self.live.status.lock();
            if st.status != next {
                st.status = next;
                true
            } else {
                false
            }
        };
        if changed {
            let _ = self.shared.events.send(AppEvent::ThreadStatus {
                thread_id: self.live.thread_id.clone(),
                status: next.as_str().to_string(),
                exit_code,
            });
        }
    }
}

impl EventSink for ThreadSink {
    fn send(&self, event: PtyEvent) -> bool {
        match event {
            PtyEvent::Output(bytes) => {
                let arc = Arc::new(bytes);
                let mut ring = self.live.ring.lock();
                ring.extend(&arc);
                // Send under the ring lock so attach's snapshot+subscribe can't
                // interleave and duplicate or drop a chunk.
                let _ = self.live.output.send(arc);
            }
            PtyEvent::Title(raw) => {
                if status::title_signals_working(&raw) {
                    self.live.status.lock().last_working = Some(Instant::now());
                    self.set_status(ThreadStatus::Running, None);
                }
                if !status::is_generic_title(&raw) {
                    let clean = status::strip_leading_marker(&raw);
                    if !clean.is_empty() {
                        *self.live.title.lock() = clean.clone();
                        let _ = self.shared.events.send(AppEvent::ThreadTitle {
                            thread_id: self.live.thread_id.clone(),
                            title: clean,
                        });
                    }
                }
            }
            PtyEvent::Exit(code) => {
                let st = ThreadStatus::from_exit_code(code);
                {
                    let mut s = self.live.status.lock();
                    s.status = st;
                    s.last_working = None;
                }
                let _ = self.shared.events.send(AppEvent::ThreadStatus {
                    thread_id: self.live.thread_id.clone(),
                    status: st.as_str().to_string(),
                    exit_code: code,
                });
                self.shared.threads.lock().remove(&self.live.thread_id);
            }
            PtyEvent::Error(_) => {}
        }
        true
    }
}

// Demote Running threads to Ready once their last working signal ages out.
fn spawn_ticker(shared: Arc<Shared>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TICK);
        loop {
            interval.tick().await;
            let now = Instant::now();
            let demote: Vec<String> = {
                let threads = shared.threads.lock();
                threads
                    .iter()
                    .filter_map(|(id, lt)| {
                        let st = lt.status.lock();
                        let stale = st
                            .last_working
                            .map(|w| now.duration_since(w) >= WORKING_TTL)
                            .unwrap_or(true);
                        if st.status == ThreadStatus::Running && stale {
                            Some(id.clone())
                        } else {
                            None
                        }
                    })
                    .collect()
            };
            for id in demote {
                if let Some(lt) = shared.threads.lock().get(&id).cloned() {
                    {
                        let mut st = lt.status.lock();
                        if st.status != ThreadStatus::Running {
                            continue;
                        }
                        st.status = ThreadStatus::Ready;
                    }
                    let _ = shared.events.send(AppEvent::ThreadStatus {
                        thread_id: id,
                        status: "ready".to_string(),
                        exit_code: None,
                    });
                }
            }
        }
    });
}

struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
}

impl Ring {
    fn new(cap: usize) -> Ring {
        Ring {
            buf: VecDeque::new(),
            cap,
        }
    }
    fn extend(&mut self, bytes: &[u8]) {
        if bytes.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&bytes[bytes.len() - self.cap..]);
            return;
        }
        self.buf.extend(bytes.iter().copied());
        while self.buf.len() > self.cap {
            self.buf.pop_front();
        }
    }
    fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }
}
