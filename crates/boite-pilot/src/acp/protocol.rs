//! ACP launch particulars and wire payloads.
//!
//! Cursor, Grok and Antigravity share ACP 1 over JSONL. Only their executable,
//! authentication method, resume method and permission flags differ. These
//! mappings follow the T3 Code adapters pinned for this port.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::driver::{ExecMode, McpServer, OpenSpec};
use crate::proc::{argv_for_instance, resolve_bin};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Cursor,
    Grok,
    Antigravity,
}

impl Flavor {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Cursor => "acp:cursor",
            Self::Grok => "acp:grok",
            Self::Antigravity => "acp:antigravity",
        }
    }

    pub const fn harness(self) -> &'static str {
        match self {
            Self::Cursor => "cursor",
            Self::Grok => "grok",
            Self::Antigravity => "antigravity",
        }
    }

    const fn bin_env(self) -> &'static str {
        match self {
            Self::Cursor => "BOITE_PILOT_CURSOR_BIN",
            Self::Grok => "BOITE_PILOT_GROK_BIN",
            Self::Antigravity => "BOITE_PILOT_ANTIGRAVITY_BIN",
        }
    }

    const fn default_bin(self) -> &'static str {
        match self {
            Self::Cursor => "cursor-agent",
            Self::Grok => "grok",
            Self::Antigravity => "agy-acp-server",
        }
    }

    pub const fn auth_method(self, has_xai_key: bool) -> &'static str {
        match self {
            Self::Cursor => "cursor_login",
            Self::Grok if has_xai_key => "xai.api_key",
            Self::Grok => "cached_token",
            Self::Antigravity => "oauth-personal",
        }
    }

    pub const fn resume_method(self) -> &'static str {
        match self {
            Self::Antigravity => "session/resume",
            Self::Cursor | Self::Grok => "session/load",
        }
    }

    pub const fn uses_session_model(self) -> bool {
        matches!(self, Self::Grok)
    }

    pub const fn mode_id(self, mode: ExecMode) -> &'static str {
        match (self, mode) {
            (Self::Grok, ExecMode::EditAlone) => "acceptEdits",
            (Self::Antigravity, ExecMode::EditAlone) => "auto_edit",
            (_, ExecMode::Yolo) => "yolo",
            (_, ExecMode::Ask | ExecMode::EditAlone) => "default",
        }
    }
}

pub fn argv(flavor: Flavor, spec: &OpenSpec) -> Vec<String> {
    let mut inner = resolve_bin(&spec.bin, flavor.bin_env(), flavor.default_bin());
    match flavor {
        Flavor::Cursor => {
            match spec.options.mode {
                ExecMode::Yolo => inner.push("--force".into()),
                // T3 leaves Cursor supervised for auto-accept-edits because
                // Cursor has no native edits-only launch flag.
                ExecMode::Ask | ExecMode::EditAlone => {}
            }
            inner.push("acp".into());
        }
        Flavor::Grok => match spec.options.mode {
            ExecMode::Ask => {
                inner.extend(strings(["--permission-mode", "default", "agent", "stdio"]))
            }
            ExecMode::EditAlone => inner.extend(strings([
                "--permission-mode",
                "acceptEdits",
                "agent",
                "stdio",
            ])),
            ExecMode::Yolo => inner.extend(strings(["agent", "--always-approve", "stdio"])),
        },
        Flavor::Antigravity => {
            // The managed T3 package is the ACP server itself. Its harness and
            // profile are supplied through environment variables, not argv.
        }
    }
    argv_for_instance(flavor.harness(), &spec.instance, inner)
}

fn strings<const N: usize>(values: [&str; N]) -> Vec<String> {
    values.into_iter().map(str::to_string).collect()
}

pub fn env(flavor: Flavor, spec: &OpenSpec) -> BTreeMap<String, String> {
    let mut env = spec.env.clone();
    if flavor == Flavor::Grok {
        env.insert("GROK_OAUTH2_REFERRER".into(), "t3code".into());
    }
    env
}

pub fn has_xai_key(spec: &OpenSpec) -> bool {
    spec.env
        .get("XAI_API_KEY")
        .is_some_and(|value| !value.trim().is_empty())
        || std::env::var("XAI_API_KEY").is_ok_and(|value| !value.trim().is_empty())
}

pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false,
        },
        "clientInfo": {
            "name": "boite",
            "title": "Boite",
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

pub fn session_params(spec: &OpenSpec) -> Value {
    json!({
        "cwd": spec.cwd.to_string_lossy(),
        "mcpServers": spec.mcp_servers.iter().map(mcp_server).collect::<Vec<_>>(),
    })
}

fn mcp_server(server: &McpServer) -> Value {
    json!({
        "name": server.name,
        "command": server.command,
        "args": server.args,
        "env": server.env.iter().map(|(name, value)| json!({
            "name": name,
            "value": value,
        })).collect::<Vec<_>>(),
    })
}

pub fn prompt_params(session_id: &str, text: &str) -> Value {
    json!({
        "sessionId": session_id,
        "prompt": [{ "type": "text", "text": text }],
        "messageId": uuid::Uuid::new_v4().to_string(),
    })
}

pub fn id_key(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(format!("s:{value}")),
        Value::Number(value) => Some(format!("n:{value}")),
        _ => None,
    }
}

pub fn rpc_error(error: &Value) -> String {
    let message = error["message"].as_str().unwrap_or("ACP request failed");
    match error.get("data") {
        Some(data) if !data.is_null() => format!("{message}: {data}"),
        _ => message.to_string(),
    }
}

pub fn truncate(value: &str) -> String {
    value.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::{Instance, Options};
    use std::path::PathBuf;

    fn spec(mode: ExecMode) -> OpenSpec {
        OpenSpec {
            thread_id: "t".into(),
            cwd: PathBuf::from("/repo"),
            driver: "acp:grok".into(),
            instance: Instance::default(),
            options: Options { effort: None, mode },
            ..OpenSpec::default()
        }
    }

    #[test]
    fn launch_flags_match_t3_permission_modes() {
        assert_eq!(
            argv(Flavor::Cursor, &spec(ExecMode::Yolo)),
            ["cursor-agent", "--force", "acp"]
        );
        assert_eq!(
            argv(Flavor::Grok, &spec(ExecMode::EditAlone)),
            ["grok", "--permission-mode", "acceptEdits", "agent", "stdio"]
        );
        assert_eq!(
            argv(Flavor::Grok, &spec(ExecMode::Yolo)),
            ["grok", "agent", "--always-approve", "stdio"]
        );
    }

    #[test]
    fn mcp_environment_uses_acp_name_value_pairs() {
        let mut spec = spec(ExecMode::Ask);
        spec.mcp_servers.push(McpServer {
            name: "boite".into(),
            command: "boite-mcp".into(),
            args: vec!["--stdio".into()],
            env: BTreeMap::from([("BOITE_TOKEN".into(), "secret".into())]),
        });
        let value = session_params(&spec);
        assert_eq!(value["mcpServers"][0]["env"][0]["name"], "BOITE_TOKEN");
        assert_eq!(value["mcpServers"][0]["env"][0]["value"], "secret");
    }
}
