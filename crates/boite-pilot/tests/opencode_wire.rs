//! OpenCode HTTP/SSE driver against a local fake. No credential or model call.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use boite_pilot::scripted::Recorder;
use boite_pilot::{
    ExecMode, ExitReason, ItemKind, McpServer, ModelSelection, OpenSpec, PilotEvent, RequestAnswer,
    RequestOutcome, Runtime, Status, TurnInput,
};

fn fake_bin() -> Vec<String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-opencode.mjs");
    vec!["node".into(), script.to_string_lossy().to_string()]
}

fn spec(thread_id: &str) -> OpenSpec {
    OpenSpec {
        thread_id: thread_id.into(),
        cwd: std::env::temp_dir(),
        driver: "opencode".into(),
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
async fn runtime_registers_opencode_and_opens_an_sdk_session() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    assert!(runtime.drivers().contains(&"opencode".to_string()));
    let mut open = spec("opencode-open");
    open.mcp_servers.push(McpServer {
        name: "boite".into(),
        command: "boite-mcp".into(),
        args: vec!["--thread".into(), "opencode-open".into()],
        env: BTreeMap::new(),
    });
    let opened = runtime.open(open).await.expect("open");
    assert_eq!(opened.native_session_id.as_deref(), Some("ses_fake"));
    assert_eq!(opened.model.as_deref(), Some("fake/model-a"));
    assert!(opened.pid.is_some());
    assert_eq!(runtime.status("opencode-open"), Some(Status::Idle));
    let models = find(&recorder.events(), |event| match event {
        PilotEvent::SessionStarted { extra, .. } => Some(extra["availableModels"].clone()),
        _ => None,
    })
    .expect("session.started");
    assert_eq!(models, serde_json::json!(["fake/model-a", "fake/model-b"]));
    runtime.stop("opencode-open").await.expect("stop");
}

#[tokio::test]
async fn a_turn_streams_text_tool_plan_and_exact_usage() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("opencode-turn")).await.expect("open");
    let turn = runtime
        .prompt("opencode-turn", TurnInput::text("plain"))
        .await
        .expect("prompt");
    until(&recorder, "turn.completed", has("turn.completed")).await;
    let events = recorder.events();
    let deltas = events
        .iter()
        .filter_map(|event| match event {
            PilotEvent::ItemDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(deltas, ["o", "k"]);
    assert!(events.iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::Command && item.body["output"] == "clean"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item } if item.kind == ItemKind::Plan
    )));
    let completed = find(&events, |event| match event {
        PilotEvent::TurnCompleted { turn_id, usage, .. } => Some((turn_id.clone(), usage.clone())),
        _ => None,
    })
    .expect("turn.completed");
    assert_eq!(completed.0, turn);
    assert_eq!(completed.1.input_tokens, 20);
    assert_eq!(completed.1.output_tokens, 9);
    assert_eq!(completed.1.cache_read_input_tokens, 4);
    assert_eq!(completed.1.cache_creation_input_tokens, 1);
    assert_eq!(completed.1.total_cost_usd, Some(0.02));
    runtime.stop("opencode-turn").await.expect("stop");
}

#[tokio::test]
async fn permission_round_trips_the_always_decision() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime
        .open(spec("opencode-permission"))
        .await
        .expect("open");
    runtime
        .prompt("opencode-permission", TurnInput::text("approve"))
        .await
        .expect("prompt");
    until(&recorder, "request.opened", has("request.opened")).await;
    assert_eq!(runtime.status("opencode-permission"), Some(Status::Waiting));
    let request = find(&recorder.events(), |event| match event {
        PilotEvent::RequestOpened { request } => Some(request.clone()),
        _ => None,
    })
    .expect("request");
    assert_eq!(request.id, "per_native");
    assert_eq!(request.options[1].value, "always");
    assert!(runtime
        .respond(
            "opencode-permission",
            &request.id,
            RequestAnswer::Allow {
                updated_input: None,
                updated_permissions: serde_json::Value::Null,
                for_session: false,
                selected: Some("unknown".into())
            }
        )
        .await
        .is_err());
    assert_eq!(runtime.status("opencode-permission"), Some(Status::Waiting));
    runtime
        .respond(
            "opencode-permission",
            &request.id,
            RequestAnswer::allow_for_session(),
        )
        .await
        .expect("respond");
    until(&recorder, "turn.completed", has("turn.completed")).await;
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::AssistantText && item.body["text"] == "always"
    )));
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::RequestResolved {
            outcome: RequestOutcome::Allowed,
            ..
        }
    )));
    runtime.stop("opencode-permission").await.expect("stop");
}

#[tokio::test]
async fn questions_keep_t3s_stable_ids_and_answer_order() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("opencode-question")).await.expect("open");
    runtime
        .prompt("opencode-question", TurnInput::text("question"))
        .await
        .expect("prompt");
    until(&recorder, "request.opened", has("request.opened")).await;
    let request = find(&recorder.events(), |event| match event {
        PilotEvent::RequestOpened { request } => Some(request.clone()),
        _ => None,
    })
    .expect("request");
    assert_eq!(request.questions[0].id, "question-0-target");
    assert_eq!(request.questions[1].id, "question-1-flags");
    assert!(request.questions[1].multi_select);
    let answers = BTreeMap::from([
        ("question-0-target".into(), vec!["Desktop".into()]),
        (
            "question-1-flags".into(),
            vec!["Fast".into(), "Safe".into()],
        ),
    ]);
    runtime
        .respond(
            "opencode-question",
            &request.id,
            RequestAnswer::answers(answers),
        )
        .await
        .expect("respond");
    until(&recorder, "turn.completed", has("turn.completed")).await;
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::AssistantText && item.body["text"] == "Desktop:Fast+Safe"
    )));
    runtime.stop("opencode-question").await.expect("stop");
}

#[tokio::test]
async fn model_and_mode_switch_without_restarting_the_server() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("opencode-settings")).await.expect("open");
    assert_eq!(
        runtime
            .set_model("opencode-settings", ModelSelection::model("fake/model-b"))
            .await
            .expect("model"),
        boite_pilot::SwitchKind::InSession
    );
    runtime
        .set_mode("opencode-settings", ExecMode::EditAlone)
        .await
        .expect("mode");
    runtime
        .prompt("opencode-settings", TurnInput::text("settings"))
        .await
        .expect("prompt");
    until(&recorder, "turn.completed", has("turn.completed")).await;
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::AssistantText
                && item.body["text"] == "fake/model-b:settings"
    )));
    runtime.stop("opencode-settings").await.expect("stop");
}

#[tokio::test]
async fn resume_reuses_a_native_session_and_missing_resume_falls_back() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    let mut resumed = spec("opencode-resume");
    resumed.resume = Some("ses_resume".into());
    let opened = runtime.open(resumed).await.expect("resume");
    assert_eq!(opened.native_session_id.as_deref(), Some("ses_resume"));
    assert_eq!(runtime.status("opencode-resume"), Some(Status::Waiting));
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::RequestOpened { request } if request.id == "per_recovered"
    )));
    runtime.stop("opencode-resume").await.expect("stop");

    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder);
    let mut missing = spec("opencode-missing");
    missing.resume = Some("ses_missing".into());
    let opened = runtime
        .open(missing)
        .await
        .expect("missing resume fallback");
    assert_eq!(opened.native_session_id.as_deref(), Some("ses_fake"));
    runtime.stop("opencode-missing").await.expect("stop");
}

#[tokio::test]
async fn compact_interrupt_and_stop_use_native_http_operations() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("opencode-control")).await.expect("open");
    let compact = runtime
        .compact("opencode-control", TurnInput::text("/compact"))
        .await
        .expect("compact");
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::TurnCompleted { turn_id, .. } if turn_id == &compact
    )));
    let running = runtime
        .prompt("opencode-control", TurnInput::text("hang"))
        .await
        .expect("prompt");
    runtime
        .interrupt("opencode-control")
        .await
        .expect("interrupt");
    assert!(!recorder.events().iter().any(|event| matches!(event,
        PilotEvent::TurnCompleted { turn_id, .. } if turn_id == &running
    )));
    assert_eq!(
        recorder
            .events()
            .iter()
            .filter(|event| matches!(event, PilotEvent::TurnAborted { turn_id, .. } if turn_id == &running))
            .count(),
        1
    );
    runtime.stop("opencode-control").await.expect("stop");
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::SessionExited {
            reason: ExitReason::Stopped
        }
    )));
}

#[tokio::test]
#[ignore = "requires an installed OpenCode CLI; creates a session but sends no model prompt"]
async fn installed_opencode_server_opens_and_stops_without_a_model_call() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder);
    let opened = runtime
        .open(OpenSpec {
            thread_id: "opencode-real-smoke".into(),
            cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            driver: "opencode".into(),
            env: BTreeMap::from([("OPENCODE_CONFIG_CONTENT".into(), "{}".into())]),
            ..Default::default()
        })
        .await
        .expect("installed OpenCode opens");
    assert!(opened.native_session_id.is_some());
    assert!(opened.pid.is_some());
    runtime.stop("opencode-real-smoke").await.expect("stop");
}

#[tokio::test]
async fn dropping_runtime_closes_the_owned_server() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("opencode-drop")).await.expect("open");
    drop(runtime);
    until(
        &recorder,
        "session.exited after drop",
        has("session.exited"),
    )
    .await;
}
