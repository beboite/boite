//! Generic ACP driver against a local JSON-RPC fake. No credential or model call.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use boite_pilot::scripted::Recorder;
use boite_pilot::{
    ExecMode, ExitReason, ItemKind, ModelSelection, OpenSpec, Options, PilotEvent, RequestAnswer,
    RequestOutcome, Runtime, Status, TurnInput,
};

fn fake_bin() -> Vec<String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-acp.mjs");
    vec!["node".into(), script.to_string_lossy().to_string()]
}

fn spec(thread_id: &str, driver: &str) -> OpenSpec {
    OpenSpec {
        thread_id: thread_id.into(),
        cwd: std::env::temp_dir(),
        driver: driver.into(),
        bin: fake_bin(),
        ..Default::default()
    }
}

async fn until(recorder: &Recorder, what: &str, predicate: impl Fn(&[PilotEvent]) -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let events = recorder.events();
        if predicate(&events) {
            return;
        }
        if std::time::Instant::now() > deadline {
            panic!("timed out waiting for {what}; got {:?}", recorder.kinds());
        }
        tokio::task::yield_now().await;
    }
}

fn has(kind: &str) -> impl Fn(&[PilotEvent]) -> bool + '_ {
    move |events| events.iter().any(|event| event.kind() == kind)
}

fn find<T>(events: &[PilotEvent], pick: impl Fn(&PilotEvent) -> Option<T>) -> Option<T> {
    events.iter().find_map(pick)
}

#[tokio::test]
async fn runtime_registers_t3_acp_drivers_and_opens_cursor() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    let drivers = runtime.drivers();
    assert!(drivers.contains(&"acp:cursor".to_string()));
    assert!(drivers.contains(&"acp:grok".to_string()));
    assert!(drivers.contains(&"acp:antigravity".to_string()));

    let opened = runtime
        .open(spec("acp-open", "acp:cursor"))
        .await
        .expect("open");
    assert_eq!(opened.native_session_id.as_deref(), Some("native-acp"));
    assert_eq!(opened.model.as_deref(), Some("acp-default"));
    assert_eq!(runtime.status("acp-open"), Some(Status::Idle));
    let (commands, models) = find(&recorder.events(), |event| match event {
        PilotEvent::SessionStarted {
            slash_commands,
            extra,
            ..
        } => Some((slash_commands.clone(), extra["availableModels"].clone())),
        _ => None,
    })
    .expect("session.started");
    assert_eq!(commands, ["compact"]);
    assert!(models
        .as_array()
        .is_some_and(|models| models.iter().any(|model| model == "acp-default")));
    runtime.stop("acp-open").await.expect("stop");
}

#[tokio::test]
async fn a_turn_reduces_thought_tool_plan_text_and_usage() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime
        .open(spec("acp-turn", "acp:cursor"))
        .await
        .expect("open");
    let turn = runtime
        .prompt("acp-turn", TurnInput::text("plain"))
        .await
        .expect("prompt dispatch");
    until(&recorder, "turn.completed", has("turn.completed")).await;

    let events = recorder.events();
    assert!(events.iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::Reasoning && item.body["text"] == "checking"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::Command && item.body["output"] == "clean"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::Plan && item.body["entries"].is_array()
    )));
    let completed = find(&events, |event| match event {
        PilotEvent::TurnCompleted { turn_id, usage, .. } => Some((turn_id.clone(), usage.clone())),
        _ => None,
    })
    .expect("turn.completed");
    assert_eq!(completed.0, turn);
    assert_eq!(completed.1.input_tokens, 21);
    assert_eq!(completed.1.output_tokens, 8);
    assert_eq!(completed.1.context_window, Some(128_000));
    assert_eq!(completed.1.total_cost_usd, Some(0.01));
    runtime.stop("acp-turn").await.expect("stop");
}

#[tokio::test]
async fn permission_round_trips_the_agents_opaque_option_id() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime
        .open(spec("acp-permission", "acp:cursor"))
        .await
        .expect("open");
    runtime
        .prompt("acp-permission", TurnInput::text("approve"))
        .await
        .expect("prompt");
    until(&recorder, "request.opened", has("request.opened")).await;
    assert_eq!(runtime.status("acp-permission"), Some(Status::Waiting));
    let request = find(&recorder.events(), |event| match event {
        PilotEvent::RequestOpened { request } => Some(request.clone()),
        _ => None,
    })
    .expect("request");
    assert_eq!(request.options[1].value, "native-always");
    runtime
        .respond(
            "acp-permission",
            &request.id,
            RequestAnswer::selected("native-always"),
        )
        .await
        .expect("respond");
    until(&recorder, "turn.completed", has("turn.completed")).await;
    let events = recorder.events();
    assert!(events.iter().any(|event| matches!(
        event,
        PilotEvent::RequestResolved {
            outcome: RequestOutcome::Allowed,
            ..
        }
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::AssistantText && item.body["text"] == "native-always"
    )));
    runtime.stop("acp-permission").await.expect("stop");
}

#[tokio::test]
async fn form_elicitation_returns_every_field_with_native_ids() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime
        .open(spec("acp-form", "acp:cursor"))
        .await
        .expect("open");
    runtime
        .prompt("acp-form", TurnInput::text("elicit"))
        .await
        .expect("prompt");
    until(&recorder, "request.opened", has("request.opened")).await;
    let request = find(&recorder.events(), |event| match event {
        PilotEvent::RequestOpened { request } => Some(request.clone()),
        _ => None,
    })
    .expect("request");
    assert_eq!(request.questions.len(), 2);
    assert!(request.questions[1].multi_select);
    let answers = BTreeMap::from([
        ("note".to_string(), vec!["ship it".to_string()]),
        (
            "targets".to_string(),
            vec!["web".to_string(), "desktop".to_string()],
        ),
    ]);
    runtime
        .respond("acp-form", &request.id, RequestAnswer::answers(answers))
        .await
        .expect("respond");
    until(&recorder, "turn.completed", has("turn.completed")).await;
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::AssistantText
                && item.body["text"] == "web+desktop:ship it"
    )));
    runtime.stop("acp-form").await.expect("stop");
}

#[tokio::test]
async fn grok_switches_model_and_mode_in_session() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    let mut open = spec("acp-grok", "acp:grok");
    open.model = Some("grok-test".into());
    open.options = Options {
        effort: Some("high".into()),
        mode: ExecMode::Ask,
    };
    runtime.open(open).await.expect("open");
    runtime
        .set_model("acp-grok", ModelSelection::model("acp-default"))
        .await
        .expect("set model");
    runtime
        .set_mode("acp-grok", ExecMode::Yolo)
        .await
        .expect("set mode");
    runtime
        .prompt("acp-grok", TurnInput::text("settings"))
        .await
        .expect("prompt");
    until(&recorder, "turn.completed", has("turn.completed")).await;
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::AssistantText && item.body["text"] == "acp-default:yolo"
    )));
    runtime.stop("acp-grok").await.expect("stop");
}

#[tokio::test]
async fn cursor_loads_while_antigravity_resumes_without_replay() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    let mut cursor = spec("acp-load", "acp:cursor");
    cursor.resume = Some("cursor-native".into());
    let loaded = runtime.open(cursor).await.expect("load");
    assert_eq!(loaded.native_session_id.as_deref(), Some("cursor-native"));
    assert_eq!(loaded.model.as_deref(), Some("loaded-model"));
    assert!(!recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::ItemStarted { .. } | PilotEvent::ItemCompleted { .. }
    )));
    runtime.stop("acp-load").await.expect("stop");

    let mut antigravity = spec("acp-resume", "acp:antigravity");
    antigravity.resume = Some("antigravity-native".into());
    let resumed = runtime.open(antigravity).await.expect("resume");
    assert_eq!(
        resumed.native_session_id.as_deref(),
        Some("antigravity-native")
    );
    assert_eq!(resumed.model.as_deref(), Some("resumed-model"));
    runtime.stop("acp-resume").await.expect("stop");
}

#[tokio::test]
async fn interrupt_cancels_the_prompt_once_and_stop_is_graceful() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime
        .open(spec("acp-stop", "acp:cursor"))
        .await
        .expect("open");
    let turn = runtime
        .prompt("acp-stop", TurnInput::text("hang"))
        .await
        .expect("prompt");
    runtime.interrupt("acp-stop").await.expect("interrupt");
    until(&recorder, "turn.aborted", has("turn.aborted")).await;
    assert_eq!(
        recorder
            .events()
            .iter()
            .filter(|event| matches!(
                event,
                PilotEvent::TurnAborted { turn_id, .. } if turn_id == &turn
            ))
            .count(),
        1
    );
    runtime.stop("acp-stop").await.expect("stop");
    until(&recorder, "session.exited", has("session.exited")).await;
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::SessionExited {
            reason: ExitReason::Stopped
        }
    )));
}
