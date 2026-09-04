use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::json;

use super::protocol::{codex_argv, is_recoverable_resume_error, mode_config, turn_params};
use crate::{ExecMode, Instance, McpServer, OpenSpec};

fn spec() -> OpenSpec {
    OpenSpec {
        thread_id: "thread-codex".into(),
        cwd: PathBuf::from("C:/work"),
        driver: "codex".into(),
        bin: vec!["codex-test".into()],
        ..Default::default()
    }
}

#[test]
fn launch_uses_app_server_and_keeps_mcp_arguments_behind_fastpick() {
    let mut spec = spec();
    spec.instance = Instance::Fastpick {
        provider: "openrouter".into(),
        model: "glm-5".into(),
    };
    spec.mcp_servers.push(McpServer {
        name: "boite".into(),
        command: "boite-mcp".into(),
        args: vec!["--thread".into(), "thread-codex".into()],
        env: BTreeMap::from([("BOITE_TOKEN".into(), "secret-name".into())]),
    });

    let argv = codex_argv(&spec);
    assert_eq!(
        &argv[..8],
        [
            "fastpick",
            "--harness",
            "codex",
            "--provider",
            "openrouter",
            "--model",
            "glm-5",
            "--",
        ]
    );
    let separator = argv.iter().position(|arg| arg == "--").expect("separator");
    assert_eq!(argv[separator + 1], "codex-test");
    assert_eq!(argv[separator + 2], "app-server");
    assert!(argv
        .iter()
        .any(|arg| arg == "mcp_servers.\"boite\".command=\"boite-mcp\""));
    assert!(argv
        .iter()
        .any(|arg| arg == "mcp_servers.\"boite\".env.\"BOITE_TOKEN\"=\"secret-name\""));
}

#[test]
fn modes_match_the_t3_app_server_policy() {
    let ask = mode_config(ExecMode::Ask);
    assert_eq!(ask.approval_policy, "untrusted");
    assert_eq!(ask.sandbox, "read-only");

    let edit = mode_config(ExecMode::EditAlone);
    assert_eq!(edit.approval_policy, "on-request");
    assert_eq!(edit.sandbox, "workspace-write");

    let yolo = mode_config(ExecMode::Yolo);
    assert_eq!(yolo.approval_policy, "never");
    assert_eq!(yolo.sandbox, "danger-full-access");
}

#[test]
fn a_turn_carries_model_effort_and_permission_mode() {
    let params = turn_params(
        "native-thread",
        "do it",
        Some("gpt-test"),
        Some("high"),
        ExecMode::EditAlone,
    );
    assert_eq!(params["threadId"], "native-thread");
    assert_eq!(
        params["input"],
        json!([{ "type": "text", "text": "do it" }])
    );
    assert_eq!(params["model"], "gpt-test");
    assert_eq!(params["effort"], "high");
    assert_eq!(params["sandboxPolicy"]["type"], "workspaceWrite");
}

#[test]
fn only_missing_thread_resume_errors_fall_back_to_a_fresh_thread() {
    assert!(is_recoverable_resume_error("thread not found"));
    assert!(is_recoverable_resume_error(
        "no rollout found for thread abc"
    ));
    assert!(!is_recoverable_resume_error("authentication failed"));
}
