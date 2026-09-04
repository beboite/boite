//! Codex driver against a local JSON-RPC fake. No credential or model call.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use boite_pilot::scripted::Recorder;
use boite_pilot::{
    ExitReason, ItemKind, OpenSpec, PilotEvent, RequestAnswer, RequestOutcome, Runtime, Status,
    TurnInput,
};

fn fake_bin() -> Vec<String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-codex.mjs");
    vec!["node".into(), script.to_string_lossy().to_string()]
}

fn spec(thread_id: &str) -> OpenSpec {
    OpenSpec {
        thread_id: thread_id.into(),
        cwd: std::env::temp_dir(),
        driver: "codex".into(),
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
async fn open_initializes_app_server_and_binds_its_thread() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    let opened = runtime.open(spec("codex-open")).await.expect("open");
    assert_eq!(opened.native_session_id.as_deref(), Some("native-codex"));
    assert!(opened.pid.is_some());
    assert_eq!(runtime.status("codex-open"), Some(Status::Idle));
    assert!(runtime.drivers().contains(&"codex".to_string()));
    let models = find(&recorder.events(), |event| match event {
        PilotEvent::SessionStarted { extra, .. } => extra.get("availableModels").cloned(),
        _ => None,
    })
    .expect("live model catalog");
    assert_eq!(models, serde_json::json!(["live-model-a", "live-model-b"]));
    runtime.stop("codex-open").await.expect("stop");
}

#[tokio::test]
async fn old_or_cyclic_model_catalog_falls_back_without_losing_session() {
    for flag in ["--no-model-list", "--cyclic-model-list"] {
        let recorder = Recorder::new();
        let runtime = Runtime::new(recorder.clone());
        let mut spec = spec("catalog-fallback");
        spec.bin.push(flag.into());
        runtime.open(spec).await.expect("open with fallback");
        assert!(recorder.events().iter().any(|event| matches!(event,
            PilotEvent::SessionStarted { extra, .. } if extra.get("modelCatalogFallback") == Some(&serde_json::json!(true))
        )));
        runtime.stop("catalog-fallback").await.expect("stop");
    }
}

#[tokio::test]
async fn a_turn_streams_items_and_exact_usage() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("codex-turn")).await.expect("open");
    let turn = runtime
        .prompt("codex-turn", TurnInput::text("plain"))
        .await
        .expect("prompt");
    until(&recorder, "turn.completed", has("turn.completed")).await;

    let events = recorder.events();
    let deltas = events
        .iter()
        .filter_map(|event| match event {
            PilotEvent::ItemDelta { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(deltas, ["o", "k"]);
    let completed = find(&events, |event| match event {
        PilotEvent::TurnCompleted {
            turn_id,
            duration_ms,
            usage,
        } => Some((turn_id.clone(), *duration_ms, usage.clone())),
        _ => None,
    })
    .expect("turn.completed");
    assert_eq!(completed.0, turn);
    assert_eq!(completed.1, 42);
    assert_eq!(completed.2.input_tokens, 11);
    assert_eq!(completed.2.output_tokens, 7);
    assert_eq!(completed.2.context_window, Some(200_000));
    assert_eq!(runtime.status("codex-turn"), Some(Status::Idle));
    runtime.stop("codex-turn").await.expect("stop");
}

#[tokio::test]
async fn command_approval_round_trips_the_t3_session_decision() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("codex-approval")).await.expect("open");
    runtime
        .prompt("codex-approval", TurnInput::text("approve"))
        .await
        .expect("prompt");
    until(&recorder, "request.opened", has("request.opened")).await;
    assert_eq!(runtime.status("codex-approval"), Some(Status::Waiting));

    let request = find(&recorder.events(), |event| match event {
        PilotEvent::RequestOpened { request } => Some(request.clone()),
        _ => None,
    })
    .expect("request");
    assert_eq!(request.tool_name.as_deref(), Some("Command"));
    assert_eq!(request.input["command"], "git status");
    runtime
        .respond(
            "codex-approval",
            &request.id,
            RequestAnswer::allow_for_session(),
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
    let command = find(&events, |event| match event {
        PilotEvent::ItemCompleted { item } if item.kind == ItemKind::Command => {
            Some(item.body.clone())
        }
        _ => None,
    })
    .expect("command item");
    assert_eq!(command["output"], "acceptForSession");
    runtime.stop("codex-approval").await.expect("stop");
}

#[tokio::test]
async fn structured_question_returns_the_selected_option() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("codex-question")).await.expect("open");
    runtime
        .prompt("codex-question", TurnInput::text("question"))
        .await
        .expect("prompt");
    until(&recorder, "request.opened", has("request.opened")).await;
    let request = find(&recorder.events(), |event| match event {
        PilotEvent::RequestOpened { request } => Some(request.clone()),
        _ => None,
    })
    .expect("request");
    assert_eq!(request.options[0].value, "Desktop");
    runtime
        .respond(
            "codex-question",
            &request.id,
            RequestAnswer::selected("Desktop"),
        )
        .await
        .expect("respond");
    until(&recorder, "turn.completed", has("turn.completed")).await;
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::AssistantText && item.body["text"] == "Desktop"
    )));
    runtime.stop("codex-question").await.expect("stop");
}

#[tokio::test]
async fn structured_questions_keep_each_provider_id_and_free_text_answer() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("codex-questions")).await.expect("open");
    runtime
        .prompt("codex-questions", TurnInput::text("questions"))
        .await
        .expect("prompt");
    until(&recorder, "request.opened", has("request.opened")).await;
    let request = find(&recorder.events(), |event| match event {
        PilotEvent::RequestOpened { request } => Some(request.clone()),
        _ => None,
    })
    .expect("request");
    assert_eq!(request.questions.len(), 2);
    assert_eq!(request.questions[0].id, "target");
    assert_eq!(request.questions[1].id, "reason");
    assert!(request.questions[1].allow_custom_answer);

    let answers = BTreeMap::from([
        ("target".to_string(), vec!["Server".to_string()]),
        ("reason".to_string(), vec!["Runs remotely".to_string()]),
    ]);
    runtime
        .respond(
            "codex-questions",
            &request.id,
            RequestAnswer::answers(answers),
        )
        .await
        .expect("respond");
    until(&recorder, "turn.completed", has("turn.completed")).await;
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::AssistantText
                && item.body["text"] == "Server:Runs remotely"
    )));
    runtime.stop("codex-questions").await.expect("stop");
}

#[tokio::test]
async fn compact_uses_the_native_app_server_operation() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("codex-compact")).await.expect("open");
    let turn = runtime
        .compact("codex-compact", TurnInput::text("/compact"))
        .await
        .expect("compact");
    until(&recorder, "turn.completed", has("turn.completed")).await;
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::TurnCompleted { turn_id, .. } if turn_id == &turn
    )));
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item }
            if item.kind == ItemKind::Notice
                && item.body["text"] == "Codex compacted the conversation context"
    )));
    runtime.stop("codex-compact").await.expect("stop");
}

#[tokio::test]
async fn interrupt_aborts_once_and_stop_is_graceful() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("codex-stop")).await.expect("open");
    let turn = runtime
        .prompt("codex-stop", TurnInput::text("hang"))
        .await
        .expect("prompt");
    assert_eq!(runtime.status("codex-stop"), Some(Status::Busy));
    assert!(runtime
        .compact("codex-stop", TurnInput::text("/compact"))
        .await
        .is_err());
    let steered = runtime
        .prompt("codex-stop", TurnInput::text("focus here"))
        .await
        .expect("steer");
    assert_eq!(steered, turn);
    assert!(runtime
        .prompt("codex-stop", TurnInput::text("reject-steer"))
        .await
        .is_err());
    assert_eq!(runtime.status("codex-stop"), Some(Status::Busy));
    assert_eq!(
        recorder
            .kinds()
            .iter()
            .filter(|kind| **kind == "turn.started")
            .count(),
        1
    );
    runtime.interrupt("codex-stop").await.expect("interrupt");
    let aborted = recorder
        .events()
        .iter()
        .filter(
            |event| matches!(event, PilotEvent::TurnAborted { turn_id, .. } if turn_id == &turn),
        )
        .count();
    assert_eq!(aborted, 1);
    runtime.stop("codex-stop").await.expect("stop");
    until(&recorder, "session.exited", has("session.exited")).await;
    assert!(recorder.events().iter().any(|event| matches!(
        event,
        PilotEvent::SessionExited {
            reason: ExitReason::Stopped
        }
    )));
}
