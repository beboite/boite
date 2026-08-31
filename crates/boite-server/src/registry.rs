use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::broadcast;

use boite_core::checkpoint::{self, Edge};
use boite_core::pty::{EventSink, PtyEvent, PtyManager, PtySpawnArgs};
use boite_core::session::{self, AgentTurn, DeclaredTurn, TurnQuery};
use boite_core::status::{self, ThreadStatus};
use boite_core::transcript::{self, Scrollback};

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

/// One connected client, for the length of one websocket connection.
///
/// Per connection rather than per attachment: a device holds one socket and
/// watches several terminals through it, and it is the same pair of eyes at the
/// same size in all of them.
pub type ClientId = u64;

/// Hands out the next client id. Process-wide and never reused, so a
/// reconnecting device is a new client and cannot inherit the ownership its
/// previous socket held.
pub fn new_client_id() -> ClientId {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// What one attached client last told us about itself.
struct ClientView {
    size: (u16, u16),
    /// Tick of this client's last keystroke, on [`Sizing::clock`]. `None` until
    /// it types.
    typed_at: Option<u64>,
    /// Tick of its last attach, on the same clock.
    attached_at: u64,
}

impl ClientView {
    /// How this client ranks for taking the terminal over. Somebody who has
    /// typed always beats somebody who has only ever watched, however recently
    /// the watcher arrived: opening a terminal is not a claim on its shape,
    /// which is the whole rule this file exists to hold.
    fn standing(&self) -> (Option<u64>, u64) {
        (self.typed_at, self.attached_at)
    }
}

/// Who the PTY is sized for, when several devices are watching it.
///
/// A PTY has one size and a thread can have a laptop and a phone attached to it
/// at once. Sizing it to whoever attached last meant a phone opening a terminal
/// just to read it reflowed the laptop that was typing into it, mid-command.
///
/// So the size follows whoever is *driving*: the client that last sent input,
/// and until anybody has typed, the one that attached last. Everyone else is
/// watching, and a watcher may never move the PTY. Their size is still recorded,
/// because a watcher that starts typing becomes the driver and the PTY has to
/// fit it immediately.
///
/// Every method returns the size the caller must push to the PTY, or `None`
/// when nothing moved. That keeps the whole rule pure and testable without a
/// process on the other end, and keeps the `resize` syscall off this lock.
struct Sizing {
    /// The size the PTY is at right now.
    pty: (u16, u16),
    clients: HashMap<ClientId, ClientView>,
    owner: Option<ClientId>,
    /// Monotonic and local: ordering activity is all this needs, and a wall
    /// clock stepping backwards would reorder it.
    clock: u64,
}

impl Sizing {
    fn new(cols: u16, rows: u16) -> Sizing {
        Sizing {
            pty: (cols.max(1), rows.max(1)),
            clients: HashMap::new(),
            owner: None,
            clock: 0,
        }
    }

    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// Moves the PTY, whether or not it is already that size. What a client
    /// driving the terminal asked for is passed on as asked: a redundant
    /// SIGWINCH is what the single-client path has always sent, and a full-screen
    /// app redrawing on one is not this layer's business.
    fn set(&mut self, size: (u16, u16)) -> Option<(u16, u16)> {
        self.pty = size;
        Some(size)
    }

    /// Moves the PTY only if it is not already there. For the handovers, which
    /// nobody asked for: a client taking over at the size the terminal already
    /// has must not shake every attached view for nothing.
    fn set_if_changed(&mut self, size: (u16, u16)) -> Option<(u16, u16)> {
        (self.pty != size).then(|| {
            self.pty = size;
            size
        })
    }

    /// A client opened this terminal. Alone it owns the size, which is what a
    /// single-client attach has always done. Joining others it only registers
    /// its shape and adopts theirs.
    fn attach(&mut self, client: ClientId, cols: u16, rows: u16) -> Option<(u16, u16)> {
        let at = self.tick();
        let size = (cols.max(1), rows.max(1));
        // A re-attach keeps whatever this client had already earned by typing.
        let typed_at = self.clients.get(&client).and_then(|v| v.typed_at);
        self.clients.insert(
            client,
            ClientView {
                size,
                typed_at,
                attached_at: at,
            },
        );
        if self.clients.len() == 1 || self.owner == Some(client) {
            self.owner = Some(client);
            return self.set(size);
        }
        None
    }

    /// An explicit resize. The owner's applies; anybody else's is recorded and
    /// goes no further, so a phone refitting its xterm cannot shrink the laptop.
    fn resize(&mut self, client: ClientId, cols: u16, rows: u16) -> Option<(u16, u16)> {
        let size = (cols.max(1), rows.max(1));
        let Some(view) = self.clients.get_mut(&client) else {
            // Nobody is attached, so there is nobody to protect and no recorded
            // size to protect them with. With an owner in place this is a stale
            // frame from a client that has already detached: drop it.
            return self.owner.is_none().then(|| self.set(size)).flatten();
        };
        view.size = size;
        (self.owner == Some(client))
            .then(|| self.set(size))
            .flatten()
    }

    /// A keystroke. Typing is what makes a client the one driving, so it takes
    /// the size with it.
    fn input(&mut self, client: ClientId) -> Option<(u16, u16)> {
        let at = self.tick();
        // Not attached: `thread.reply` reaches a PTY from a device that never
        // opened this terminal, and a device with no view of it has no size to
        // impose on the ones that do.
        let view = self.clients.get_mut(&client)?;
        view.typed_at = Some(at);
        let size = view.size;
        if self.owner == Some(client) {
            return None;
        }
        self.owner = Some(client);
        self.set_if_changed(size)
    }

    /// A client left. If it was the owner, the client with the best standing
    /// left takes over (last keystroke, or failing that last attach) and the PTY
    /// goes back to that client's own size.
    fn detach(&mut self, client: ClientId) -> Option<(u16, u16)> {
        self.clients.remove(&client);
        if self.owner != Some(client) {
            return None;
        }
        // Tie-broken on the id so the successor is deterministic; a tie only
        // happens between clients that have done nothing since attaching.
        let next = self
            .clients
            .iter()
            .max_by_key(|(id, view)| (view.standing(), **id))
            .map(|(id, view)| (*id, view.size));
        match next {
            Some((id, size)) => {
                self.owner = Some(id);
                self.set_if_changed(size)
            }
            None => {
                self.owner = None;
                None
            }
        }
    }
}

struct StatusState {
    status: ThreadStatus,
    last_working: Option<Instant>,
    /// Whether a turn is open, in the agent's own vocabulary rather than the
    /// thread status beside it. The two are not the same question: `shell` and
    /// `waiting` both read as Ready and neither ends a turn, so a checkpoint
    /// driven off `status` would cut a turn in half at every permission prompt.
    turn_open: bool,
}

pub struct LiveThread {
    pub thread_id: String,
    pty_id: Mutex<String>,
    ring: Mutex<Scrollback>,
    output: broadcast::Sender<Arc<Vec<u8>>>,
    title: Mutex<String>,
    status: Mutex<StatusState>,
    /// The PTY's size and who among the attached clients gets to decide it.
    sizing: Mutex<Sizing>,
    cwd: String,
    /// Held for the length of one capture, so this thread never has two in
    /// flight at once.
    ///
    /// A capture reads the thread's refs to pick the next index, then writes
    /// `refs/boite/ckpt/<thread>/<n>`. Two of them overlapping read the same
    /// list, land on the same `n`, and the second `update-ref` replaces the
    /// first without a word: one checkpoint gone, and the survivor carries the
    /// wrong edge, so the pairing downstream brackets a turn with a checkpoint
    /// from a different one and the revert button offers the wrong tree. The
    /// overlap is ordinary rather than rare, because a turn short enough to
    /// open and close inside two ticks queues its second capture while the
    /// first is still walking the worktree.
    ///
    /// Async and per thread: waiting on it must not hold a blocking-pool
    /// thread, and one thread's slow `add -A` has no business delaying
    /// another's. Tokio's mutex hands the lock out in the order it was asked
    /// for, which is what keeps a start from being written after its own end.
    /// The mirror of `inFlight` in `checkpoints.svelte.ts`, which is the same
    /// rule for the host that has a window.
    capture_lock: Arc<tokio::sync::Mutex<()>>,
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
    /// Where a thread's whole run is written, as opposed to the last few
    /// hundred kilobytes the ring holds. `None` in the tests, and in a server
    /// that could not make the directory: a terminal with no memory still
    /// works.
    transcripts: Option<PathBuf>,
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
        transcripts: Option<PathBuf>,
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
            transcripts,
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
            transcripts: None,
            shared,
        })
    }

    /// Where this server writes what its terminals print, if it writes it.
    pub fn transcripts_dir(&self) -> Option<PathBuf> {
        self.transcripts.clone()
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
        // The ring is what a reattaching client repaints from; the file is what
        // is still there tomorrow. A thread whose transcript cannot be opened
        // keeps its terminal and loses only its memory, so the failure is a
        // warning rather than a refusal to spawn.
        let mut ring = Scrollback::new(self.scrollback_bytes);
        if let Some(dir) = &self.transcripts {
            match transcript::path_for(dir, &thread_id) {
                Some(path) if ring.to_file(&path) => {}
                _ => tracing::warn!("thread {thread_id} runs without a transcript"),
            }
        }
        let live = Arc::new(LiveThread {
            thread_id: thread_id.clone(),
            pty_id: Mutex::new(String::new()),
            ring: Mutex::new(ring),
            output,
            title: Mutex::new(String::new()),
            status: Mutex::new(StatusState {
                status: ThreadStatus::Running,
                last_working: Some(Instant::now()),
                turn_open: false,
            }),
            sizing: Mutex::new(Sizing::new(spec.cols, spec.rows)),
            cwd: spec.cwd.clone(),
            capture_lock: Arc::new(tokio::sync::Mutex::new(())),
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
        client: ClientId,
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
        // The PTY is sized for whoever is driving it, not for whoever arrived
        // last. Alone, that is this client and the PTY takes its size. Joining
        // a terminal somebody else is typing into, it adopts the size already
        // there and gets it back in the snapshot, so a phone opening a terminal
        // to read it cannot reflow the laptop's command. See `Sizing`.
        let (want, c, r) = {
            let mut sizing = live.sizing.lock();
            let want = sizing.attach(client, cols, rows);
            let (c, r) = sizing.pty;
            (want, c, r)
        };
        if let Some((cols, rows)) = want {
            let _ = self.pty.resize(&pty_id, cols, rows);
        }
        Some(AttachSnapshot {
            cols: c,
            rows: r,
            replay,
            offset,
            reset,
            rx,
        })
    }

    /// Bytes into a PTY from something that is not a terminal a client is
    /// looking at: `thread.reply`, which a device that never attached is
    /// allowed to make. It moves no size, because the caller has no view of
    /// this terminal to move it to.
    pub fn write(&self, thread_id: &str, bytes: &[u8]) -> Result<(), String> {
        let live = self.live(thread_id).ok_or("thread not live")?;
        self.pty.write(&live.pty_id(), bytes)
    }

    /// Keystrokes from an attached client. Typing is what makes a client the
    /// one driving the terminal, so it takes the size with it: the PTY moves to
    /// this client's own size before the bytes go in.
    pub fn input(&self, thread_id: &str, client: ClientId, bytes: &[u8]) -> Result<(), String> {
        let live = self.live(thread_id).ok_or("thread not live")?;
        let want = live.sizing.lock().input(client);
        if let Some((cols, rows)) = want {
            let _ = self.pty.resize(&live.pty_id(), cols, rows);
        }
        self.pty.write(&live.pty_id(), bytes)
    }

    /// A client's terminal changed shape. The one driving moves the PTY; a
    /// watcher's new size is recorded and applied only if it later starts
    /// typing.
    pub fn resize(
        &self,
        thread_id: &str,
        client: ClientId,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let live = self.live(thread_id).ok_or("thread not live")?;
        let want = live.sizing.lock().resize(client, cols, rows);
        match want {
            Some((cols, rows)) => self.pty.resize(&live.pty_id(), cols, rows),
            None => Ok(()),
        }
    }

    /// A client closed this terminal, or its socket went away. If it was the
    /// one driving, the most recently active client left takes over and the PTY
    /// goes back to that client's size. The last one out changes nothing: the
    /// PTY keeps the shape it had, as it always has.
    pub fn detach(&self, thread_id: &str, client: ClientId) {
        let Some(live) = self.live(thread_id) else {
            return;
        };
        let want = live.sizing.lock().detach(client);
        if let Some((cols, rows)) = want {
            let _ = self.pty.resize(&live.pty_id(), cols, rows);
        }
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

    /// Whether this sink still speaks for the thread it was created with.
    ///
    /// `spawn` replaces a stale PTY and inserts the new `LiveThread` under the
    /// same key without waiting for the old one to die, and the old PTY reports
    /// its exit from its own OS thread. So an event can arrive from a PTY that
    /// has already been superseded, and acting on it means speaking for a
    /// process that is not the one running.
    fn is_current(&self) -> bool {
        self.shared
            .threads
            .lock()
            .get(&self.live.thread_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.live))
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
                        // Checked only once the title actually moved, so a
                        // superseded PTY cannot rename the thread that replaced
                        // it and the lock stays off the per-frame path.
                        if changed && self.is_current() {
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
                // A superseded PTY announces its own death, never the thread's.
                // Removing the entry here without checking dropped the live
                // thread of a process that was still running: `kill` then found
                // nothing to kill and returned Ok, every client was told the
                // thread had exited, and the PTY stayed alive with no way left
                // to reach it.
                if !self.is_current() {
                    return true;
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
            let mut edges = Vec::new();
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
                // Before the early return below, because a turn can open and
                // close without the thread's status changing at all: a turn
                // short enough to land inside one tick leaves `next_status`
                // with nothing to say and still has two ends worth keeping.
                if let Some(edge) = turn_edge(st.turn_open, declared) {
                    st.turn_open = edge == Edge::Start;
                    edges.push((
                        lt.thread_id.clone(),
                        lt.cwd.clone(),
                        edge,
                        lt.capture_lock.clone(),
                    ));
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

            for (id, cwd, edge, lock) in edges {
                // Detached and never awaited. A capture walks a whole worktree,
                // so awaiting it here would put the length of a `git add -A`
                // between a turn ending and the next tick noticing anything —
                // and a checkpoint is never allowed to hold a turn up.
                tokio::spawn(async move {
                    // Queued behind this thread's own previous capture, and
                    // only that one: see `LiveThread::capture_lock`.
                    let _queued = lock.lock().await;
                    let logged = id.clone();
                    let done = tokio::task::spawn_blocking(move || {
                        checkpoint::capture_blocking(&cwd, &id, edge)
                    })
                    .await;
                    match done {
                        Ok(Err(err)) => eprintln!("[boite/checkpoint] {logged}: {err}"),
                        // The capture panicked, or the runtime is going down
                        // mid-shutdown. Neither is worth more than a line: the
                        // turn it belongs to has already happened.
                        Err(err) => eprintln!("[boite/checkpoint] {logged}: {err}"),
                        Ok(Ok(_)) => {}
                    }
                });
            }
        }
    });
}

/// Which end of a turn just happened, if either.
///
/// Only `busy` opens one and only `idle` closes one. `waiting` is a turn still
/// in flight behind a prompt and `shell` is a command the agent launched, so
/// neither is an edge — and `unknown` is the absence of an answer, which must
/// not be read as the end of anything.
fn turn_edge(open: bool, declared: DeclaredTurn) -> Option<Edge> {
    match declared {
        DeclaredTurn::Busy if !open => Some(Edge::Start),
        DeclaredTurn::Idle if open => Some(Edge::End),
        _ => None,
    }
}



#[cfg(test)]
mod sizing_tests {
    use super::*;

    const LAPTOP: ClientId = 1;
    const PHONE: ClientId = 2;
    const TABLET: ClientId = 3;

    /// One device, which is every terminal in the workspace most of the time.
    /// Attaching sizes the PTY and every resize it sends lands, exactly as
    /// before any of this existed.
    #[test]
    fn one_client_still_owns_its_terminal_outright() {
        let mut s = Sizing::new(80, 24);
        assert_eq!(s.attach(LAPTOP, 160, 50), Some((160, 50)));
        assert_eq!(s.resize(LAPTOP, 120, 40), Some((120, 40)));
        // Even to the size it already is: a client driving its own terminal
        // gets the SIGWINCH it asked for.
        assert_eq!(s.resize(LAPTOP, 120, 40), Some((120, 40)));
        assert_eq!(s.pty, (120, 40));
        // Nothing to hand over to, and nothing to undo.
        assert_eq!(s.detach(LAPTOP), None);
        assert_eq!(s.pty, (120, 40));
    }

    /// The bug. A phone opening a terminal to watch it used to resize the PTY
    /// under the laptop that was typing into it.
    #[test]
    fn a_second_client_attaching_does_not_shrink_the_first() {
        let mut s = Sizing::new(80, 24);
        s.attach(LAPTOP, 160, 50);
        assert_eq!(s.attach(PHONE, 40, 20), None, "a watcher moves nothing");
        assert_eq!(s.pty, (160, 50));
        assert_eq!(s.owner, Some(LAPTOP));
    }

    /// A watcher's refit is remembered and goes no further. The web client
    /// fits its xterm on mount and sends one within a few hundred milliseconds
    /// of attaching, so this is the ordinary path rather than an edge.
    #[test]
    fn a_watcher_resize_is_recorded_and_never_reaches_the_pty() {
        let mut s = Sizing::new(80, 24);
        s.attach(LAPTOP, 160, 50);
        s.attach(PHONE, 40, 20);
        assert_eq!(s.resize(PHONE, 30, 15), None);
        assert_eq!(s.pty, (160, 50), "the laptop's command kept its width");
        assert_eq!(s.clients[&PHONE].size, (30, 15), "but we know its shape");
        // And the recorded shape is the one it gets the moment it types.
        assert_eq!(s.input(PHONE), Some((30, 15)));
    }

    /// Typing is what makes a client the one driving, and the PTY follows it
    /// the same tick.
    #[test]
    fn input_takes_ownership_and_the_pty_with_it() {
        let mut s = Sizing::new(80, 24);
        s.attach(LAPTOP, 160, 50);
        s.attach(PHONE, 40, 20);
        assert_eq!(s.input(PHONE), Some((40, 20)));
        assert_eq!(s.owner, Some(PHONE));
        // Already driving: every further keystroke is free.
        assert_eq!(s.input(PHONE), None);
        // And now the laptop is the watcher, so its refit stays local.
        assert_eq!(s.resize(LAPTOP, 200, 60), None);
        assert_eq!(s.pty, (40, 20));
        // A handover to a client the PTY already fits shakes nobody.
        s.attach(TABLET, 40, 20);
        assert_eq!(s.input(TABLET), None);
        assert_eq!(s.owner, Some(TABLET));
    }

    /// The owner leaving hands the terminal to whoever was busiest, and the PTY
    /// goes back to that client's own size rather than sitting at the departed
    /// one's.
    #[test]
    fn the_owner_leaving_hands_over_to_the_most_recently_active_client() {
        let mut s = Sizing::new(80, 24);
        s.attach(LAPTOP, 160, 50);
        s.attach(PHONE, 40, 20);
        s.attach(TABLET, 100, 30);
        s.input(PHONE);
        assert_eq!(s.owner, Some(PHONE));

        assert_eq!(s.detach(PHONE), Some((100, 30)), "the tablet attached last");
        assert_eq!(s.owner, Some(TABLET));
        assert_eq!(s.pty, (100, 30));

        // A watcher leaving is nobody's business.
        assert_eq!(s.detach(LAPTOP), None);
        assert_eq!(s.owner, Some(TABLET));
        // Last one out: the PTY keeps whatever it had.
        assert_eq!(s.detach(TABLET), None);
        assert_eq!(s.owner, None);
        assert_eq!(s.pty, (100, 30));
    }

    /// Having typed beats having just arrived, however late the arrival. A
    /// device that only ever watched must not inherit the terminal's shape over
    /// one that was using it, or the original bug comes back through the
    /// handover instead of through the attach.
    #[test]
    fn handover_prefers_the_client_that_typed_over_the_one_that_only_watched() {
        let mut s = Sizing::new(80, 24);
        s.attach(LAPTOP, 160, 50);
        s.attach(PHONE, 40, 20);
        s.input(PHONE);
        s.attach(TABLET, 100, 30);
        // The tablet arrived after the phone typed, and neither of those moved
        // ownership: the phone is still driving.
        assert_eq!(s.owner, Some(PHONE));
        s.input(LAPTOP);
        assert_eq!(s.owner, Some(LAPTOP));
        assert_eq!(
            s.detach(LAPTOP),
            Some((40, 20)),
            "the phone typed; the tablet only opened the terminal"
        );
        assert_eq!(s.owner, Some(PHONE));
    }

    /// A client re-attaching (a reconnect, or a second `thread.attach` on the
    /// same socket) is not a new watcher. Still driving, it still moves the PTY.
    #[test]
    fn the_owner_reattaching_still_sizes_the_pty() {
        let mut s = Sizing::new(80, 24);
        s.attach(LAPTOP, 160, 50);
        s.attach(PHONE, 40, 20);
        assert_eq!(s.attach(LAPTOP, 120, 40), Some((120, 40)));
        assert_eq!(s.clients.len(), 2, "the same client, not a third one");
        assert_eq!(s.owner, Some(LAPTOP));
    }

    /// A resize from a socket with no attachment. Nobody attached means nobody
    /// to protect; an owner in place means this is a frame from a client that
    /// has already gone, and it has no say.
    #[test]
    fn a_resize_from_an_unattached_client_only_lands_on_an_empty_terminal() {
        let mut s = Sizing::new(80, 24);
        assert_eq!(s.resize(LAPTOP, 100, 30), Some((100, 30)));
        assert_eq!(s.clients.len(), 0, "nothing was recorded for it");

        s.attach(PHONE, 40, 20);
        assert_eq!(s.resize(LAPTOP, 200, 60), None);
        assert_eq!(s.pty, (40, 20));
        // Same for a stray keystroke: `thread.reply` reaches a PTY from a
        // device that never opened this terminal.
        assert_eq!(s.input(LAPTOP), None);
        assert_eq!(s.owner, Some(PHONE));
    }

    /// Zero is not a terminal size, whichever door it comes in through.
    #[test]
    fn a_degenerate_size_is_clamped_rather_than_passed_on() {
        let mut s = Sizing::new(0, 0);
        assert_eq!(s.pty, (1, 1));
        assert_eq!(s.attach(LAPTOP, 0, 0), Some((1, 1)));
        assert_eq!(s.resize(LAPTOP, 0, 30), Some((1, 30)));
    }
}

#[cfg(test)]
mod status_tests {
    use super::*;

    fn ago(d: Duration) -> Option<Instant> {
        Instant::now().checked_sub(d)
    }

    /// A permission prompt in the middle of a turn is still the same turn, and a
    /// shell the agent launched is not a turn at all. Getting this wrong is a
    /// checkpoint per dialog, which is the whole list made useless.
    #[test]
    fn only_busy_opens_a_turn_and_only_idle_closes_one() {
        assert_eq!(turn_edge(false, DeclaredTurn::Busy), Some(Edge::Start));
        assert_eq!(turn_edge(true, DeclaredTurn::Busy), None);
        assert_eq!(turn_edge(true, DeclaredTurn::Idle), Some(Edge::End));
        assert_eq!(turn_edge(false, DeclaredTurn::Idle), None);
        for open in [true, false] {
            for declared in [
                DeclaredTurn::Waiting,
                DeclaredTurn::Shell,
                DeclaredTurn::Unknown,
            ] {
                assert_eq!(turn_edge(open, declared), None, "{declared:?} open={open}");
            }
        }
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

#[cfg(test)]
mod sink_tests {
    use super::*;

    fn live(thread_id: &str, pty_id: &str) -> Arc<LiveThread> {
        let (output, _) = broadcast::channel(OUTPUT_CHANNEL_CAP);
        Arc::new(LiveThread {
            thread_id: thread_id.to_string(),
            pty_id: Mutex::new(pty_id.to_string()),
            ring: Mutex::new(Scrollback::new(1024)),
            output,
            title: Mutex::new(String::new()),
            status: Mutex::new(StatusState {
                status: ThreadStatus::Running,
                last_working: Some(Instant::now()),
                turn_open: false,
            }),
            sizing: Mutex::new(Sizing::new(80, 24)),
            cwd: String::new(),
            capture_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    fn shared() -> (Arc<Shared>, Arc<Mutex<Vec<AppEvent>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let shared = Arc::new(Shared {
            threads: Mutex::new(HashMap::new()),
            events: Arc::new(move |e| sink.lock().push(e)),
            identity: Arc::new(|_| None),
        });
        (shared, seen)
    }

    /// The reattach race. `spawn` replaces a stale PTY and inserts the new live
    /// thread without waiting for the old one to die, so the old PTY's exit can
    /// land afterwards. It used to remove whatever sat under the thread id,
    /// which was the new process: `kill` then found nothing, the clients were
    /// told the thread had exited, and the PTY it names stayed alive with
    /// nothing left able to reach it.
    #[test]
    fn a_superseded_pty_does_not_bury_the_one_that_replaced_it() {
        let (shared, seen) = shared();
        let old = live("t1", "pty-old");
        let new = live("t1", "pty-new");
        shared.threads.lock().insert("t1".to_string(), new.clone());

        let stale = ThreadSink {
            shared: shared.clone(),
            live: old,
        };
        stale.send(PtyEvent::Exit(Some(0)));

        let held = shared.threads.lock();
        let current = held.get("t1").expect("the live thread is still registered");
        assert!(Arc::ptr_eq(current, &new), "the running PTY kept its entry");
        assert!(seen.lock().is_empty(), "no client was told this thread ended");
    }

    /// The same event from the PTY that is actually current still has to do its
    /// job, or the guard above would just break exit reporting instead.
    #[test]
    fn the_current_pty_still_reports_its_exit() {
        let (shared, seen) = shared();
        let current = live("t1", "pty-1");
        shared.threads.lock().insert("t1".to_string(), current.clone());

        let sink = ThreadSink {
            shared: shared.clone(),
            live: current,
        };
        sink.send(PtyEvent::Exit(Some(0)));

        assert!(shared.threads.lock().is_empty(), "the entry was released");
        let seen = seen.lock();
        assert!(
            matches!(seen.as_slice(), [AppEvent::ThreadStatus { thread_id, .. }] if thread_id == "t1"),
            "one status event, for this thread: {seen:?}"
        );
    }
}
