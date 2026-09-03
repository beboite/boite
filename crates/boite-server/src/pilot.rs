//! The server's half of the pilot runtime: the sink and its coalescing tick.
//!
//! The calls themselves are `rpc.rs` over `boite_core::pilot_host`, the way
//! every other domain is. What is here is what only a host can own: the
//! [`Runtime`], the sink that projects what it emits onto the rows, and the
//! 30 ms tick that joins text deltas before they reach a socket.
//!
//! Built before [`AppState`], because the state holds the runtime: the sink
//! needs the store and the event channel and nothing else, and both exist by
//! then.

use std::sync::Arc;

use tokio::sync::broadcast;

use boite_core::pilot::{project, status_word, DeltaBuffer};
use boite_core::pilot_host::Coalescer;
use boite_core::store::Store;
use boite_pilot::{EventSink, PilotEvent, Runtime, Status};

use crate::events::AppEvent;

/// How long a delta waits for the ones behind it.
const COALESCE_MS: u64 = 30;

/// Builds this server's runtime and starts the tick that flushes its deltas.
pub fn runtime(store: Arc<Store>, events: broadcast::Sender<AppEvent>) -> Arc<Runtime> {
    let coalescer = Arc::new(Coalescer::new());
    let sink = Arc::new(ServerSink {
        store,
        events: events.clone(),
        buffer: Arc::new(DeltaBuffer::new()),
        coalescer: coalescer.clone(),
    });
    spawn_flush(events, coalescer);
    Arc::new(Runtime::new(sink))
}

/// Sends whatever streamed in the last 30 ms.
///
/// Its own task rather than a timer per event: a turn emits hundreds of deltas
/// and arming a timer on each would cost more than the sends it saves. Nothing
/// leaves this task if nothing streamed.
fn spawn_flush(events: broadcast::Sender<AppEvent>, coalescer: Arc<Coalescer>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(COALESCE_MS));
        loop {
            tick.tick().await;
            for (thread_id, event) in coalescer.drain() {
                send(&events, &thread_id, &event);
            }
        }
    });
}

fn send(events: &broadcast::Sender<AppEvent>, thread_id: &str, event: &PilotEvent) {
    let Ok(value) = serde_json::to_value(event) else {
        // A value that will not serialize is dropped rather than logged about
        // from inside the path that produced it.
        return;
    };
    let _ = events.send(AppEvent::PilotEvent {
        thread_id: thread_id.to_string(),
        event: Arc::new(value),
    });
}

struct ServerSink {
    store: Arc<Store>,
    events: broadcast::Sender<AppEvent>,
    buffer: Arc<DeltaBuffer>,
    coalescer: Arc<Coalescer>,
}

impl EventSink for ServerSink {
    fn emit(&self, thread_id: &str, event: PilotEvent) {
        // The projection first and always: a push the rows never learned about
        // is a timeline that disagrees with itself the moment a client reloads.
        let projected = match project(&self.store, thread_id, &event, &self.buffer) {
            Ok(projected) => projected,
            Err(failure) => {
                tracing::warn!(thread = thread_id, reason = %failure, "pilot.project.failed");
                Default::default()
            }
        };

        match &event {
            PilotEvent::ItemDelta { item_id, text } => {
                self.coalescer.push(thread_id, item_id, text);
            }
            _ => {
                // A complete item, a request and a turn edge go out at once,
                // and the thread's pending text goes with them: a delta landing
                // after the card it belongs to would paint its tail twice.
                for pending in self.coalescer.drain_thread(thread_id) {
                    send(&self.events, thread_id, &pending);
                }
                send(&self.events, thread_id, &event);
            }
        }

        // For a pilot row this is the only status source there is: no pid
        // registry, no screen rows, no clock. Fed the same channel a terminal
        // thread's transitions go down, so the sidebar and the notifier need no
        // second vocabulary.
        if let Some(status) = projected.status {
            let _ = self.events.send(AppEvent::ThreadStatus {
                thread_id: thread_id.to_string(),
                status: status_word(status).to_string(),
                exit_code: None,
            });
            if status == Status::Waiting {
                let _ = self.events.send(AppEvent::ApprovalsChanged);
            }
        }
        if projected.approvals_changed {
            let _ = self.events.send(AppEvent::ApprovalsChanged);
        }
        if projected.thread_updated {
            if let Ok(Some(thread)) = self.store.load_thread(thread_id) {
                if let Ok(value) = serde_json::to_value(&thread) {
                    let _ = self.events.send(AppEvent::ThreadUpdated(value));
                }
            }
        }
    }
}
