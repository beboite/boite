use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::json;

use super::protocol;
use crate::{ExecMode, Instance, McpServer, OpenSpec};

fn spec() -> OpenSpec {
    OpenSpec {
        thread_id: "thread-opencode".into(),
        cwd: PathBuf::from("C:/work"),
        driver: "opencode".into(),
        bin: vec!["opencode-test".into()],
        ..Default::default()
    }
}

#[test]
fn launch_uses_serve_and_keeps_fastpick_arguments_separate() {
    let mut spec = spec();
    spec.instance = Instance::Fastpick {
        provider: "crof".into(),
        model: "deepseek-v4".into(),
    };
    let argv = protocol::server_argv(&spec, 4321);
    assert_eq!(
        &argv[..8],
        [
            "fastpick",
            "--harness",
            "opencode",
            "--provider",
            "crof",
            "--model",
            "deepseek-v4",
            "--"
        ]
    );
    assert_eq!(
        &argv[8..],
        [
            "opencode-test",
            "serve",
            "--hostname=127.0.0.1",
            "--port=4321"
        ]
    );
}

#[test]
fn permission_modes_match_t3_open_code_rules() {
    let ask = protocol::permission_rules(ExecMode::Ask);
    let edit = protocol::permission_rules(ExecMode::EditAlone);
    let yolo = protocol::permission_rules(ExecMode::Yolo);
    let action = |rules: &serde_json::Value, permission: &str| {
        rules
            .as_array()
            .and_then(|rules| rules.iter().find(|rule| rule["permission"] == permission))
            .and_then(|rule| rule["action"].as_str())
            .unwrap()
            .to_string()
    };
    assert_eq!(action(&ask, "edit"), "ask");
    assert_eq!(action(&edit, "edit"), "allow");
    assert_eq!(action(&edit, "bash"), "ask");
    assert_eq!(
        yolo[0],
        json!({ "permission": "*", "pattern": "*", "action": "allow" })
    );
}

#[test]
fn provider_inventory_only_exposes_connected_models() {
    let list = json!({
        "connected": ["local"],
        "default": { "local": "main" },
        "all": [
            { "id": "local", "models": {
                "main": { "id": "main", "providerID": "local" },
                "other": { "id": "other", "providerID": "local" }
            }},
            { "id": "offline", "models": {
                "hidden": { "id": "hidden", "providerID": "offline" }
            }}
        ]
    });
    let models = protocol::available_models(&list);
    assert_eq!(models, ["local/main", "local/other"]);
    assert_eq!(
        protocol::default_model(&list, &models).as_deref(),
        Some("local/main")
    );
}

#[test]
fn mcp_config_keeps_argv_and_environment_structured() {
    let server = McpServer {
        name: "boite".into(),
        command: "boite-mcp".into(),
        args: vec!["--thread".into(), "thread-opencode".into()],
        env: BTreeMap::from([("BOITE_MCP_TOKEN".into(), "value".into())]),
    };
    let body = protocol::mcp_body(&server, std::path::Path::new("C:/work"));
    assert_eq!(body["config"]["command"][0], "boite-mcp");
    assert_eq!(body["config"]["command"][2], "thread-opencode");
    assert_eq!(body["config"]["environment"]["BOITE_MCP_TOKEN"], "value");
}

#[test]
fn version_gate_requires_t3s_minimum() {
    assert!(protocol::version_at_least(
        "1.14.19",
        protocol::MINIMUM_VERSION
    ));
    assert!(protocol::version_at_least(
        "v1.18.27",
        protocol::MINIMUM_VERSION
    ));
    assert!(!protocol::version_at_least(
        "1.14.18",
        protocol::MINIMUM_VERSION
    ));
    assert!(!protocol::version_at_least(
        "development",
        protocol::MINIMUM_VERSION
    ));
}
