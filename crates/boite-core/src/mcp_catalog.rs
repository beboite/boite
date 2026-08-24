//! MCP servers available on the machine that launches an agent.
//!
//! Codex's global config is the catalogue because it already describes both
//! stdio and HTTP servers without Boite inventing a second registry. Only names
//! and capabilities cross the command bus. Definitions stay on the host, and a
//! definition carrying inline environment values, headers or obvious secret
//! arguments is never copied into a generated Claude config.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Map, Value as JsonValue};
use toml::Value as TomlValue;

pub const BOITE_MCP_ID: &str = "boite";
const CODEX_PREFIX: &str = "codex:";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub id: String,
    pub name: String,
    pub source: String,
    pub transport: String,
    pub enabled: bool,
    pub claude_compatible: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct DiscoveredMcp {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: String,
    pub claude: Option<JsonValue>,
}

/// Names only. Configuration values never leave this module.
pub fn catalog() -> Result<Vec<McpServerSummary>, String> {
    let mut rows = vec![McpServerSummary {
        id: BOITE_MCP_ID.into(),
        name: "Boite".into(),
        source: "boite".into(),
        transport: "stdio".into(),
        enabled: true,
        claude_compatible: true,
    }];
    for server in discover()? {
        // A globally registered Boite entry is represented by the built-in row.
        if server.name == BOITE_MCP_ID {
            continue;
        }
        rows.push(McpServerSummary {
            id: server.id,
            name: server.name,
            source: "codex".into(),
            transport: server.transport,
            enabled: server.enabled,
            claude_compatible: server.claude.is_some(),
        });
    }
    Ok(rows)
}

pub(crate) fn discover() -> Result<Vec<DiscoveredMcp>, String> {
    let path = codex_config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read Codex MCP config: {e}")),
    };
    discover_from(&raw)
}

fn codex_config_path() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
        .join("config.toml")
}

fn discover_from(raw: &str) -> Result<Vec<DiscoveredMcp>, String> {
    let root: TomlValue = toml::from_str(raw).map_err(|e| format!("parse Codex MCP config: {e}"))?;
    let Some(servers) = root.get("mcp_servers").and_then(TomlValue::as_table) else {
        return Ok(Vec::new());
    };

    let mut found = Vec::with_capacity(servers.len());
    for (name, value) in servers {
        let Some(table) = value.as_table() else {
            continue;
        };
        let enabled = table
            .get("enabled")
            .and_then(TomlValue::as_bool)
            .unwrap_or(true);
        found.push(DiscoveredMcp {
            id: if name == BOITE_MCP_ID {
                BOITE_MCP_ID.into()
            } else {
                format!("{CODEX_PREFIX}{name}")
            },
            name: name.clone(),
            enabled,
            transport: if table.contains_key("url") {
                "http".into()
            } else {
                "stdio".into()
            },
            claude: claude_definition(table),
        });
    }
    Ok(found)
}

fn claude_definition(table: &toml::map::Map<String, TomlValue>) -> Option<JsonValue> {
    // These values may be credentials themselves. Environment-variable names
    // are safe, but Claude and Codex do not share one schema for them, so the
    // whole definition stays Codex-only instead of being translated loosely.
    if [
        "env",
        "http_headers",
        "headers",
        "env_http_headers",
        "bearer_token_env_var",
    ]
        .iter()
        .any(|key| table.contains_key(*key))
    {
        return None;
    }

    if let Some(url) = table.get("url").and_then(TomlValue::as_str) {
        let parsed = url::Url::parse(url).ok()?;
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return None;
        }
        return Some(json!({ "type": "http", "url": url }));
    }

    let command = table.get("command").and_then(TomlValue::as_str)?;
    let args: Vec<String> = match table.get("args") {
        Some(value) => value
            .as_array()?
            .iter()
            .map(TomlValue::as_str)
            .collect::<Option<Vec<_>>>()?
            .into_iter()
            .map(str::to_owned)
            .collect(),
        None => Vec::new(),
    };
    if arguments_carry_secret(&args) {
        return None;
    }
    Some(json!({ "command": command, "args": args }))
}

fn arguments_carry_secret(args: &[String]) -> bool {
    const SECRET_WORDS: [&str; 6] = ["token", "password", "passwd", "secret", "api-key", "apikey"];
    args.iter().enumerate().any(|(index, arg)| {
        let lower = arg.to_ascii_lowercase();
        let names_secret = SECRET_WORDS.iter().any(|word| lower.contains(word));
        if !names_secret {
            return false;
        }
        lower.contains('=') || (lower.starts_with('-') && args.get(index + 1).is_some())
    })
}

pub(crate) fn claude_servers(selected_ids: &[String]) -> Result<Map<String, JsonValue>, String> {
    if !selected_ids.iter().any(|id| id.starts_with(CODEX_PREFIX)) {
        return Ok(Map::new());
    }
    let selected: BTreeSet<&str> = selected_ids.iter().map(String::as_str).collect();
    let mut servers = Map::new();
    for server in discover()? {
        if server.name == BOITE_MCP_ID || !selected.contains(server.id.as_str()) {
            continue;
        }
        if let Some(definition) = server.claude {
            servers.insert(server.name, definition);
        }
    }
    Ok(servers)
}

/// One explicit enabled/disabled answer for every global Codex server.
pub(crate) fn codex_selection_flags(selected_ids: &[String]) -> Result<Vec<String>, String> {
    let mut by_name = BTreeMap::new();
    for server in discover()? {
        by_name.insert(server.name, server.id);
    }

    Ok(codex_selection_flags_for(by_name, selected_ids))
}

fn codex_selection_flags_for(
    by_name: BTreeMap<String, String>,
    selected_ids: &[String],
) -> Vec<String> {
    let selected: BTreeSet<&str> = selected_ids.iter().map(String::as_str).collect();
    let mut flags = Vec::with_capacity(by_name.len() * 2);
    for (name, id) in by_name {
        flags.push("-c".into());
        flags.push(format!(
            "mcp_servers.{}.enabled={}",
            toml_key(&name),
            selected.contains(id.as_str())
        ));
    }
    flags
}

fn toml_key(name: &str) -> String {
    if !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        name.into()
    } else {
        serde_json::to_string(name).unwrap_or_else(|_| "\"invalid\"".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_exposes_names_without_values() {
        let rows = discover_from(
            r#"
                [mcp_servers.unityMCP]
                url = "http://127.0.0.1:8080/mcp"

                [mcp_servers.ssh]
                command = "fast-mcp-ssh"
            "#,
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "codex:ssh");
        assert_eq!(rows[1].id, "codex:unityMCP");
        assert!(rows.iter().all(|row| row.claude.is_some()));
    }

    #[test]
    fn inline_credentials_are_never_translated_to_claude() {
        let rows = discover_from(
            r#"
                [mcp_servers.with_env]
                command = "server"
                env = { ACCESS_TOKEN = "not-copied" }

                [mcp_servers.with_arg]
                command = "server"
                args = ["--api-key", "not-copied"]

                [mcp_servers.with_url]
                url = "https://user:password@example.com/mcp"

                [mcp_servers.with_bearer]
                url = "https://example.com/mcp"
                bearer_token_env_var = "MCP_TOKEN"
            "#,
        )
        .unwrap();
        assert!(rows.iter().all(|row| row.claude.is_none()));
    }

    #[test]
    fn unusual_names_are_quoted_in_overrides() {
        assert_eq!(toml_key("unityMCP"), "unityMCP");
        assert_eq!(toml_key("unity local"), "\"unity local\"");
    }

    #[test]
    fn codex_gets_one_explicit_answer_for_every_global_server() {
        let servers = BTreeMap::from([
            ("ssh".into(), "codex:ssh".into()),
            ("unityMCP".into(), "codex:unityMCP".into()),
        ]);
        let flags = codex_selection_flags_for(servers, &["codex:unityMCP".into()]);
        assert_eq!(
            flags,
            [
                "-c",
                "mcp_servers.ssh.enabled=false",
                "-c",
                "mcp_servers.unityMCP.enabled=true",
            ]
        );
    }
}
