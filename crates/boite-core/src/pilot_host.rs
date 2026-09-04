//! The half of the pilot domain that needs an executor, shared by both hosts.
//!
//! `boite-core` declares no tokio of its own and this does not change that:
//! everything here is a plain `async fn`, awaited on whatever runtime the host
//! already has. What it buys is that the desktop and the server run a
//! `pilot.turn.start` through the same twenty lines, instead of two copies that
//! drift on what a model selection does or on when `threads.session_id` is
//! written.
//!
//! The projection is deliberately not here: an event arrives on the driver's
//! own task, not on the call that caused it, so the sink runs
//! [`crate::pilot::project`] and this module only answers the call.

use serde_json::{json, Value};

use boite_pilot::{Instance, OpenSpec, SwitchKind};

use crate::command::pilot::{catalog, turn_input, Pilot, PilotReady};
use crate::pilot::{answer_of_option, write_notice};
use crate::store::{ColVal, Store, ThreadCol};

/// Runs one prepared pilot call and answers the JSON the front doors wrap.
///
/// The refusals are `boite_pilot`'s own strings: "no pilot session for thread
/// X" is what the interface shows, and rewording it here would mean two
/// vocabularies for one failure.
pub async fn execute(ready: PilotReady) -> Result<Value, String> {
    let PilotReady {
        call,
        store,
        runtime,
        spec,
    } = ready;
    match call {
        Pilot::Catalog { refresh } => catalog(&store, &runtime, refresh),

        Pilot::Open { thread_id } => {
            let spec = spec.ok_or("pilot.thread.open was prepared without a spec")?;
            let opened = runtime.open(*spec).await.map_err(|e| e.to_string())?;
            // The pid at info, the way every child spawned is logged: it is the
            // only pid anything may later kill.
            tracing::info!(
                thread = thread_id,
                pid = opened.pid.unwrap_or(0),
                session = opened.native_session_id.as_deref().unwrap_or(""),
                "pilot.thread.open"
            );
            // Written here as well as in the projection: a driver that answers
            // its native id at open without emitting `session.started` would
            // otherwise leave the row unable to resume.
            if let Some(id) = &opened.native_session_id {
                store.update_thread_field(
                    &thread_id,
                    ThreadCol::SessionId,
                    ColVal::Text(id.clone()),
                )?;
            }
            serde_json::to_value(opened).map_err(|e| e.to_string())
        }

        Pilot::TurnStart {
            thread_id,
            text,
            model,
        } => {
            let turn = runtime
                .prompt(&thread_id, turn_input(text, model))
                .await
                .map_err(|e| e.to_string())?;
            tracing::debug!(thread = thread_id, turn = turn, "pilot.turn.start");
            Ok(json!({ "turnId": turn }))
        }

        Pilot::TurnInterrupt { thread_id } => {
            runtime
                .interrupt(&thread_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }

        Pilot::Respond {
            thread_id,
            request_id,
            option,
        } => {
            // The options the driver offered are what the card was drawn from,
            // so the vocabulary is checked against the stored request rather
            // than against a list written here.
            let offered = offered_options(&store, &thread_id, &request_id);
            let answer = answer_of_option(&option, &offered);
            runtime
                .respond(&thread_id, &request_id, answer)
                .await
                .map_err(|e| e.to_string())?;
            tracing::info!(
                thread = thread_id,
                request = request_id,
                option = option,
                "pilot.request.respond"
            );
            Ok(json!({ "ok": true }))
        }

        Pilot::ModelSet {
            thread_id,
            model,
            instance,
        } => {
            let selection = boite_pilot::ModelSelection {
                model: model.clone(),
                instance: instance.clone(),
            };
            let kind = runtime
                .set_model(&thread_id, selection)
                .await
                .map_err(|e| e.to_string())?;
            match kind {
                // Nothing stopped: the row records what answers now and the
                // session carries on mid-conversation.
                SwitchKind::InSession => {
                    write_model(&store, &thread_id, model.as_deref())?;
                }
                // The credentials are read at launch, so another account is
                // another process. The session is stopped politely, which keeps
                // the native id resumable, and reopened on it.
                SwitchKind::Restart => {
                    restart(&store, &runtime, &thread_id, spec, &model, &instance).await?;
                }
                // Answered as an error rather than as a switch that did
                // nothing: the picker has to be able to say so.
                SwitchKind::Unsupported => {
                    return Err(format!(
                        "this thread's driver cannot change model, so {} stays what answers",
                        model.as_deref().unwrap_or("the session default")
                    ));
                }
            }
            serde_json::to_value(json!({ "switch": kind })).map_err(|e| e.to_string())
        }

        Pilot::ModeSet { thread_id, mode } => {
            runtime
                .set_mode(&thread_id, mode)
                .await
                .map_err(|e| e.to_string())?;
            // Kept on the row so a resume opens in the mode the user chose,
            // merged into whatever effort the options already carried.
            let mut options = stored_options(&store, &thread_id);
            options.mode = mode;
            let text = serde_json::to_string(&options).map_err(|e| e.to_string())?;
            store.update_thread_field(&thread_id, ThreadCol::PilotOptions, ColVal::Text(text))?;
            Ok(json!({ "ok": true }))
        }

        Pilot::Stop { thread_id } => {
            runtime.stop(&thread_id).await.map_err(|e| e.to_string())?;
            tracing::debug!(thread = thread_id, "pilot.session.stop");
            Ok(json!({ "ok": true }))
        }

        Pilot::Items {
            thread_id,
            after_seq,
            limit,
        } => {
            let rows = store.pilot_items(&thread_id, after_seq, limit)?;
            Ok(Value::Array(rows.iter().map(item_json).collect()))
        }

        Pilot::Events {
            thread_id,
            after_seq,
            limit,
        } => {
            let rows = store.pilot_events(&thread_id, after_seq, limit)?;
            Ok(Value::Array(
                rows.into_iter()
                    .map(|row| {
                        json!({
                            "seq": row.seq,
                            "tsMs": row.ts_ms,
                            "kind": row.kind,
                            "payload": row.payload,
                        })
                    })
                    .collect(),
            ))
        }

        // Nothing to do on the bus: the transport registered the device before
        // the call reached here, and the bus's answer is whether it was allowed
        // to. Same shape as `logs.subscribe`.
        Pilot::Subscribe { .. } => Ok(json!(null)),
    }
}

/// What now answers, on the row.
///
/// `None` is the session's own default rather than an empty string: a column
/// carrying `""` would read as a model named nothing.
fn write_model(store: &Store, thread_id: &str, model: Option<&str>) -> Result<(), String> {
    match model {
        Some(model) => store.update_thread_field(
            thread_id,
            ThreadCol::PilotModel,
            ColVal::Text(model.to_string()),
        ),
        None => store.update_thread_field(thread_id, ThreadCol::PilotModel, ColVal::Null),
    }
}

/// Stops the session and reopens it on the account and model asked for.
///
/// The native session id is what makes this cheap: the polite stop leaves the
/// conversation on disk, the reopen passes it as `resume`, and the same
/// transcript carries on under a different process. A second of silence, and a
/// `notice` on the timeline saying what changed, because a chat pane that
/// swapped accounts without a word is a pane that lies about who answered.
async fn restart(
    store: &Store,
    runtime: &boite_pilot::Runtime,
    thread_id: &str,
    spec: Option<Box<OpenSpec>>,
    model: &Option<String>,
    instance: &Option<Instance>,
) -> Result<(), String> {
    let mut spec = *spec.ok_or("pilot.model.set was prepared without a spec")?;
    // Polite: the failure to stop a session that already went is not a reason
    // to refuse to open the next one.
    let _ = runtime.stop(thread_id).await;

    if let Some(instance) = instance.clone() {
        spec.instance = instance;
    }
    if model.is_some() {
        spec.model = model.clone();
    }
    // Read now rather than trusted from the spec built before the stop: the
    // session that just ended may have been the one that first minted the id.
    spec.resume = store
        .load_thread(thread_id)
        .ok()
        .flatten()
        .and_then(|thread| thread.session_id)
        .filter(|id| !id.is_empty());

    let driver = spec.driver.clone();
    let label = instance_label(&spec.instance);
    let named = spec.model.clone();
    runtime.open(spec).await.map_err(|e| e.to_string())?;

    let encoded = serde_json::to_string(instance).map_err(|e| e.to_string())?;
    if instance.is_some() {
        store.update_thread_field(thread_id, ThreadCol::PilotInstance, ColVal::Text(encoded))?;
    }
    write_model(store, thread_id, named.as_deref())?;
    let text = format!(
        "{driver} on {label} now answers, model {}",
        named.as_deref().unwrap_or("default")
    );
    tracing::info!(thread = thread_id, instance = label, "pilot.model.restart");
    write_notice(store, thread_id, &text)
}

/// What an instance is called in a sentence a user reads.
fn instance_label(instance: &Instance) -> String {
    match instance {
        Instance::Native { config_dir } => match config_dir {
            Some(dir) => format!("the account in {}", dir.display()),
            None => "the default account".to_string(),
        },
        Instance::Fastpick { provider, model } => format!("fastpick:{provider}:{model}"),
    }
}

/// The deltas waiting to go out, joined per item.
///
/// One `item.delta` per token is what a WebSocket cannot afford and what a
/// frame cannot paint, so both hosts hold text here and flush it on a 30 ms
/// tick. Keyed by thread and item rather than by thread alone: a turn can have
/// an assistant message and a reasoning block open at once, and joining those
/// two into one string would paint each other's text.
///
/// No timer of its own on purpose. `boite-core` declares no executor, so the
/// tick belongs to the host that already has one, and this is the part the two
/// hosts share.
#[derive(Debug, Default)]
pub struct Coalescer {
    pending: parking_lot::Mutex<std::collections::BTreeMap<(String, String), String>>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Holds one delta. Nothing goes out until [`Coalescer::drain`].
    pub fn push(&self, thread_id: &str, item_id: &str, text: &str) {
        let mut pending = self.pending.lock();
        pending
            .entry((thread_id.to_string(), item_id.to_string()))
            .or_default()
            .push_str(text);
    }

    /// Everything held, as one `item.delta` per item, oldest thread first.
    ///
    /// Empty when nothing streamed, which is what the tick checks before it
    /// touches a channel.
    pub fn drain(&self) -> Vec<(String, boite_pilot::PilotEvent)> {
        let mut pending = self.pending.lock();
        std::mem::take(&mut *pending)
            .into_iter()
            .map(|((thread_id, item_id), text)| {
                (
                    thread_id,
                    boite_pilot::PilotEvent::ItemDelta { item_id, text },
                )
            })
            .collect()
    }

    /// What one thread streamed, for the flush that has to happen before a
    /// complete item or a request goes out: those leave at once, and a delta
    /// arriving after the card it belongs to would paint text twice.
    pub fn drain_thread(&self, thread_id: &str) -> Vec<boite_pilot::PilotEvent> {
        let mut pending = self.pending.lock();
        let keys: Vec<(String, String)> = pending
            .keys()
            .filter(|(thread, _)| thread == thread_id)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|key| {
                pending
                    .remove(&key)
                    .map(|text| boite_pilot::PilotEvent::ItemDelta {
                        item_id: key.1,
                        text,
                    })
            })
            .collect()
    }
}

/// One item row as the chat pane reads it.
///
/// `body` is parsed back out of its column rather than shipped as a string: the
/// pane reads fields off it, and a client should not have to parse JSON twice.
fn item_json(row: &crate::store::PilotItemRow) -> Value {
    json!({
        "id": row.id,
        "threadId": row.thread_id,
        "seq": row.seq,
        "turnId": row.turn_id,
        "kind": row.kind,
        "state": row.state,
        "body": serde_json::from_str::<Value>(&row.body).unwrap_or(Value::Null),
        "createdMs": row.created_ms,
        "updatedMs": row.updated_ms,
    })
}

/// The options the driver offered for a request, read back off its item.
///
/// An empty list is the honest answer for a request boite never saw, and
/// [`answer_of_option`] then refuses anything but the two words it knows.
fn offered_options(
    store: &Store,
    thread_id: &str,
    request_id: &str,
) -> Vec<boite_pilot::RequestOption> {
    let id = crate::pilot::request_item_id(request_id);
    let Ok(rows) = store.pilot_items(thread_id, 0, 1000) else {
        return Vec::new();
    };
    rows.into_iter()
        .find(|row| row.id == id)
        .and_then(|row| serde_json::from_str::<boite_pilot::Request>(&row.body).ok())
        .map(|request| request.options)
        .unwrap_or_default()
}

fn stored_options(store: &Store, thread_id: &str) -> boite_pilot::Options {
    store
        .load_thread(thread_id)
        .ok()
        .flatten()
        .and_then(|thread| thread.pilot_options)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use boite_pilot::scripted::{Recorder, Scenario, ScriptedDriver};
    use boite_pilot::{ItemKind, PilotEvent, Runtime};

    use crate::command::pilot::Pilot;
    use crate::model::{Thread, RUNTIME_PILOT};

    fn store(tag: &str) -> Arc<Store> {
        let path = std::env::temp_dir()
            .join(format!("boite-pilot-host-{}-{tag}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Arc::new(Store::open(&path).expect("open"))
    }

    /// A chat row already bound to a conversation, so a restart has something
    /// to resume onto.
    fn row(session_id: Option<&str>) -> Thread {
        Thread {
            id: "t1".into(),
            project_id: "p1".into(),
            pty_id: None,
            label: "chat".into(),
            title: None,
            cmd: "claude".into(),
            args: vec![],
            icon_key: None,
            icon_color: None,
            session_id: session_id.map(str::to_string),
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
            runtime: RUNTIME_PILOT.into(),
            pilot_driver: Some("scripted".into()),
            pilot_instance: None,
            pilot_model: Some("sonnet".into()),
            pilot_options: None,
        }
    }

    fn spec() -> OpenSpec {
        OpenSpec {
            thread_id: "t1".into(),
            cwd: std::env::temp_dir(),
            driver: "scripted".into(),
            instance: Instance::default(),
            model: Some("sonnet".into()),
            options: Default::default(),
            resume: None,
            mcp_servers: Vec::new(),
            system_prompt_append: None,
            env: Default::default(),
            bin: Vec::new(),
        }
    }

    /// A model selection naming another account is a restart, end to end.
    ///
    /// The whole point of the restart path is that it is cheap: the polite stop
    /// leaves the conversation on disk, the reopen passes it as `resume`, and
    /// the same transcript carries on under a different process. So all three
    /// halves are asserted rather than the switch kind alone, which a call that
    /// stopped a session and opened nothing would also answer.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_restart_stops_reopens_on_the_session_and_says_so_on_the_timeline() {
        let store = store("restart");
        store.save_thread(&row(Some("native-7"))).expect("row");

        let recorder = Recorder::new();
        let runtime = Arc::new(Runtime::new(recorder.clone()));
        // In memory rather than from a file: the driver's own `from_env` reads
        // a process-global variable, and these tests run in parallel.
        runtime.register(Arc::new(ScriptedDriver::with_scenario(Scenario::default())));
        let mut first = spec();
        first.resume = Some("native-7".into());
        runtime.open(first).await.expect("the first session");
        assert_eq!(runtime.native_session_id("t1").as_deref(), Some("native-7"));

        let instance = Instance::Fastpick {
            provider: "crof".into(),
            model: "deepseek-v4-pro".into(),
        };
        let answer = execute(PilotReady {
            call: Pilot::ModelSet {
                thread_id: "t1".into(),
                model: Some("opus".into()),
                instance: Some(instance.clone()),
            },
            store: store.clone(),
            runtime: runtime.clone(),
            spec: Some(Box::new(spec())),
        })
        .await
        .expect("the restart");
        assert_eq!(answer["switch"], "restart");

        // The row now names the account and the model that answer.
        let thread = store.load_thread("t1").unwrap().expect("the row");
        assert_eq!(thread.pilot_model.as_deref(), Some("opus"));
        let written: Instance =
            serde_json::from_str(thread.pilot_instance.as_deref().expect("an instance"))
                .expect("readable");
        assert_eq!(written, instance);

        // The reopen resumed rather than starting a conversation of its own:
        // the scripted driver keeps whatever `resume` named as its native id.
        assert_eq!(
            runtime.native_session_id("t1").as_deref(),
            Some("native-7"),
            "a restart that lost the session id is a new conversation"
        );

        // And the timeline says who answers now. A pane that swapped accounts
        // without a word is a pane that lies about who wrote the next answer.
        let items = store.pilot_items("t1", 0, 50).expect("items");
        let notice = items
            .iter()
            .find(|item| item.kind == "notice")
            .expect("a notice on the timeline");
        assert!(notice.body.contains("fastpick:crof:deepseek-v4-pro"), "{}", notice.body);
        assert!(notice.body.contains("opus"), "{}", notice.body);

        // The old session was stopped politely, not left running beside the new
        // one: two children on one thread would both answer.
        let exits = recorder
            .events()
            .into_iter()
            .filter(|event| matches!(event, PilotEvent::SessionExited { .. }))
            .count();
        assert_eq!(exits, 1, "the session that was replaced said goodbye once");
    }

    /// A driver that cannot change model at all is an error the picker shows,
    /// not a switch that quietly did nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_thread_with_no_session_refuses_by_name() {
        let store = store("nosession");
        store.save_thread(&row(None)).expect("row");
        let runtime = Arc::new(Runtime::new(Recorder::new()));
        let refusal = execute(PilotReady {
            call: Pilot::ModelSet {
                thread_id: "t1".into(),
                model: Some("opus".into()),
                instance: None,
            },
            store,
            runtime,
            spec: Some(Box::new(spec())),
        })
        .await
        .expect_err("no session to switch");
        assert!(refusal.contains("t1"), "{refusal}");
    }

    /// A burst of deltas leaves as fewer frames than there were deltas.
    ///
    /// This is the budget line "deltas coalesced" asserted where it is decided.
    /// Both hosts hold text here and flush it on their own 30 ms tick, so the
    /// join is the part they share and the timer is the part they do not.
    #[test]
    fn a_delta_burst_leaves_as_one_frame_per_item() {
        let coalescer = Coalescer::new();
        for i in 0..200 {
            coalescer.push("t1", "i1", "x");
            // A turn can have an assistant message and a reasoning block open
            // at once, and joining those two into one string would paint each
            // other's text.
            if i % 2 == 0 {
                coalescer.push("t1", "i2", "y");
            }
            coalescer.push("t2", "i9", "z");
        }
        let flushed = coalescer.drain();
        assert_eq!(flushed.len(), 3, "one frame per thread and item, not per delta");
        let text = |item: &str| {
            flushed
                .iter()
                .find_map(|(_, event)| match event {
                    PilotEvent::ItemDelta { item_id, text } if item_id == item => {
                        Some(text.clone())
                    }
                    _ => None,
                })
                .expect(item)
        };
        assert_eq!(text("i1").len(), 200, "every delta is still in the frame");
        assert_eq!(text("i2").len(), 100);
        // Drained is drained: a second tick with nothing new sends nothing, and
        // that is what the tick checks before it touches a channel.
        assert!(coalescer.drain().is_empty());

        // One thread's text can be flushed on its own, which is what has to
        // happen before a complete item or a request goes out: those leave at
        // once, and a delta arriving after the card it belongs to would paint
        // the text twice.
        coalescer.push("t1", "i1", "a");
        coalescer.push("t2", "i9", "b");
        assert_eq!(coalescer.drain_thread("t1").len(), 1);
        assert_eq!(coalescer.drain().len(), 1, "the other thread is untouched");
    }

    /// The notice is boite's own line, so it is `notice` and never
    /// `assistant_text`: a pane draws the second as an answer the agent gave.
    #[test]
    fn the_notice_kind_is_boites_own() {
        assert_eq!(
            serde_json::to_value(ItemKind::Notice).unwrap(),
            json!("notice")
        );
    }
}
