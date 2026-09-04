use std::collections::{BTreeMap, HashSet};

use serde_json::{json, Value};

use crate::driver::{ExecMode, Instance, OpenSpec};
use crate::proc::{argv_for_instance, resolve_bin};

pub const MINIMUM_VERSION: &str = "1.14.19";
pub const READY_PREFIX: &str = "opencode server listening";

pub fn server_url(spec: &OpenSpec) -> Option<String> {
    spec.env
        .get("OPENCODE_SERVER_URL")
        .cloned()
        .or_else(|| std::env::var("OPENCODE_SERVER_URL").ok())
        .filter(|value| !value.trim().is_empty())
}

pub fn server_password(spec: &OpenSpec, external: bool) -> Option<String> {
    let explicit = spec.env.get("OPENCODE_SERVER_PASSWORD").cloned();
    if external {
        return explicit.filter(|value| !value.is_empty());
    }
    explicit
        .or_else(|| std::env::var("OPENCODE_SERVER_PASSWORD").ok())
        .filter(|value| !value.is_empty())
}

pub fn server_env(spec: &OpenSpec) -> BTreeMap<String, String> {
    let mut env = spec.env.clone();
    if !env.contains_key("OPENCODE_CONFIG_CONTENT")
        && std::env::var_os("OPENCODE_CONFIG_CONTENT").is_none()
    {
        env.insert("OPENCODE_CONFIG_CONTENT".into(), "{}".into());
    }
    env.remove("OPENCODE_SERVER_URL");
    env
}

pub fn server_argv(spec: &OpenSpec, port: u16) -> Vec<String> {
    let mut inner = resolve_bin(&spec.bin, "BOITE_PILOT_OPENCODE_BIN", "opencode");
    inner.extend([
        "serve".to_string(),
        "--hostname=127.0.0.1".to_string(),
        format!("--port={port}"),
    ]);
    argv_for_instance("opencode", &spec.instance, inner)
}

pub fn parse_ready_url(line: &str) -> Option<String> {
    let line = line.trim();
    if !line.starts_with(READY_PREFIX) {
        return None;
    }
    let marker = " on ";
    let url = line.split_once(marker)?.1.trim();
    (url.starts_with("http://") || url.starts_with("https://")).then(|| url.to_string())
}

pub fn version_at_least(actual: &str, minimum: &str) -> bool {
    fn parts(value: &str) -> Option<[u64; 3]> {
        let core = value.trim().trim_start_matches('v').split('-').next()?;
        let values = core
            .split('.')
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        (values.len() >= 3).then(|| [values[0], values[1], values[2]])
    }
    matches!((parts(actual), parts(minimum)), (Some(actual), Some(minimum)) if actual >= minimum)
}

pub fn permission_rules(mode: ExecMode) -> Value {
    if mode == ExecMode::Yolo {
        return json!([
            { "permission": "*", "pattern": "*", "action": "allow" },
            { "permission": "external_directory", "pattern": "*", "action": "allow" }
        ]);
    }
    let edit = if mode == ExecMode::EditAlone {
        "allow"
    } else {
        "ask"
    };
    json!([
        { "permission": "*", "pattern": "*", "action": "ask" },
        { "permission": "read", "pattern": "*", "action": "allow" },
        { "permission": "read", "pattern": "*.env", "action": "ask" },
        { "permission": "read", "pattern": "*.env.*", "action": "ask" },
        { "permission": "read", "pattern": "*.env.example", "action": "allow" },
        { "permission": "glob", "pattern": "*", "action": "allow" },
        { "permission": "grep", "pattern": "*", "action": "allow" },
        { "permission": "lsp", "pattern": "*", "action": "allow" },
        { "permission": "skill", "pattern": "*", "action": "allow" },
        { "permission": "todowrite", "pattern": "*", "action": "allow" },
        { "permission": "bash", "pattern": "*", "action": "ask" },
        { "permission": "edit", "pattern": "*", "action": edit },
        { "permission": "webfetch", "pattern": "*", "action": "ask" },
        { "permission": "websearch", "pattern": "*", "action": "ask" },
        { "permission": "codesearch", "pattern": "*", "action": "ask" },
        { "permission": "external_directory", "pattern": "*", "action": "ask" },
        { "permission": "doom_loop", "pattern": "*", "action": "ask" },
        { "permission": "question", "pattern": "*", "action": "allow" }
    ])
}

pub fn parse_model(model: &str) -> Option<(&str, &str)> {
    let (provider, model) = model.trim().split_once('/')?;
    (!provider.is_empty() && !model.is_empty()).then_some((provider, model))
}

pub fn available_models(provider_list: &Value) -> Vec<String> {
    let connected: HashSet<&str> = provider_list["connected"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut models = provider_list["all"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|provider| {
            provider["id"]
                .as_str()
                .is_some_and(|id| connected.contains(id))
        })
        .flat_map(|provider| {
            let provider_id = provider["id"].as_str().unwrap_or_default();
            provider["models"]
                .as_object()
                .into_iter()
                .flat_map(move |models| {
                    models.values().filter_map(move |model| {
                        let id = model["id"].as_str()?;
                        Some(format!("{provider_id}/{id}"))
                    })
                })
        })
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models
}

pub fn default_model(provider_list: &Value, models: &[String]) -> Option<String> {
    let connected = provider_list["connected"].as_array()?;
    for provider in connected.iter().filter_map(Value::as_str) {
        if let Some(model) = provider_list["default"][provider].as_str() {
            let slug = if model.starts_with(&format!("{provider}/")) {
                model.to_string()
            } else {
                format!("{provider}/{model}")
            };
            if models.contains(&slug) {
                return Some(slug);
            }
        }
    }
    models.first().cloned()
}

pub fn mcp_body(server: &crate::driver::McpServer, cwd: &std::path::Path) -> Value {
    let command = std::iter::once(server.command.clone())
        .chain(server.args.iter().cloned())
        .collect::<Vec<_>>();
    json!({
        "name": server.name,
        "config": {
            "type": "local",
            "command": command,
            "cwd": cwd,
            "environment": server.env,
            "enabled": true
        }
    })
}

pub fn instance_model(spec: &OpenSpec) -> Option<String> {
    match &spec.instance {
        Instance::Fastpick {
            provider, model, ..
        } if parse_model(model).is_none() => Some(format!("{provider}/{model}")),
        _ => spec.model.clone(),
    }
}
