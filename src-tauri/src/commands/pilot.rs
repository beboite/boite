//! This app's door onto the pilot runtime, and the sink behind it.
//!
//! A codec like every other file beside it for the calls, plus the one thing
//! only a host can own: the [`boite_pilot::Runtime`] itself, the sink that
//! projects what it emits, and the 30 ms tick that coalesces text deltas before
//! they reach the window.
//!
//! The runtime is built lazily, for the same reason [`super::records::Rows`] is:
//! the schema belongs to `tauri-plugin-sql` and is applied from the frontend, so
//! anything that opens the database during `setup` opens it before the
//! migrations have run.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use boite_core::command::{Command, Pilot};
use boite_core::pilot::{project, DeltaBuffer};
use boite_core::pilot_host::{execute, Coalescer};
use boite_core::scope::ProjectRoots;
use boite_core::store::Store;
use boite_pilot::{EventSink, PilotEvent, Runtime};

use super::bus::DesktopHost;
use super::records::Rows;

/// The Tauri event a chat pane listens on.
///
/// One channel for every thread, carrying `{threadId, event}`: a pane filters
/// on the id it is drawing. A channel per pane would mean the sink knowing
/// which panes exist, which is the window's business and not this side's.
pub const PILOT_EVENT: &str = "pilot://event";

/// How long a delta waits for the ones behind it.
const COALESCE_MS: u64 = 30;

/// This app's pilot runtime, built on first use.
#[derive(Default)]
pub struct PilotRuntime(Mutex<Option<Arc<Runtime>>>);

impl PilotRuntime {
    /// The runtime, starting it and its coalescing tick if this is the first
    /// ask. A failure is not cached: the database not being there yet is the
    /// likely reason and it stops being true.
    pub fn get(&self, app: &AppHandle) -> Result<Arc<Runtime>, String> {
        let mut held = self
            .0
            .lock()
            .map_err(|_| "the pilot runtime was poisoned by an earlier panic".to_string())?;
        if let Some(runtime) = held.as_ref() {
            return Ok(runtime.clone());
        }
        let store = app.state::<Rows>().get(app)?;
        let coalescer = Arc::new(Coalescer::new());
        let sink = Arc::new(DesktopSink {
            app: app.clone(),
            store,
            buffer: Arc::new(DeltaBuffer::new()),
            coalescer: coalescer.clone(),
        });
        let runtime = Arc::new(Runtime::new(sink));
        spawn_flush(app.clone(), coalescer);
        *held = Some(runtime.clone());
        Ok(runtime)
    }

    /// The runtime if it was ever built, for the exit path. Never builds one:
    /// an app closing without a chat thread has nothing to stop.
    pub fn peek(&self) -> Option<Arc<Runtime>> {
        self.0.lock().ok().and_then(|held| held.clone())
    }
}

/// Flushes whatever streamed in the last 30 ms.
///
/// Its own task rather than a timer per event: a turn emits hundreds of deltas
/// and arming a timer on each would cost more than the sends it saves.
fn spawn_flush(app: AppHandle, coalescer: Arc<Coalescer>) {
    tauri::async_runtime::spawn(async move {
        let mut tick =
            tokio::time::interval(std::time::Duration::from_millis(COALESCE_MS));
        loop {
            tick.tick().await;
            for (thread_id, event) in coalescer.drain() {
                emit(&app, &thread_id, &event);
            }
        }
    });
}

fn emit(app: &AppHandle, thread_id: &str, event: &PilotEvent) {
    let _ = app.emit(PILOT_EVENT, json!({ "threadId": thread_id, "event": event }));
}

/// What the runtime emits, projected onto the rows and pushed at the window.
struct DesktopSink {
    app: AppHandle,
    store: Arc<Store>,
    buffer: Arc<DeltaBuffer>,
    coalescer: Arc<Coalescer>,
}

impl EventSink for DesktopSink {
    fn emit(&self, thread_id: &str, event: PilotEvent) {
        // The projection first and always: a push the rows never learned about
        // is a timeline that disagrees with itself the moment a client reloads.
        if let Err(failure) = project(&self.store, thread_id, &event, &self.buffer) {
            tracing::warn!(thread = thread_id, reason = %failure, "pilot.project.failed");
        }
        match &event {
            // Held for the tick. Nothing else is: a complete item, a request and
            // a turn edge go out at once, and the thread's pending text goes
            // with them so the card is never painted after its own tail.
            PilotEvent::ItemDelta { item_id, text } => {
                self.coalescer.push(thread_id, item_id, text);
            }
            _ => {
                for pending in self.coalescer.drain_thread(thread_id) {
                    emit(&self.app, thread_id, &pending);
                }
                emit(&self.app, thread_id, &event);
            }
        }
    }
}

fn decode(method: &str, params: Value) -> Result<Pilot, String> {
    match Command::decode(method, &params)? {
        Command::Pilot(command) => Ok(command),
        other => Err(format!("{} is not a pilot command", other.name())),
    }
}

/// Puts one pilot call through the bus and runs it on this app's runtime.
///
/// The bus cannot run it: the work awaits a child process and
/// `boite_core::command::Ready::run` blocks a pool thread. So `prepare` is the
/// boundary and [`execute`] is the work, exactly as `docs/pilot.md` writes it.
async fn on_pilot_bus(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let command = decode(method, params)?;
    let roots = app.state::<ProjectRoots>();
    let store = app.state::<Rows>().get(app)?;
    let runtime = app.state::<PilotRuntime>().get(app)?;
    let mut host = DesktopHost::new(roots.inner())
        .with_store(store)
        .with_pilot(runtime);
    // A dev build that never ran `bun run build:sidecar` has no shim, and a
    // chat thread without boite tools is worth more than a refusal to open one.
    if let Ok(paths) = super::agents::local_mcp_paths(app) {
        host = host.with_mcp(paths);
    }
    let ready = match Command::Pilot(command).prepare(&host, boite_core::capability::Grant::Local) {
        Ok(ready) => ready,
        Err(refusal) => {
            tracing::warn!(method, reason = %refusal, "bus.refused");
            return Err(refusal);
        }
    };
    let boite_core::command::Ready::Pilot(ready) = ready else {
        return Err(format!("{method} did not prepare as a pilot call"));
    };
    let answer = execute(*ready).await;
    if let Err(failure) = &answer {
        tracing::warn!(method, reason = %failure, "bus.failed");
    }
    answer
}

macro_rules! pilot_command {
    ($name:ident, $method:literal) => {
        #[tauri::command]
        pub async fn $name(app: AppHandle, params: Option<Value>) -> Result<Value, String> {
            on_pilot_bus(&app, $method, params.unwrap_or_else(|| json!({}))).await
        }
    };
}

pilot_command!(pilot_catalog, "pilot.catalog");
pilot_command!(pilot_thread_open, "pilot.thread.open");
pilot_command!(pilot_turn_start, "pilot.turn.start");
pilot_command!(pilot_turn_interrupt, "pilot.turn.interrupt");
pilot_command!(pilot_request_respond, "pilot.request.respond");
pilot_command!(pilot_model_set, "pilot.model.set");
pilot_command!(pilot_mode_set, "pilot.mode.set");
pilot_command!(pilot_session_stop, "pilot.session.stop");
pilot_command!(pilot_items, "pilot.items");
pilot_command!(pilot_events, "pilot.events");
pilot_command!(pilot_subscribe, "pilot.subscribe");
pilot_command!(pilot_unsubscribe, "pilot.unsubscribe");

/// Stops every pilot child, for app exit.
///
/// Beside `PtyManager::kill_all` and for the same reason: a child left behind
/// holds a session file open and the next launch resumes into a conversation
/// two processes are writing. Blocking, like `kill_all`, because returning
/// early would shoot the children it just asked to leave.
pub fn stop_all(app: &AppHandle) {
    let Some(runtime) = app.state::<PilotRuntime>().peek() else {
        return;
    };
    tauri::async_runtime::block_on(async move { runtime.stop_all().await });
}
