use super::{reduce, Shared, State};
use crate::scripted::Recorder;
use crate::{PilotEvent, RequestOutcome, SessionSink, Status};
use serde_json::json;
use std::sync::Arc;

fn setup() -> (Shared, Arc<Recorder>) {
    let recorder = Recorder::new();
    let shared = Shared {
        sink: SessionSink::new("test", recorder.clone()),
        state: parking_lot::Mutex::new(State {
            native_session_id: Some("ses".into()),
            turn: Some("turn".into()),
            turn_saw_busy: true,
            ..State::default()
        }),
    };
    (shared, recorder)
}

#[test]
fn interrupt_defers_idle_until_the_http_result() {
    let (shared, recorder) = setup();
    shared.state.lock().interrupting = true;
    reduce::handle_event(
        &shared,
        &json!({"type":"session.idle", "properties":{"sessionID":"ses"}}),
    );
    assert!(shared.state.lock().deferred_idle);
    assert_eq!(shared.state.lock().turn.as_deref(), Some("turn"));
    assert!(!recorder.kinds().contains(&"turn.completed"));
    shared.state.lock().interrupting = false;
    reduce::complete_turn(&shared);
    assert_eq!(
        recorder
            .kinds()
            .iter()
            .filter(|kind| **kind == "turn.completed")
            .count(),
        1
    );
}

#[test]
fn permission_replay_is_deduplicated_and_reject_is_not_allow() {
    let (shared, recorder) = setup();
    let ask = json!({"type":"permission.asked", "properties":{"sessionID":"ses", "id":"per", "permission":"bash"}});
    reduce::handle_event(&shared, &ask);
    reduce::handle_event(&shared, &ask);
    assert_eq!(
        recorder
            .kinds()
            .iter()
            .filter(|kind| **kind == "request.opened")
            .count(),
        1
    );
    reduce::handle_event(
        &shared,
        &json!({"type":"permission.replied", "properties":{"sessionID":"ses", "requestID":"per", "reply":"reject"}}),
    );
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::RequestResolved {
            outcome: RequestOutcome::Denied,
            ..
        }
    )));
    assert_eq!(shared.state.lock().status, Status::Busy);
}

#[test]
fn native_idle_does_not_finish_compaction_early() {
    let (shared, recorder) = setup();
    shared.state.lock().compacting = true;
    reduce::complete_turn(&shared);
    assert!(!recorder.kinds().contains(&"turn.completed"));
    assert!(shared.state.lock().turn.is_some());
}

#[test]
fn exit_clears_busy_status_and_is_emitted_once() {
    let (shared, recorder) = setup();
    shared.set_status(Status::Busy);
    shared.exit(crate::ExitReason::Stopped);
    shared.exit(crate::ExitReason::Stopped);
    assert_eq!(shared.state.lock().status, Status::Idle);
    assert_eq!(
        recorder
            .kinds()
            .iter()
            .filter(|kind| **kind == "session.exited")
            .count(),
        1
    );
}
