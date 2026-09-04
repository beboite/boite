//! Codex App Server launch arguments and JSON-RPC payloads.
//!
//! The shapes are deliberately small. App Server adds fields often, while the
//! handful written here are the stable inputs Boite needs. Incoming frames stay
//! as `serde_json::Value` and the reducer ignores fields it does not understand.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::driver::{ExecMode, McpServer, OpenSpec};
use crate::proc::{argv_for_instance, config_dir, resolve_bin};

pub const BIN_ENV: &str = "BOITE_PILOT_CODEX_BIN";

pub(super) struct ModeConfig {
    pub approval_policy: &'static str,
    pub sandbox: &'static str,
    pub approvals_reviewer: &'static str,
    pub sandbox_policy: Value,
}

/// The same four fields T3 Code sends on thread and turn creation.
///
/// `ask` makes every write or untrusted command cross the approval boundary;
/// `edit_alone` lets workspace edits through while escalations still ask.
pub(super) fn mode_config(mode: ExecMode) -> ModeConfig {
    match mode {
        ExecMode::Ask => ModeConfig {
            approval_policy: "untrusted",
            sandbox: "read-only",
            approvals_reviewer: "user",
            sandbox_policy: json!({ "type": "readOnly" }),
        },
        ExecMode::EditAlone => ModeConfig {
            approval_policy: "on-request",
            sandbox: "workspace-write",
            approvals_reviewer: "user",
            sandbox_policy: json!({ "type": "workspaceWrite" }),
        },
        ExecMode::Yolo => ModeConfig {
            approval_policy: "never",
            sandbox: "danger-full-access",
            approvals_reviewer: "user",
            sandbox_policy: json!({ "type": "dangerFullAccess" }),
        },
    }
}

/// The process line for one App Server session.
pub fn codex_argv(spec: &OpenSpec) -> Vec<String> {
    let mut inner = resolve_bin(&spec.bin, BIN_ENV, "codex");
    inner.push("app-server".to_string());
    for server in &spec.mcp_servers {
        append_mcp_config(&mut inner, server);
    }
    argv_for_instance("codex", &spec.instance, inner)
}

fn append_mcp_config(argv: &mut Vec<String>, server: &McpServer) {
    let root = format!("mcp_servers.{}", toml_key(&server.name));
    push_config(
        argv,
        format!("{root}.command={}", toml_string(&server.command)),
    );
    if !server.args.is_empty() {
        let args = serde_json::to_string(&server.args).unwrap_or_else(|_| "[]".to_string());
        push_config(argv, format!("{root}.args={args}"));
    }
    for (key, value) in &server.env {
        push_config(
            argv,
            format!("{root}.env.{}={}", toml_key(key), toml_string(value)),
        );
    }
}

fn push_config(argv: &mut Vec<String>, value: String) {
    argv.push("-c".to_string());
    argv.push(value);
}

fn toml_key(value: &str) -> String {
    // A JSON string uses the same quoted-key escapes needed by TOML for the
    // names Boite accepts, and argv bypasses a shell entirely.
    serde_json::to_string(value).unwrap_or_else(|_| "\"invalid\"".to_string())
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

pub(super) fn env_for(spec: &OpenSpec) -> BTreeMap<String, String> {
    let mut env = spec.env.clone();
    if let Some(directory) = config_dir(&spec.instance) {
        env.insert(
            "CODEX_HOME".to_string(),
            directory.to_string_lossy().to_string(),
        );
    }
    env
}

pub(super) fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "boite",
            "title": "Boite",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": {
            "experimentalApi": true,
        },
    })
}

pub(super) fn thread_params(spec: &OpenSpec) -> Value {
    let mode = mode_config(spec.options.mode);
    let mut params = Map::new();
    params.insert(
        "cwd".into(),
        Value::String(spec.cwd.to_string_lossy().to_string()),
    );
    params.insert(
        "approvalPolicy".into(),
        Value::String(mode.approval_policy.into()),
    );
    params.insert("sandbox".into(), Value::String(mode.sandbox.into()));
    params.insert(
        "approvalsReviewer".into(),
        Value::String(mode.approvals_reviewer.into()),
    );
    if let Some(model) = &spec.model {
        params.insert("model".into(), Value::String(model.clone()));
    }
    if let Some(instructions) = &spec.system_prompt_append {
        params.insert(
            "developerInstructions".into(),
            Value::String(instructions.clone()),
        );
    }
    Value::Object(params)
}

pub(super) fn turn_params(
    native_thread_id: &str,
    text: &str,
    model: Option<&str>,
    effort: Option<&str>,
    mode: ExecMode,
) -> Value {
    let config = mode_config(mode);
    let mut params = Map::new();
    params.insert(
        "threadId".into(),
        Value::String(native_thread_id.to_string()),
    );
    params.insert("input".into(), json!([{ "type": "text", "text": text }]));
    params.insert(
        "approvalPolicy".into(),
        Value::String(config.approval_policy.into()),
    );
    params.insert(
        "approvalsReviewer".into(),
        Value::String(config.approvals_reviewer.into()),
    );
    params.insert("sandboxPolicy".into(), config.sandbox_policy);
    if let Some(model) = model {
        params.insert("model".into(), Value::String(model.to_string()));
    }
    if let Some(effort) = effort {
        params.insert("effort".into(), Value::String(effort.to_string()));
    }
    Value::Object(params)
}

pub(super) fn is_recoverable_resume_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("thread")
        && [
            "not found",
            "missing thread",
            "no such thread",
            "unknown thread",
            "does not exist",
            "no rollout found",
        ]
        .iter()
        .any(|part| message.contains(part))
}

pub(super) fn id_key(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(format!("s:{value}")),
        Value::Number(value) => Some(format!("n:{value}")),
        _ => None,
    }
}

pub(super) fn truncate(value: &str) -> String {
    value.chars().take(300).collect()
}
