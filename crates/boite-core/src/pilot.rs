//! What one pilot event does to the rows.
//!
//! The crate owns the child processes and emits canonical events; this module
//! is the only thing that turns one of those into a journal row, a timeline
//! item, an approval card or a column on `threads`. Synchronous and free of any
//! executor, so both hosts call it from whatever thread the sink runs on and
//! `boite-core` keeps taking no async runtime.
//!
//! Two rules the shape enforces rather than documents:
//!
//! - **A text delta is never written.** `item.delta` appends to a
//!   [`DeltaBuffer`] the host keeps in memory and nothing else; the body that
//!   lands on the row is the one `item.completed` carries, falling back to the
//!   buffer when the driver completed an item without repeating its text.
//! - **What to push is the projection's answer, not the caller's guess.**
//!   [`Projection`] says whether the event goes to subscribers and whether the
//!   `threads` row changed enough for a `thread.updated`, so the desktop and
//!   the server cannot drift on when a sidebar refreshes.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::{json, Value};

use boite_pilot::{
    ExitReason, Item, ItemKind, PilotEvent, Request, RequestAnswer, RequestOption, RequestOutcome,
    Status,
};

use crate::approval;
use crate::store::{ColVal, PilotItemRow, Store, ThreadCol, PILOT_APPROVAL_ACTION};

/// The text a turn has streamed so far, per item, for one host.
///
/// In memory and nowhere else. A client that arrives mid-turn reads the items
/// that are already complete and then subscribes, which is why losing this on a
/// restart costs nothing: the completed body is on the row, and an item still
/// streaming when the host went away has no final text to have kept.
#[derive(Debug, Default)]
pub struct DeltaBuffer {
    text: Mutex<HashMap<String, String>>,
}

impl DeltaBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends and hands back nothing: the coalescing task reads the deltas off
    /// the event it was given, and this is only what completes an item that
    /// arrived without its text.
    pub fn append(&self, item_id: &str, text: &str) {
        let mut buffered = self.text.lock();
        buffered
            .entry(item_id.to_string())
            .or_default()
            .push_str(text);
    }

    /// Takes what an item streamed, leaving nothing behind.
    pub fn take(&self, item_id: &str) -> Option<String> {
        self.text.lock().remove(item_id)
    }

    /// Drops everything a thread buffered, at stop and at open.
    pub fn clear(&self) {
        self.text.lock().clear();
    }
}

/// What one projected event asks the host to do next.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Projection {
    /// The journal sequence written, or `None` for an event that is live only.
    pub seq: Option<i64>,
    /// Whether subscribers should receive the event itself.
    ///
    /// True for everything: a delta is what the chat pane paints and a status
    /// is what the sidebar reads, and neither being stored is a fact about the
    /// database rather than about the push.
    pub push: bool,
    /// Whether the `threads` row changed, so a `thread.updated` has something
    /// to carry.
    pub thread_updated: bool,
    /// The open approvals table changed: a request opened, or was answered.
    pub approvals_changed: bool,
    /// What the thread's status now is, when this event decided one.
    pub status: Option<Status>,
    /// The native session id this event named, when it named one.
    pub native_session_id: Option<String>,
}

/// Applies one event to the rows of one thread.
///
/// Errors are the store's own strings and are returned rather than swallowed:
/// the sink logs them at `warn`, because a projection that silently failed is a
/// timeline that quietly stops growing.
pub fn project(
    store: &Store,
    thread_id: &str,
    event: &PilotEvent,
    buffer: &DeltaBuffer,
) -> Result<Projection, String> {
    let mut out = Projection {
        push: true,
        ..Default::default()
    };

    // The journal first, so the sequence it mints is the one the item carries.
    // An item's `seq` is what a cursor read pages on, and taking it from
    // anywhere else would let two items on one thread share a position.
    if event.is_journaled() {
        let payload = serde_json::to_value(event).map_err(|e| e.to_string())?;
        out.seq = Some(store.pilot_append_event(thread_id, event.kind(), &payload)?);
    }
    let seq = out.seq.unwrap_or(0);

    match event {
        PilotEvent::SessionStarted {
            native_session_id,
            model,
            ..
        } => {
            // The bridge between the two runtimes: with this written, "open in
            // a terminal" is `claude --resume <id>` and nothing has to guess.
            if let Some(id) = native_session_id {
                store.update_thread_field(
                    thread_id,
                    ThreadCol::SessionId,
                    ColVal::Text(id.clone()),
                )?;
                out.native_session_id = Some(id.clone());
                out.thread_updated = true;
            }
            if let Some(model) = model {
                store.update_thread_field(
                    thread_id,
                    ThreadCol::PilotModel,
                    ColVal::Text(model.clone()),
                )?;
                out.thread_updated = true;
            }
        }

        PilotEvent::SessionExited { reason } => {
            let state = match reason {
                ExitReason::Stopped => "stopped",
                ExitReason::Crashed { .. } => "crashed",
                ExitReason::Killed => "killed",
            };
            store.update_thread_field(
                thread_id,
                ThreadCol::Status,
                ColVal::Text("stopped".to_string()),
            )?;
            out.thread_updated = true;
            out.status = Some(Status::Idle);
            tracing::debug!(thread = thread_id, reason = state, "pilot.session.exited");
        }

        PilotEvent::TurnStarted { turn_id } => {
            // The checkpoint `start` edge belongs here and is a later job: the
            // turn item is the row it would be written onto, so the seam is one
            // field on this body rather than a second table.
            write_item(
                store,
                thread_id,
                seq,
                &turn_item(turn_id, "running", json!({ "turnId": turn_id })),
            )?;
            out.thread_updated = true;
        }

        PilotEvent::TurnCompleted {
            turn_id,
            duration_ms,
            usage,
        } => {
            let body = json!({
                "turnId": turn_id,
                "durationMs": duration_ms,
                "usage": usage,
            });
            write_item(store, thread_id, seq, &turn_item(turn_id, "completed", body))?;
            out.thread_updated = true;
        }

        PilotEvent::TurnAborted { turn_id, reason } => {
            let body = json!({ "turnId": turn_id, "reason": reason });
            write_item(store, thread_id, seq, &turn_item(turn_id, "aborted", body))?;
            out.thread_updated = true;
        }

        PilotEvent::ItemStarted { item } => {
            write_item(store, thread_id, seq, &row_of(item, "started", None))?;
        }

        // The one event that writes nothing. Appending to the buffer is the
        // whole of it, and the push is what the pane paints.
        PilotEvent::ItemDelta { item_id, text } => {
            buffer.append(item_id, text);
        }

        PilotEvent::ItemCompleted { item } => {
            // A driver that streamed the text and completed the item with an
            // empty body means the buffer, not an empty card.
            let streamed = buffer.take(&item.id);
            write_item(store, thread_id, seq, &row_of(item, "completed", streamed))?;
        }

        PilotEvent::RequestOpened { request } => {
            write_item(store, thread_id, seq, &request_row(request, "open", None))?;
            open_approval(store, thread_id, request)?;
            out.approvals_changed = true;
            out.thread_updated = true;
            out.status = Some(Status::Waiting);
            tracing::info!(
                thread = thread_id,
                request = request.id,
                tool = request.tool_name.as_deref().unwrap_or(""),
                "pilot.request.opened"
            );
        }

        PilotEvent::RequestResolved {
            request_id,
            outcome,
        } => {
            let state = match outcome {
                RequestOutcome::Allowed => "allowed",
                RequestOutcome::Denied => "denied",
                RequestOutcome::Cancelled => "cancelled",
            };
            // The item keeps the request's own id, so this updates the card the
            // dock is drawing rather than opening a second one.
            let row = PilotItemRow {
                id: request_item_id(request_id),
                thread_id: thread_id.to_string(),
                seq,
                turn_id: None,
                kind: "request".to_string(),
                state: state.to_string(),
                body: json!({ "requestId": request_id, "outcome": state }).to_string(),
                created_ms: crate::pilot::now_ms(),
                updated_ms: crate::pilot::now_ms(),
            };
            store.pilot_upsert_item(&row)?;
            if let Some(approval_id) = store.pilot_approval_of_request(thread_id, request_id) {
                let verdict = match outcome {
                    RequestOutcome::Allowed => approval::Verdict::Allowed,
                    _ => approval::Verdict::Refused,
                };
                store.decide_approval(&approval_id, verdict, now_ms())?;
            }
            out.approvals_changed = true;
            out.thread_updated = true;
            tracing::info!(
                thread = thread_id,
                request = request_id,
                outcome = state,
                "pilot.request.resolved"
            );
        }

        // Live only, and the host feeds it the same place a terminal thread's
        // status is fed. No TTL and no screen reading: for a pilot row this is
        // the only source there is.
        PilotEvent::StatusChanged { status } => {
            out.status = Some(*status);
        }

        PilotEvent::ModelChanged { model } => {
            store.update_thread_field(
                thread_id,
                ThreadCol::PilotModel,
                ColVal::Text(model.clone()),
            )?;
            out.thread_updated = true;
        }

        // Kept in the journal for the usage panel to read back; nothing on the
        // row depends on it, so the sidebar is not woken for one.
        PilotEvent::UsageUpdated { .. } => {}

        PilotEvent::Error { message, turn_id } => {
            let id = format!("error-{seq}");
            let row = PilotItemRow {
                id,
                thread_id: thread_id.to_string(),
                seq,
                turn_id: turn_id.clone(),
                kind: "error".to_string(),
                state: "completed".to_string(),
                body: json!({ "message": message }).to_string(),
                created_ms: now_ms(),
                updated_ms: now_ms(),
            };
            store.pilot_upsert_item(&row)?;
            out.thread_updated = true;
            tracing::warn!(thread = thread_id, reason = %message, "pilot.error");
        }
    }

    Ok(out)
}

/// The status a pilot row reads, worked out from what the projection saw.
///
/// `waiting` outranks `busy`, a question asked of the user being the user's,
/// and the words are the ones `statusEngine.ts` already draws for a terminal
/// thread so the sidebar needs no second vocabulary.
pub fn status_word(status: Status) -> &'static str {
    match status {
        Status::Busy => "running",
        Status::Waiting => "waiting",
        Status::Idle => "ready",
    }
}

/// The answer a chosen option maps to.
///
/// The vocabulary is closed here rather than at the transports: an option value
/// is the driver's own opaque string, and the two words boite understands are
/// what an approval card offers. Anything else is a deny carrying the label, so
/// a driver that grows a third option refuses safely instead of running.
pub fn answer_of_option(value: &str, options: &[RequestOption]) -> RequestAnswer {
    match value {
        "allow" | "allow_always" | "yes" => RequestAnswer::allow(),
        "deny" | "no" => RequestAnswer::deny("the user refused"),
        other => {
            if options.iter().any(|option| option.value == other) {
                RequestAnswer::allow()
            } else {
                RequestAnswer::deny("the user refused")
            }
        }
    }
}

/// The item id a request's card carries. Derived from the request id so
/// `request.resolved` finds the row `request.opened` wrote.
pub fn request_item_id(request_id: &str) -> String {
    format!("request:{request_id}")
}

fn turn_item(turn_id: &str, state: &str, body: Value) -> PilotItemRow {
    PilotItemRow {
        id: format!("turn:{turn_id}"),
        thread_id: String::new(),
        seq: 0,
        turn_id: Some(turn_id.to_string()),
        kind: "turn".to_string(),
        state: state.to_string(),
        body: body.to_string(),
        created_ms: now_ms(),
        updated_ms: now_ms(),
    }
}

fn row_of(item: &Item, state: &str, streamed: Option<String>) -> PilotItemRow {
    let mut body = item.body.clone();
    if let Some(text) = streamed {
        let empty = match &body {
            Value::Null => true,
            Value::Object(map) => map
                .get("text")
                .and_then(|v| v.as_str())
                .map(str::is_empty)
                .unwrap_or(!map.contains_key("text")),
            _ => false,
        };
        if empty {
            match &mut body {
                Value::Object(map) => {
                    map.insert("text".to_string(), json!(text));
                }
                other => *other = json!({ "text": text }),
            }
        }
    }
    PilotItemRow {
        id: item.id.clone(),
        thread_id: String::new(),
        seq: 0,
        turn_id: item.turn_id.clone(),
        kind: item_kind(item.kind).to_string(),
        state: state.to_string(),
        body: body.to_string(),
        created_ms: now_ms(),
        updated_ms: now_ms(),
    }
}

fn request_row(request: &Request, state: &str, seq: Option<i64>) -> PilotItemRow {
    PilotItemRow {
        id: request_item_id(&request.id),
        thread_id: String::new(),
        seq: seq.unwrap_or(0),
        turn_id: None,
        kind: "request".to_string(),
        state: state.to_string(),
        body: serde_json::to_string(request).unwrap_or_else(|_| "{}".to_string()),
        created_ms: now_ms(),
        updated_ms: now_ms(),
    }
}

/// Fills in the two fields the callers above cannot know, then writes.
fn write_item(
    store: &Store,
    thread_id: &str,
    seq: i64,
    row: &PilotItemRow,
) -> Result<(), String> {
    let mut row = row.clone();
    row.thread_id = thread_id.to_string();
    row.seq = seq;
    store.pilot_upsert_item(&row)
}

/// Mirrors an open request into the approvals table.
///
/// The options travel in the request body, opaque, so the dock draws exactly
/// what the driver offered and `pilot.request.respond` hands the chosen value
/// back untouched.
fn open_approval(store: &Store, thread_id: &str, request: &Request) -> Result<(), String> {
    let project_id = store.project_of_thread(thread_id).unwrap_or_default();
    let pending = approval::Pending {
        id: format!("pilot-{}-{}", thread_id, request.id),
        project_id,
        thread_id: thread_id.to_string(),
        action: PILOT_APPROVAL_ACTION.to_string(),
        // The request id, so answering one is a lookup. What the card shows
        // comes out of the stored request beside it.
        detail: request.id.clone(),
        created_at: now_ms(),
    };
    let body = serde_json::to_value(request).map_err(|e| e.to_string())?;
    store.open_approval(&pending, &json!({ "threadId": thread_id, "request": body }))
}

fn item_kind(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::AssistantText => "assistant_text",
        ItemKind::Reasoning => "reasoning",
        ItemKind::ToolCall => "tool_call",
        ItemKind::Command => "command",
        ItemKind::FileChange => "file_change",
        ItemKind::Plan => "plan",
        ItemKind::UserMessage => "user_message",
        ItemKind::Error => "error",
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use boite_pilot::{RequestKind, Usage};

    fn store() -> Store {
        let path = std::env::temp_dir().join(format!(
            "boite-pilot-projection-{}-{:?}.db",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        Store::open(&path).expect("open")
    }

    fn apply(store: &Store, buffer: &DeltaBuffer, event: PilotEvent) -> Projection {
        project(store, "t1", &event, buffer).expect("project")
    }

    /// The assertion the budget table names: a turn of two hundred deltas costs
    /// the database nothing at all.
    #[test]
    fn two_hundred_deltas_write_no_row() {
        let store = store();
        let buffer = DeltaBuffer::new();
        apply(
            &store,
            &buffer,
            PilotEvent::ItemStarted {
                item: Item::new("i1", ItemKind::AssistantText, Some("turn-1".into())),
            },
        );
        let (events_before, items_before) = store.pilot_counts("t1").unwrap();
        for _ in 0..200 {
            apply(
                &store,
                &buffer,
                PilotEvent::ItemDelta {
                    item_id: "i1".into(),
                    text: "x".into(),
                },
            );
        }
        let (events_after, items_after) = store.pilot_counts("t1").unwrap();
        assert_eq!(events_after, events_before, "a delta is never journaled");
        assert_eq!(items_after, items_before, "a delta never touches an item");

        // And the text was kept: completing with an empty body writes what the
        // deltas carried rather than an empty card.
        apply(
            &store,
            &buffer,
            PilotEvent::ItemCompleted {
                item: Item::new("i1", ItemKind::AssistantText, Some("turn-1".into())),
            },
        );
        let items = store.pilot_items("t1", 0, 10).unwrap();
        let row = items.iter().find(|row| row.id == "i1").expect("the item");
        assert_eq!(row.state, "completed");
        assert!(row.body.contains(&"x".repeat(200)), "{}", row.body);
    }

    #[test]
    fn a_session_start_writes_the_native_id_and_the_model() {
        let store = store();
        let buffer = DeltaBuffer::new();
        store
            .save_thread(&crate::model::Thread {
                id: "t1".into(),
                project_id: "p1".into(),
                pty_id: None,
                label: "chat".into(),
                title: None,
                cmd: "claude".into(),
                args: vec![],
                icon_key: None,
                icon_color: None,
                session_id: None,
                status: "idle".into(),
                exit_code: None,
                created_at: 0,
                auto_slept: false,
                keep_awake: false,
                worktree_path: None,
                settled_at: None,
                parent_thread_id: None,
                delegation_mode: None,
                delegation_status: None,
                role: None,
                orchestrator_scope: None,
                accept_dispatch: true,
                runtime: crate::model::RUNTIME_PILOT.into(),
                pilot_driver: Some("claude".into()),
                pilot_instance: None,
                pilot_model: None,
                pilot_options: None,
            })
            .unwrap();
        let projection = apply(
            &store,
            &buffer,
            PilotEvent::SessionStarted {
                native_session_id: Some("native-1".into()),
                model: Some("claude-fable-5-1".into()),
                slash_commands: vec![],
                extra: Default::default(),
            },
        );
        assert!(projection.thread_updated);
        assert_eq!(projection.native_session_id.as_deref(), Some("native-1"));
        let row = store.load_thread("t1").unwrap().expect("the row");
        assert_eq!(row.session_id.as_deref(), Some("native-1"));
        assert_eq!(row.pilot_model.as_deref(), Some("claude-fable-5-1"));
        assert_eq!(row.runtime, crate::model::RUNTIME_PILOT);
    }

    #[test]
    fn a_turn_writes_one_item_that_gains_its_duration() {
        let store = store();
        let buffer = DeltaBuffer::new();
        apply(
            &store,
            &buffer,
            PilotEvent::TurnStarted {
                turn_id: "turn-1".into(),
            },
        );
        apply(
            &store,
            &buffer,
            PilotEvent::TurnCompleted {
                turn_id: "turn-1".into(),
                duration_ms: 42,
                usage: Usage {
                    input_tokens: 7,
                    ..Default::default()
                },
            },
        );
        let items = store.pilot_items("t1", 0, 10).unwrap();
        let turns: Vec<_> = items.iter().filter(|row| row.kind == "turn").collect();
        assert_eq!(turns.len(), 1, "one row per turn, not one per edge");
        assert_eq!(turns[0].state, "completed");
        assert!(turns[0].body.contains("\"durationMs\":42"), "{}", turns[0].body);
        assert!(turns[0].body.contains("\"input_tokens\":7"), "{}", turns[0].body);
    }

    #[test]
    fn a_request_opens_an_approval_and_the_answer_closes_it() {
        let store = store();
        let buffer = DeltaBuffer::new();
        let request = Request {
            id: "r1".into(),
            kind: RequestKind::ToolApproval,
            tool_name: Some("Bash".into()),
            tool_use_id: None,
            input: json!({ "command": "ls" }),
            title: None,
            description: None,
            options: vec![RequestOption {
                value: "allow".into(),
                label: "Allow".into(),
            }],
            suggestions: Value::Null,
        };
        let opened = apply(
            &store,
            &buffer,
            PilotEvent::RequestOpened {
                request: request.clone(),
            },
        );
        assert!(opened.approvals_changed);
        assert_eq!(opened.status, Some(Status::Waiting));
        assert_eq!(store.open_approvals().unwrap().len(), 1);
        assert!(store.pilot_approval_of_request("t1", "r1").is_some());

        apply(
            &store,
            &buffer,
            PilotEvent::RequestResolved {
                request_id: "r1".into(),
                outcome: RequestOutcome::Allowed,
            },
        );
        assert!(store.open_approvals().unwrap().is_empty(), "answered once");
        let items = store.pilot_items("t1", 0, 10).unwrap();
        let card = items
            .iter()
            .find(|row| row.id == request_item_id("r1"))
            .expect("the request card");
        assert_eq!(card.state, "allowed");
    }

    #[test]
    fn a_status_change_is_live_only() {
        let store = store();
        let buffer = DeltaBuffer::new();
        let projection = apply(
            &store,
            &buffer,
            PilotEvent::StatusChanged {
                status: Status::Busy,
            },
        );
        assert_eq!(projection.seq, None, "a reading is not a fact");
        assert_eq!(projection.status, Some(Status::Busy));
        assert!(projection.push, "the sidebar still reads it");
        assert_eq!(store.pilot_counts("t1").unwrap(), (0, 0));
    }

    #[test]
    fn an_error_lands_on_the_timeline() {
        let store = store();
        let buffer = DeltaBuffer::new();
        apply(
            &store,
            &buffer,
            PilotEvent::Error {
                message: "the agent protocol broke".into(),
                turn_id: Some("turn-1".into()),
            },
        );
        let items = store.pilot_items("t1", 0, 10).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "error");
        assert!(items[0].body.contains("protocol broke"));
    }

    /// A cursor read is exclusive on both tables, so a client that subscribes
    /// after reading neither misses an item nor draws one twice.
    #[test]
    fn a_cursor_read_is_exclusive_on_both_tables() {
        let store = store();
        let buffer = DeltaBuffer::new();
        for index in 0..3 {
            apply(
                &store,
                &buffer,
                PilotEvent::ItemCompleted {
                    item: Item::new(format!("i{index}"), ItemKind::AssistantText, None)
                        .with_body(json!({ "text": "ok" })),
                },
            );
        }
        let all = store.pilot_items("t1", 0, 10).unwrap();
        assert_eq!(all.len(), 3);
        let rest = store.pilot_items("t1", all[0].seq, 10).unwrap();
        assert_eq!(rest.len(), 2, "after_seq is exclusive");
        let events = store.pilot_events("t1", 0, 10).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, "item.completed");
    }

    /// The option a driver offered is what may be answered; anything else is a
    /// refusal rather than a tool that runs on a value nobody recognised.
    #[test]
    fn only_an_offered_option_allows() {
        let options = vec![RequestOption {
            value: "allow_once".into(),
            label: "Allow once".into(),
        }];
        assert!(matches!(
            answer_of_option("allow_once", &options),
            RequestAnswer::Allow { .. }
        ));
        assert!(matches!(
            answer_of_option("something-else", &options),
            RequestAnswer::Deny { .. }
        ));
    }
    /// The whole path, with a real runtime and no host in it: open a session,
    /// run a turn that opens an approval, answer it from the store the way the
    /// dock does, stop.
    ///
    /// Driven by the scripted driver rather than by hand-built events, because
    /// what is being checked is that the runtime, the sink and the projection
    /// agree on the order things happen in.
    #[tokio::test]
    async fn a_scripted_turn_lands_in_the_rows_through_a_runtime() {
        use boite_pilot::{EventSink, OpenSpec, Runtime, TurnInput};
        use std::sync::Arc;

        struct Projecting {
            store: Arc<Store>,
            buffer: DeltaBuffer,
        }
        impl EventSink for Projecting {
            fn emit(&self, thread_id: &str, event: PilotEvent) {
                project(&self.store, thread_id, &event, &self.buffer).expect("project");
            }
        }

        let store = Arc::new(store());
        let sink = Arc::new(Projecting {
            store: store.clone(),
            buffer: DeltaBuffer::new(),
        });
        let runtime = Runtime::new(sink);
        runtime.register(Arc::new(
            boite_pilot::scripted::ScriptedDriver::with_scenario(
                boite_pilot::scripted::Scenario {
                    native_session_id: Some("native-1".into()),
                    model: Some("claude-fable-5-1".into()),
                    slash_commands: vec![],
                    steps: vec![boite_pilot::scripted::Step {
                        deltas: vec!["o".into(), "k".into()],
                        request: Some(boite_pilot::scripted::ScenarioRequest {
                            tool_name: "Bash".into(),
                            input: json!({ "command": "ls" }),
                            title: None,
                        }),
                        duration_ms: 12,
                        ..Default::default()
                    }],
                },
            ),
        ));

        runtime
            .open(OpenSpec {
                thread_id: "t1".into(),
                cwd: std::env::temp_dir(),
                driver: "scripted".into(),
                ..Default::default()
            })
            .await
            .expect("open");

        runtime
            .prompt("t1", TurnInput::text("hi"))
            .await
            .expect("prompt");

        // The turn is parked on the approval, which is the state the dock draws.
        assert_eq!(runtime.status("t1"), Some(Status::Waiting));
        let open = store.open_approvals().expect("approvals");
        assert_eq!(open.len(), 1, "one card, not one per event");
        assert_eq!(open[0].action, PILOT_APPROVAL_ACTION);
        let request_id = open[0].detail.clone();

        runtime
            .respond("t1", &request_id, boite_pilot::RequestAnswer::allow())
            .await
            .expect("respond");

        assert!(store.open_approvals().unwrap().is_empty(), "answered once");
        assert_eq!(runtime.status("t1"), Some(Status::Idle), "the turn ran on");

        let items = store.pilot_items("t1", 0, 50).unwrap();
        let kinds: Vec<&str> = items.iter().map(|row| row.kind.as_str()).collect();
        assert!(kinds.contains(&"turn"), "{kinds:?}");
        assert!(kinds.contains(&"assistant_text"), "{kinds:?}");
        assert!(kinds.contains(&"request"), "{kinds:?}");
        let text = items
            .iter()
            .find(|row| row.kind == "assistant_text")
            .expect("the message");
        assert!(text.body.contains("ok"), "{}", text.body);

        // The journal kept the turn edges and no delta at all.
        let events = store.pilot_events("t1", 0, 100).unwrap();
        assert!(
            !events.iter().any(|row| row.kind == "item.delta"),
            "a delta is never journaled"
        );
        assert!(events.iter().any(|row| row.kind == "turn.completed"));

        runtime.stop("t1").await.expect("stop");
        assert_eq!(runtime.status("t1"), None);
    }
}
