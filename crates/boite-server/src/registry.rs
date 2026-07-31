use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::broadcast;

use boite_core::pty::{EventSink, PtyEvent, PtyManager, PtySpawnArgs};
use boite_core::session::{self, AgentTurn, DeclaredTurn, TurnQuery};
use boite_core::status::{self, ThreadStatus};

use crate::events::AppEvent;

const OUTPUT_CHANNEL_CAP: usize = 256;
/// How long a thread stays Running on an OSC title alone.
///
/// Only the fallback now: a title is edge-triggered, so with nothing else to go
/// on the loop can only wait for the next frame and give up when it stops
/// coming. Claude threads are answered outright by `session::declared_turn` and
/// never reach this.
const WORKING_TTL: Duration = Duration::from_secs(2);
const TICK: Duration = Duration::from_millis(500);
/// The session registry is a directory of small files, re-read on every other
/// tick rather than on each one. A turn boundary is not worth two stat storms a
/// second on a box that may be hosting a dozen threads.
const REGISTRY_TTL: Duration = Duration::from_secs(1);

/// What the thread table knows about a live thread, looked up per tick.
///
/// The registry hosts PTYs; it does not own the threads table, and the two
/// fields it needs to place a thread in claude's session registry live there.
pub struct ThreadIdentity {
    pub icon_key: Option<String>,
    pub session_id: Option<String>,
}

/// Reads a thread's identity out of the store. Returns None for a thread the
/// store has never heard of.
pub type IdentityLookup = Arc<dyn Fn(&str) -> Option<ThreadIdentity> + Send + Sync>;

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
    cwd: String,
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
    events: Arc<dyn Fn(AppEvent) + Send + Sync>,
    identity: IdentityLookup,
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
    // Absolute offset the replay ends at; the client tracks this and sends it
    // back as `since` on the next reattach.
    pub offset: u64,
    // True when the replay is the whole ring (client must clear its terminal
    // first); false when it is a delta the client appends.
    pub reset: bool,
    pub rx: broadcast::Receiver<Arc<Vec<u8>>>,
}

impl Registry {
    pub fn new(
        scrollback_bytes: usize,
        events: Arc<dyn Fn(AppEvent) + Send + Sync>,
        identity: IdentityLookup,
    ) -> Arc<Registry> {
        let shared = Arc::new(Shared {
            threads: Mutex::new(HashMap::new()),
            events,
            identity,
        });
        let registry = Arc::new(Registry {
            pty: PtyManager::new(),
            scrollback_bytes,
            shared: shared.clone(),
        });
        spawn_ticker(shared);
        registry
    }

    #[cfg(test)]
    pub fn new_without_ticker(
        scrollback_bytes: usize,
        events: Arc<dyn Fn(AppEvent) + Send + Sync>,
    ) -> Arc<Registry> {
        let shared = Arc::new(Shared {
            threads: Mutex::new(HashMap::new()),
            events,
            identity: Arc::new(|_| None),
        });
        Arc::new(Registry {
            pty: PtyManager::new(),
            scrollback_bytes,
            shared,
        })
    }

    pub fn live(&self, thread_id: &str) -> Option<Arc<LiveThread>> {
        self.shared.threads.lock().get(thread_id).cloned()
    }

    pub fn live_count(&self) -> usize {
        self.shared.threads.lock().len()
    }

    /// Current scrollback for a thread plus the offset it ends at, used to
    /// re-sync a client whose broadcast receiver lagged (it missed live frames;
    /// resend the whole ring so xterm repaints rather than desyncing on a
    /// truncated escape).
    pub fn replay(&self, thread_id: &str) -> Option<(Vec<u8>, u64)> {
        let live = self.live(thread_id)?;
        let ring = live.ring.lock();
        Some((ring.snapshot(), ring.total()))
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

    pub fn warm_shell_names(&self, shell_id: &str) {
        self.pty.warm_shell_names(shell_id);
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
            cwd: spec.cwd.clone(),
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
    /// no byte is both replayed and streamed. `since` is the client's last known
    /// offset: when it is still inside the ring only the delta is returned
    /// (reset = false); otherwise the whole ring is sent (reset = true).
    pub fn attach(
        &self,
        thread_id: &str,
        cols: u16,
        rows: u16,
        since: Option<u64>,
    ) -> Option<AttachSnapshot> {
        let live = self.live(thread_id)?;
        let pty_id = live.pty_id();
        let (replay, offset, reset, rx) = {
            let ring = live.ring.lock();
            let total = ring.total();
            let (bytes, reset) = match since.and_then(|s| ring.delta_from(s)) {
                Some(delta) => (delta, false),
                None => (ring.snapshot(), true),
            };
            (bytes, total, reset, live.output.subscribe())
        };
        // Resize the PTY to the attaching client (last attacher wins).
        let _ = self.pty.resize(&pty_id, cols, rows);
        *live.size.lock() = (cols.max(1), rows.max(1));
        let (c, r) = *live.size.lock();
        Some(AttachSnapshot {
            cols: c,
            rows: r,
            replay,
            offset,
            reset,
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
    fn emit(&self, event: AppEvent) {
        (self.shared.events)(event);
    }

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
            self.emit(AppEvent::ThreadStatus {
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
                    if !clean.is_empty() && !status::is_project_dir_title(&clean, &self.live.cwd) {
                        // Only on a real change. The agents re-emit their OSC
                        // title every spinner frame with just the leading glyph
                        // rotating, and strip_leading_marker collapses those to
                        // the same string — so emitting unconditionally meant an
                        // UPDATE (and a broadcast to every client) per frame per
                        // thread. The desktop path already coalesces this; see
                        // app/store.svelte.ts scheduleTitleFlush.
                        let changed = {
                            let mut current = self.live.title.lock();
                            if *current != clean {
                                *current = clean.clone();
                                true
                            } else {
                                false
                            }
                        };
                        if changed {
                            self.emit(AppEvent::ThreadTitle {
                                thread_id: self.live.thread_id.clone(),
                                title: clean,
                            });
                        }
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
                self.emit(AppEvent::ThreadStatus {
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

/// What a thread's status should become, or None to leave it alone.
///
/// Claude answers for itself:
///
/// - `busy` holds the thread Running however quiet the terminal has gone, which
///   is what a subagent looks like from out here: the Task tool runs in the
///   parent process, so the parent stays `busy` for the whole run while emitting
///   nothing.
/// - `waiting` is its own status rather than Ready. A permission prompt is a turn
///   still in flight, and calling it finished is both the wrong thing to show and
///   the wrong thing to let auto-sleep act on.
/// - `shell` reads as Ready: the agent takes input again, even though something
///   it started is still running.
/// - `idle` demotes at once, without waiting for a title that is never coming.
///
/// With no answer at all it falls back to the OSC title and its TTL, which can
/// only ever conclude that a Running thread has gone quiet.
fn next_status(
    status: ThreadStatus,
    last_working: Option<Instant>,
    declared: DeclaredTurn,
    now: Instant,
) -> Option<ThreadStatus> {
    let settled = match declared {
        DeclaredTurn::Busy => ThreadStatus::Running,
        DeclaredTurn::Waiting => ThreadStatus::Waiting,
        DeclaredTurn::Shell | DeclaredTurn::Idle => ThreadStatus::Ready,
        DeclaredTurn::Unknown => {
            let stale = last_working
                .map(|w| now.duration_since(w) >= WORKING_TTL)
                .unwrap_or(true);
            // Waiting ages out the same way. It is only ever set from an answer,
            // so losing the answer (claude exited, the registry went away) leaves
            // nothing that could ever clear it, and a status nothing can clear is
            // the bug this whole loop exists to not have.
            let live = matches!(status, ThreadStatus::Running | ThreadStatus::Waiting);
            if live && stale {
                ThreadStatus::Ready
            } else {
                return None;
            }
        }
    };
    // Only the three live statuses are this loop's to decide. A thread that has
    // exited or been stopped has a real status and must keep it.
    if !matches!(
        status,
        ThreadStatus::Ready | ThreadStatus::Running | ThreadStatus::Waiting
    ) {
        return None;
    }
    (settled != status).then_some(settled)
}

// Keeps Ready/Running/Waiting honest: the agent's own answer where there is one,
// the OSC title's TTL otherwise.
fn spawn_ticker(shared: Arc<Shared>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TICK);
        let mut turns: Vec<AgentTurn> = Vec::new();
        let mut turns_read_at: Option<Instant> = None;
        // Identities alongside the turns read, on the same expiry. Without it this
        // loop would query the thread table once per live thread twice a second,
        // forever, to re-learn two columns that almost never change.
        let mut identities: HashMap<String, Option<ThreadIdentity>> = HashMap::new();
        loop {
            interval.tick().await;
            let now = Instant::now();
            // Snapshotted, so the identity lookup, which reads the thread table,
            // never runs while the live-thread map is locked against spawns
            // and attaches. Deciding and applying then happen under the one
            // per-thread status lock, so a title or an exit landing in between
            // cannot be overwritten by a decision taken before it.
            let live_threads: Vec<Arc<LiveThread>> =
                shared.threads.lock().values().cloned().collect();

            // Nothing to judge, and nothing worth keeping either: a thread
            // spawning inside REGISTRY_TTL would otherwise be measured against
            // turns collected before it existed.
            if live_threads.is_empty() {
                turns.clear();
                turns_read_at = None;
                identities.clear();
                continue;
            }

            if turns_read_at
                .map(|at| now.duration_since(at) >= REGISTRY_TTL)
                .unwrap_or(true)
            {
                identities.clear();
                // Asked for exactly the threads that are running. Each agent's
                // store costs a directory read or a database open, so an empty
                // boite reads nothing and a busy one reads once per agent.
                let queries: Vec<TurnQuery> = live_threads
                    .iter()
                    .filter_map(|lt| {
                        let who = identities
                            .entry(lt.thread_id.clone())
                            .or_insert_with(|| (shared.identity)(&lt.thread_id));
                        let kind = who.as_ref()?.icon_key.clone()?;
                        Some(TurnQuery {
                            kind,
                            session_id: who.as_ref().and_then(|w| w.session_id.clone()),
                            cwd: lt.cwd.clone(),
                        })
                    })
                    .collect();
                // Off the async workers: a directory walk plus two SQLite opens
                // plus a 256 KiB read, once a second for the life of the process,
                // is not something a tokio worker may sit on.
                turns = if queries.is_empty() {
                    Vec::new()
                } else {
                    tokio::task::spawn_blocking(move || session::agent_turns(&queries))
                        .await
                        .unwrap_or_default()
                };
                turns_read_at = Some(now);
            }

            let mut changed = Vec::new();
            for lt in live_threads {
                // Scoped by agent: two of them in one directory is ordinary, and a
                // codex thread has no business being handed a claude answer.
                let declared = if turns.is_empty() {
                    DeclaredTurn::Unknown
                } else {
                    let who = identities
                        .entry(lt.thread_id.clone())
                        .or_insert_with(|| (shared.identity)(&lt.thread_id));
                    match who.as_ref().and_then(|w| w.icon_key.as_deref()) {
                        Some(kind) => session::declared_turn(
                            &turns,
                            kind,
                            who.as_ref().and_then(|w| w.session_id.as_deref()),
                            &lt.cwd,
                        ),
                        None => DeclaredTurn::Unknown,
                    }
                };
                let mut st = lt.status.lock();
                // Any active answer refreshes the anchor, so if the registry later
                // goes silent the TTL ages out from the last thing claude actually
                // said rather than from whenever a title last arrived.
                if declared.is_active() {
                    st.last_working = Some(now);
                }
                let Some(next) = next_status(st.status, st.last_working, declared, now) else {
                    continue;
                };
                st.status = next;
                drop(st);
                changed.push((lt.thread_id.clone(), next));
            }

            for (id, next) in changed {
                (shared.events)(AppEvent::ThreadStatus {
                    thread_id: id,
                    status: next.as_str().to_string(),
                    exit_code: None,
                });
            }
        }
    });
}

struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
    // Absolute count of bytes ever written. The oldest byte still in `buf` sits
    // at offset `written - buf.len()`; clients track this offset so a reattach
    // (reconnect or unhide) can ask for just the delta instead of the full ring.
    written: u64,
}

impl Ring {
    fn new(cap: usize) -> Ring {
        Ring {
            buf: VecDeque::new(),
            cap,
            written: 0,
        }
    }
    fn extend(&mut self, bytes: &[u8]) {
        self.written += bytes.len() as u64;
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
    fn total(&self) -> u64 {
        self.written
    }
    fn start(&self) -> u64 {
        self.written - self.buf.len() as u64
    }
    fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }
    /// Bytes written since absolute offset `since`, or None if `since` fell out
    /// of the ring (caller must send a full snapshot + reset instead). An empty
    /// vec means the client is already current.
    fn delta_from(&self, since: u64) -> Option<Vec<u8>> {
        if since < self.start() || since > self.written {
            return None;
        }
        let skip = (since - self.start()) as usize;
        Some(self.buf.iter().skip(skip).copied().collect())
    }
}

#[cfg(test)]
mod status_tests {
    use super::*;

    fn ago(d: Duration) -> Option<Instant> {
        Instant::now().checked_sub(d)
    }

    #[test]
    fn a_busy_session_holds_a_quiet_thread_running() {
        // The subagent case. The Task tool runs in claude's own process, so the
        // terminal can print nothing for minutes while a turn is very much in
        // flight, and the TTL alone would have demoted it on the fourth tick.
        let stale = ago(Duration::from_secs(600));
        assert_eq!(
            next_status(ThreadStatus::Running, stale, DeclaredTurn::Busy, Instant::now()),
            None,
            "already Running: nothing to change"
        );
        assert_eq!(
            next_status(ThreadStatus::Ready, stale, DeclaredTurn::Busy, Instant::now()),
            Some(ThreadStatus::Running),
            "a turn started without a title to announce it"
        );
    }

    #[test]
    fn an_idle_session_demotes_without_waiting_for_the_ttl() {
        // The reported bug, from the other side: the agent has finished and said
        // so, and there is no next title frame to fail to arrive.
        let fresh = Some(Instant::now());
        assert_eq!(
            next_status(ThreadStatus::Running, fresh, DeclaredTurn::Idle, Instant::now()),
            Some(ThreadStatus::Ready),
        );
        assert_eq!(
            next_status(ThreadStatus::Ready, fresh, DeclaredTurn::Idle, Instant::now()),
            None,
        );
    }

    #[test]
    fn without_an_answer_the_title_ttl_still_decides() {
        let now = Instant::now();
        assert_eq!(
            next_status(ThreadStatus::Running, ago(Duration::from_secs(5)), DeclaredTurn::Unknown, now),
            Some(ThreadStatus::Ready),
        );
        assert_eq!(
            next_status(ThreadStatus::Running, Some(now), DeclaredTurn::Unknown, now),
            None,
            "signal still fresh",
        );
        assert_eq!(
            next_status(ThreadStatus::Running, None, DeclaredTurn::Unknown, now),
            Some(ThreadStatus::Ready),
            "never signalled at all",
        );
    }

    #[test]
    fn a_finished_thread_keeps_its_real_status() {
        // Exit codes and stops are not this loop's to overwrite, whatever a
        // leftover registry entry says.
        let now = Instant::now();
        for status in [
            ThreadStatus::Done,
            ThreadStatus::Exited,
            ThreadStatus::Error,
            ThreadStatus::Stopped,
            ThreadStatus::Idle,
        ] {
            for declared in [DeclaredTurn::Busy, DeclaredTurn::Idle, DeclaredTurn::Unknown] {
                assert_eq!(next_status(status, None, declared, now), None, "{status:?}");
            }
        }
    }
}
