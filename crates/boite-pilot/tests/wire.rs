//! The claude driver against the fake binary, one scenario per behaviour.
//!
//! Each test spawns `node tests/fake-claude.mjs <scenario.json>` through
//! `OpenSpec::bin` rather than through `BOITE_PILOT_CLAUDE_BIN`: an env var is
//! process-global and these tests run in parallel, so one would pick another's
//! scenario. The env var is the door the dev MCP and the e2e runner use, and
//! `proc::resolve_bin` covers it in a unit test.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use boite_pilot::scripted::{Recorder, Scenario, ScriptedDriver, Step};
use boite_pilot::{
    ExitReason, ModelSelection, OpenSpec, PilotEvent, RequestAnswer, Runtime, Status, TurnInput,
};

fn scenario_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/scenarios").join(name)
}

fn fake_bin(scenario: &str) -> Vec<String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-claude.mjs");
    vec![
        "node".to_string(),
        script.to_string_lossy().to_string(),
        scenario_path(scenario).to_string_lossy().to_string(),
    ]
}

fn spec(thread_id: &str, scenario: &str) -> OpenSpec {
    OpenSpec {
        thread_id: thread_id.to_string(),
        cwd: std::env::temp_dir(),
        driver: "claude".to_string(),
        bin: fake_bin(scenario),
        ..Default::default()
    }
}

/// Poll the recorder until `predicate` holds. The events cross a channel and a
/// task, so nothing here can assert on them synchronously.
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
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn has(kind: &str) -> impl Fn(&[PilotEvent]) -> bool + '_ {
    move |events: &[PilotEvent]| events.iter().any(|event| event.kind() == kind)
}

fn find<'a, T>(
    events: &'a [PilotEvent],
    pick: impl Fn(&'a PilotEvent) -> Option<T>,
) -> Option<T> {
    events.iter().find_map(pick)
}

#[tokio::test]
async fn open_announces_the_session_id_it_was_launched_with() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    let opened = runtime.open(spec("thread-open", "plain.json")).await.expect("open");

    // The fake echoes back whatever came in on `--session-id`, so this asserts
    // the flag reached the child and that the driver read the init frame.
    assert_eq!(opened.native_session_id.as_deref(), Some("thread-open"));
    assert!(opened.pid.is_some(), "a spawned child must carry the pid we captured");

    let events = recorder.events();
    let started = find(&events, |event| match event {
        PilotEvent::SessionStarted { native_session_id, model, slash_commands, .. } => {
            Some((native_session_id.clone(), model.clone(), slash_commands.clone()))
        }
        _ => None,
    })
    .expect("session.started");
    assert_eq!(started.0.as_deref(), Some("thread-open"));
    assert_eq!(started.1.as_deref(), Some("claude-fable-5-1"));
    assert!(started.2.contains(&"review".to_string()));
    assert_eq!(runtime.status("thread-open"), Some(Status::Idle));

    runtime.stop("thread-open").await.expect("stop");
}

#[tokio::test]
async fn a_prompt_streams_deltas_then_completes_the_turn_with_usage() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("thread-turn", "plain.json")).await.expect("open");

    let turn = runtime.prompt("thread-turn", TurnInput::text("hi")).await.expect("prompt");
    until(&recorder, "turn.completed", has("turn.completed")).await;

    let events = recorder.events();
    let deltas: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            PilotEvent::ItemDelta { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, vec!["o", "k"], "one delta per chunk, never one per item");

    // The order is the contract: a delta belongs to an item that was started.
    let started_at = events.iter().position(|e| e.kind() == "item.started").expect("item.started");
    let first_delta = events.iter().position(|e| e.kind() == "item.delta").expect("item.delta");
    let completed_at =
        events.iter().position(|e| e.kind() == "item.completed").expect("item.completed");
    let turn_at = events.iter().position(|e| e.kind() == "turn.completed").expect("turn.completed");
    assert!(started_at < first_delta && first_delta < completed_at && completed_at < turn_at);

    let (turn_id, duration, usage) = find(&events, |event| match event {
        PilotEvent::TurnCompleted { turn_id, duration_ms, usage } => {
            Some((turn_id.clone(), *duration_ms, usage.clone()))
        }
        _ => None,
    })
    .expect("turn.completed");
    assert_eq!(turn_id, turn, "the completion names the turn prompt() minted");
    assert_eq!(duration, 42);
    assert_eq!(usage.input_tokens, 7);
    assert_eq!(usage.output_tokens, 4);
    assert_eq!(usage.context_window, Some(200_000));
    assert_eq!(runtime.status("thread-turn"), Some(Status::Idle));

    runtime.stop("thread-turn").await.expect("stop");
}

#[tokio::test]
async fn an_approved_request_carries_the_turn_to_its_end() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("thread-allow", "approval.json")).await.expect("open");
    runtime.prompt("thread-allow", TurnInput::text("run it")).await.expect("prompt");

    until(&recorder, "request.opened", has("request.opened")).await;
    assert_eq!(
        runtime.status("thread-allow"),
        Some(Status::Waiting),
        "an open request outranks the turn in flight"
    );

    let request = find(&recorder.events(), |event| match event {
        PilotEvent::RequestOpened { request } => Some(request.clone()),
        _ => None,
    })
    .expect("request.opened");
    assert_eq!(request.tool_name.as_deref(), Some("Bash"));
    assert_eq!(request.input["command"], "git status");
    assert!(request.tool_use_id.is_some(), "the tool_use it gates");
    let options: Vec<&str> = request.options.iter().map(|o| o.value.as_str()).collect();
    assert_eq!(options, vec!["allow", "allow_always", "deny"]);

    runtime.respond("thread-allow", &request.id, RequestAnswer::allow()).await.expect("respond");
    until(&recorder, "turn.completed", has("turn.completed")).await;

    let events = recorder.events();
    let resolved = find(&events, |event| match event {
        PilotEvent::RequestResolved { request_id, outcome } => {
            Some((request_id.clone(), *outcome))
        }
        _ => None,
    })
    .expect("request.resolved");
    assert_eq!(resolved.0, request.id);
    assert_eq!(resolved.1, boite_pilot::RequestOutcome::Allowed);
    // The tool call is completed by the tool_result the child sent back.
    assert!(events.iter().any(|event| matches!(
        event,
        PilotEvent::ItemCompleted { item } if item.kind == boite_pilot::ItemKind::ToolCall
    )));

    runtime.stop("thread-allow").await.expect("stop");
}

#[tokio::test]
async fn a_denied_request_still_ends_the_turn() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("thread-deny", "approval.json")).await.expect("open");
    runtime.prompt("thread-deny", TurnInput::text("run it")).await.expect("prompt");
    until(&recorder, "request.opened", has("request.opened")).await;

    let request_id = find(&recorder.events(), |event| match event {
        PilotEvent::RequestOpened { request } => Some(request.id.clone()),
        _ => None,
    })
    .expect("request.opened");
    runtime
        .respond("thread-deny", &request_id, RequestAnswer::deny("not this one"))
        .await
        .expect("respond");
    until(&recorder, "turn.completed", has("turn.completed")).await;

    let events = recorder.events();
    assert!(events.iter().any(|event| matches!(
        event,
        PilotEvent::RequestResolved { outcome, .. } if *outcome == boite_pilot::RequestOutcome::Denied
    )));
    // The denial reaches the model as the tool's error result.
    let tool_result = find(&events, |event| match event {
        PilotEvent::ItemCompleted { item } if item.kind == boite_pilot::ItemKind::ToolCall => {
            Some(item.body.clone())
        }
        _ => None,
    })
    .expect("tool_call completed");
    assert_eq!(tool_result["is_error"], true);
    assert_eq!(tool_result["content"], "not this one");

    // Answering a request twice is a bug in the caller, not a second frame.
    let again = runtime.respond("thread-deny", &request_id, RequestAnswer::allow()).await;
    assert!(matches!(again, Err(boite_pilot::PilotError::NoRequest(_))));

    runtime.stop("thread-deny").await.expect("stop");
}

#[tokio::test]
async fn an_interrupt_aborts_the_turn_it_stopped() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("thread-stop-turn", "hang.json")).await.expect("open");
    let turn = runtime.prompt("thread-stop-turn", TurnInput::text("go")).await.expect("prompt");
    until(&recorder, "item.completed", has("item.completed")).await;
    // The scenario never ends this turn, so the status is stable to read.
    assert_eq!(runtime.status("thread-stop-turn"), Some(Status::Busy));

    runtime.interrupt("thread-stop-turn").await.expect("interrupt");

    let events = recorder.events();
    let aborted = find(&events, |event| match event {
        PilotEvent::TurnAborted { turn_id, reason } => Some((turn_id.clone(), reason.clone())),
        _ => None,
    })
    .expect("turn.aborted");
    assert_eq!(aborted.0, turn);
    assert_eq!(aborted.1.as_deref(), Some("interrupted"));
    assert!(!events.iter().any(|event| event.kind() == "turn.completed"));
    assert_eq!(runtime.status("thread-stop-turn"), Some(Status::Idle));

    runtime.stop("thread-stop-turn").await.expect("stop");
}

#[tokio::test]
async fn setting_a_model_answers_in_session() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("thread-model", "plain.json")).await.expect("open");

    let kind = runtime
        .set_model("thread-model", ModelSelection::model("claude-sonnet-4-6"))
        .await
        .expect("set_model");
    assert_eq!(kind, boite_pilot::SwitchKind::InSession);
    let model = find(&recorder.events(), |event| match event {
        PilotEvent::ModelChanged { model } => Some(model.clone()),
        _ => None,
    })
    .expect("model.changed");
    assert_eq!(model, "claude-sonnet-4-6");

    // Another account is another process: the credentials are read at launch.
    let other = runtime
        .set_model(
            "thread-model",
            ModelSelection {
                model: Some("claude-opus-5".into()),
                instance: Some(boite_pilot::Instance::Native {
                    config_dir: Some(PathBuf::from("C:/accounts/b")),
                }),
            },
        )
        .await
        .expect("set_model");
    assert_eq!(other, boite_pilot::SwitchKind::Restart);

    runtime.set_mode("thread-model", boite_pilot::ExecMode::Yolo).await.expect("set_mode");
    runtime.stop("thread-model").await.expect("stop");
}

#[tokio::test]
async fn stopping_ends_the_process_and_says_so() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("thread-exit", "plain.json")).await.expect("open");

    runtime.stop("thread-exit").await.expect("stop");
    until(&recorder, "session.exited", has("session.exited")).await;

    let reason = find(&recorder.events(), |event| match event {
        PilotEvent::SessionExited { reason } => Some(reason.clone()),
        _ => None,
    })
    .expect("session.exited");
    assert_eq!(reason, ExitReason::Stopped, "a polite stop is not a crash");
    assert_eq!(runtime.status("thread-exit"), None);
}

#[tokio::test]
async fn a_resume_reopens_the_conversation_the_id_names() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    let mut spec = spec("thread-resume", "plain.json");
    spec.resume = Some("native-abc".to_string());
    let opened = runtime.open(spec).await.expect("open");

    // The fake reports `--resume`'s value as its session id, which it can only
    // do if the flag arrived and `--session-id` did not (the CLI refuses both).
    assert_eq!(opened.native_session_id.as_deref(), Some("native-abc"));
    runtime.stop("thread-resume").await.expect("stop");
}

#[tokio::test]
async fn a_child_that_dies_mid_turn_aborts_before_it_exits() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.open(spec("thread-crash", "crash.json")).await.expect("open");
    runtime.prompt("thread-crash", TurnInput::text("go")).await.expect("prompt");

    until(&recorder, "session.exited", has("session.exited")).await;
    let kinds = recorder.kinds();
    let aborted = kinds.iter().position(|k| *k == "turn.aborted").expect("turn.aborted");
    let exited = kinds.iter().position(|k| *k == "session.exited").expect("session.exited");
    assert!(aborted < exited, "the timeline must not be left mid-turn");
    assert!(!kinds.contains(&"turn.completed"));

    let reason = find(&recorder.events(), |event| match event {
        PilotEvent::SessionExited { reason } => Some(reason.clone()),
        _ => None,
    })
    .expect("session.exited");
    assert!(matches!(reason, ExitReason::Crashed { .. }), "nobody asked it to leave");
}

#[tokio::test]
async fn the_scripted_driver_replays_the_same_scenario_file() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    let scenario = Scenario::read(&scenario_path("plain.json")).expect("scenario");
    runtime.register(Arc::new(ScriptedDriver::with_scenario(scenario)));

    let mut spec = spec("thread-scripted", "plain.json");
    spec.driver = "scripted".to_string();
    spec.bin.clear();
    let opened = runtime.open(spec).await.expect("open");
    assert_eq!(
        opened.native_session_id.as_deref(),
        Some("11111111-2222-3333-4444-555555555555")
    );

    runtime.prompt("thread-scripted", TurnInput::text("hi")).await.expect("prompt");
    let kinds = recorder.kinds();
    assert_eq!(
        kinds,
        vec![
            "session.started",
            "turn.started",
            "status.changed",
            "item.started",
            "item.delta",
            "item.delta",
            "item.completed",
            "turn.completed",
            "usage.updated",
            "status.changed",
        ]
    );

    // Its scenario is spent, so a second prompt says so rather than replaying.
    let again = runtime.prompt("thread-scripted", TurnInput::text("hi")).await;
    assert!(matches!(again, Err(boite_pilot::PilotError::Protocol(_))));
    runtime.stop("thread-scripted").await.expect("stop");
}

#[tokio::test]
async fn a_scripted_request_waits_for_its_answer() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    let scenario = Scenario::read(&scenario_path("approval.json")).expect("scenario");
    runtime.register(Arc::new(ScriptedDriver::with_scenario(scenario)));

    let mut spec = spec("thread-scripted-req", "approval.json");
    spec.driver = "scripted".to_string();
    spec.bin.clear();
    runtime.open(spec).await.expect("open");
    runtime.prompt("thread-scripted-req", TurnInput::text("run it")).await.expect("prompt");
    assert_eq!(runtime.status("thread-scripted-req"), Some(Status::Waiting));

    let request_id = find(&recorder.events(), |event| match event {
        PilotEvent::RequestOpened { request } => Some(request.id.clone()),
        _ => None,
    })
    .expect("request.opened");
    runtime
        .respond("thread-scripted-req", &request_id, RequestAnswer::allow())
        .await
        .expect("respond");
    assert!(recorder.kinds().contains(&"turn.completed"));
    assert_eq!(runtime.status("thread-scripted-req"), Some(Status::Idle));
}

#[tokio::test]
async fn a_scripted_step_can_end_the_session_the_way_a_crash_does() {
    let recorder = Recorder::new();
    let runtime = Runtime::new(recorder.clone());
    runtime.register(Arc::new(ScriptedDriver::with_scenario(Scenario {
        steps: vec![Step { deltas: vec!["x".into()], exit: true, ..Default::default() }],
        ..Default::default()
    })));

    let mut spec = spec("thread-scripted-exit", "plain.json");
    spec.driver = "scripted".to_string();
    spec.bin.clear();
    runtime.open(spec).await.expect("open");
    runtime.prompt("thread-scripted-exit", TurnInput::text("x")).await.expect("prompt");
    assert!(recorder.kinds().contains(&"session.exited"));

    let error = runtime.prompt("thread-scripted-exit", TurnInput::text("x")).await;
    assert!(matches!(error, Err(boite_pilot::PilotError::SessionGone(_))));
}

#[tokio::test]
async fn a_fastpick_route_builds_the_launcher_line_the_harness_sits_behind() {
    let mut spec = spec("thread-fastpick", "plain.json");
    spec.bin = vec!["claude".to_string()];
    spec.model = Some("glm-5".to_string());
    spec.instance =
        boite_pilot::Instance::Fastpick { provider: "openrouter".into(), model: "glm-5".into() };

    let argv = boite_pilot::claude::claude_argv(&spec);
    assert_eq!(
        argv,
        vec![
            "fastpick",
            "--harness",
            "claude",
            "--provider",
            "openrouter",
            "--model",
            "glm-5",
            "--",
            "claude",
            "--print",
            "--verbose",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--permission-prompt-tool",
            "stdio",
            "--include-partial-messages",
            "--session-id=thread-fastpick",
            "--model",
            "glm-5",
            "--permission-mode",
            "default",
        ]
    );
}
