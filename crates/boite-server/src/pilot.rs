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
use boite_pilot::{EventSink, PilotEvent, Runtime};

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
        }
        // The dock, off the projection rather than off the status. A request
        // opening sets both, so deriving it from `waiting` as well sent the
        // same event twice for one question; and a status is not what changed
        // the table, the row the projection wrote is.
        if projected.approvals_changed {
            crate::events::announce_approvals_changed(&self.events);
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

#[cfg(test)]
mod tests {
    use super::*;
    use boite_pilot::{Request, RequestKind, RequestOption, RequestOutcome};

    fn store() -> Arc<Store> {
        let path = std::env::temp_dir().join(format!(
            "boite-server-pilot-{}-{:?}.db",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        Arc::new(Store::open(&path).expect("open"))
    }

    fn sink(events: broadcast::Sender<AppEvent>) -> ServerSink {
        ServerSink {
            store: store(),
            events,
            buffer: Arc::new(DeltaBuffer::new()),
            coalescer: Arc::new(Coalescer::new()),
        }
    }

    fn request() -> Request {
        Request {
            id: "r1".into(),
            kind: RequestKind::ToolApproval,
            tool_name: Some("Bash".into()),
            tool_use_id: None,
            input: serde_json::json!({ "command": "ls" }),
            title: None,
            description: None,
            options: vec![RequestOption {
                value: "allow".into(),
                label: "Allow".into(),
            }],
            suggestions: serde_json::Value::Null,
            questions: Vec::new(),
        }
    }

    fn approvals(rx: &mut broadcast::Receiver<AppEvent>) -> usize {
        let mut seen = 0;
        while let Ok(event) = rx.try_recv() {
            if matches!(event, AppEvent::ApprovalsChanged) {
                seen += 1;
            }
        }
        seen
    }

    /// The dock hears about a chat thread's question, and hears about it once.
    ///
    /// Nothing told a client that a `pilot.request` row had opened except a
    /// reload, and the one emit that did exist was derived from the `waiting`
    /// status as well as from the projection, so a question announced at all
    /// was announced twice.
    #[test]
    fn a_request_announces_the_approvals_once_at_each_edge() {
        let (tx, mut rx) = broadcast::channel(64);
        let sink = sink(tx);

        sink.emit(
            "t1",
            PilotEvent::RequestOpened {
                request: request(),
            },
        );
        assert_eq!(approvals(&mut rx), 1, "opened");

        sink.emit(
            "t1",
            PilotEvent::RequestResolved {
                request_id: "r1".into(),
                outcome: RequestOutcome::Allowed,
            },
        );
        assert_eq!(approvals(&mut rx), 1, "resolved");
    }

    /// A turn is not a question: nothing the dock draws changed.
    #[test]
    fn a_plain_turn_announces_nothing_to_the_dock() {
        let (tx, mut rx) = broadcast::channel(64);
        let sink = sink(tx);
        sink.emit(
            "t1",
            PilotEvent::TurnStarted {
                turn_id: "turn-1".into(),
            },
        );
        assert_eq!(approvals(&mut rx), 0);
    }
}
