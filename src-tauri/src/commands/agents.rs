//! Wiring an agent to Boite, which happens in config files rather than in code.
//!
//! Every agent reads a different file in a different place, and none of them
//! has an API for "add this server". So this reads what is there, says whether
//! Boite is already in it, and writes the line when asked.
//!
//! Nothing here grants anything. The credential an agent ends up holding is
//! minted at spawn (`crate::agent_api`), and a config file only ever names the
//! shim and the file to read it from.

use std::path::{Path, PathBuf};

use tauri::{
    AppHandle, Manager,
};





#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpConfig {
    /// Absolute path to the bundled shim.
    pub sidecar_path: String,
    /// Generated file to hand an agent that takes one at launch.
    pub config_path: String,
}

/// Prepares the MCP server definition agents are pointed at, and returns where
/// it lives.
///
/// A file rather than an inline JSON argument: Boite often launches through a
/// wrap shell, where arguments are re-quoted into a command line. That quoting
/// escapes `"` as `\"`, which POSIX shells accept and PowerShell does not — so
/// a JSON string would break on the platform this app targets first. A path
/// carries neither quotes nor braces and survives every shell.
///
/// Rewritten on every call rather than cached: the sidecar sits next to the
/// running binary, so its path moves with an update or a reinstall, and a stale
/// file would point an agent at a binary that is no longer there.
#[tauri::command]
pub async fn agent_mcp_config(app: AppHandle) -> Result<AgentMcpConfig, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "executable has no parent directory".to_string())?;
    let sidecar = dir.join(if cfg!(windows) {
        "boite-mcp.exe"
    } else {
        "boite-mcp"
    });
    if !sidecar.is_file() {
        // A dev build that never ran `bun run build:sidecar`. Say so plainly:
        // pointing an agent at a missing binary fails later and less clearly.
        return Err(format!("shim not found at {}", sidecar.display()));
    }

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&config_dir).map_err(|e| format!("create config dir: {e}"))?;
    let config_path = config_dir.join("mcp-boite.json");

    let body = serde_json::json!({
        "mcpServers": {
            "boite": { "command": sidecar.to_string_lossy() }
        }
    });
    std::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&body).map_err(|e| format!("serialize: {e}"))?,
    )
    .map_err(|e| format!("write mcp config: {e}"))?;

    Ok(AgentMcpConfig {
        sidecar_path: sidecar.to_string_lossy().into_owned(),
        config_path: config_path.to_string_lossy().into_owned(),
    })
}

/// Registers the shim with an agent that keeps its MCP servers in a config
/// file, by running that agent's own documented command.
///
/// Running their CLI rather than editing their files: `~/.codex/config.toml`,
/// `opencode.json` and `.cursor/mcp.json` are formats we would have to parse
/// and merge without breaking what is already there, and one of them lives in
/// the user's repository. The agent knows how to write its own config.
#[tauri::command]
pub async fn register_agent_mcp(cli: String, sidecar_path: String) -> Result<String, String> {
    // Allow-listed rather than free-form: this runs a process, and the caller
    // is a webview. Only these three expose an `mcp add` subcommand.
    let cli = match cli.as_str() {
        "codex" | "opencode" | "cursor-agent" | "grok" => cli,
        other => return Err(format!("no known mcp command for {other}")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new(&cli)
            .args(["mcp", "add", "boite", "--", &sidecar_path])
            .output()
            .map_err(|e| format!("could not run {cli}: {e}"))?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        // The agent's own words are more useful than ours: it knows whether the
        // name is taken, the config is unreadable, or the flag has moved on.
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("{cli} exited with {}", out.status)
        } else {
            err
        })
    })
    .await
    .map_err(|e| format!("register task failed: {e}"))?
}

/// Config files where each agent keeps its MCP servers, home-relative first and
/// then project-relative. Only agents Boite cannot wire at launch are listed:
/// claude and codex are handed everything on the command line and keep nothing.
fn agent_config_files(key: &str, home: &Path, cwd: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    match key {
        "copilot" => out.push(home.join(".copilot").join("mcp-config.json")),
        "cursor" => {
            out.push(home.join(".cursor").join("mcp.json"));
            if let Some(cwd) = cwd {
                out.push(cwd.join(".cursor").join("mcp.json"));
            }
        }
        // Shared by the CLI and the IDE. The workspace file is not read here for
        // the same reason it is not offered: upstream reads it and ignores it.
        "antigravity" => out.push(home.join(".gemini").join("config").join("mcp_config.json")),
        "opencode" => {
            let dir = home.join(".config").join("opencode");
            out.push(dir.join("opencode.json"));
            out.push(dir.join("opencode.jsonc"));
            if let Some(cwd) = cwd {
                out.push(cwd.join("opencode.json"));
                out.push(cwd.join("opencode.jsonc"));
            }
        }
        "grok" => {
            out.push(home.join(".grok").join("config.toml"));
            if let Some(cwd) = cwd {
                out.push(cwd.join(".grok").join("config.toml"));
            }
        }
        "hermes" => out.push(home.join(".hermes").join("config.yaml")),
        _ => {}
    }
    out
}

/// Whether an agent can already reach this project's list.
///
/// `"this"` — a boite server is registered. `"none"` — nothing. There is no
/// third state any more: the shim sends the directory it runs in and the
/// endpoint answers for the project that owns it, so an entry made from any
/// project serves every project. What the file names is now only the fallback
/// for a directory no project claims.
///
/// Matched by searching for the path rather than by parsing: the six formats
/// here are JSON, JSONC, TOML and YAML, and the question asked — does this file
/// name that file — does not need a parser for any of them. Windows paths are
/// searched for in their JSON-escaped form too, which is the one difference a
/// JSON document actually makes.
#[tauri::command]
pub fn agent_mcp_registration(
    app: AppHandle,
    key: String,
    project_id: String,
    cwd: Option<String>,
) -> String {
    let Ok(home) = app.path().home_dir() else {
        return "none".into();
    };
    let Ok(creds) = agent_mcp_project_path(app.clone(), project_id) else {
        return "none".into();
    };
    let cwd = cwd.map(PathBuf::from);
    let texts: Vec<String> = agent_config_files(&key, &home, cwd.as_deref())
        .into_iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .collect();
    registration_in(&texts, &creds).into()
}

/// The reading itself, kept apart from the file system so it can be tested.
fn registration_in(texts: &[String], creds: &str) -> &'static str {
    // Serialized as a JSON string, then unwrapped: this is `\\` for a Windows
    // separator and the untouched path everywhere else.
    let escaped = serde_json::to_string(creds).unwrap_or_default();
    let escaped = escaped.trim_matches('"');

    for text in texts {
        // The credentials path is still worth matching first: it is the one
        // form that proves the entry is Boite's even if the binary was renamed
        // or wrapped.
        if text.contains(creds) || (!escaped.is_empty() && text.contains(escaped)) {
            return "this";
        }
        // Matched on the binary, not on the server name: an entry the user
        // called something else still counts as registered. Which project's
        // file it names no longer decides anything — the directory does.
        if text.contains("boite-mcp") {
            return "this";
        }
    }
    "none"
}

/// Writes `[mcp_servers.boite]` into `{cwd}/.grok/config.toml`.
///
/// Grok has no launch flag for a server definition. It reads project MCP from
/// that file, and a worktree's copy is not the user's repository. Existing
/// tables stay; a boite block already there is left alone.
#[tauri::command]
pub fn ensure_grok_mcp(cwd: String, sidecar_path: String) -> Result<(), String> {
    let dir = PathBuf::from(cwd).join(".grok");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .grok: {e}"))?;
    let path = dir.join("config.toml");
    let existing = std::fs::read_to_string(&path).ok();
    let Some(next) = merge_grok_mcp(existing.as_deref(), &sidecar_path) else {
        return Ok(());
    };
    std::fs::write(&path, next).map_err(|e| format!("write grok mcp: {e}"))
}

fn toml_basic_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn grok_mcp_block(sidecar: &str) -> String {
    format!(
        "[mcp_servers.boite]\ncommand = {}\n",
        toml_basic_string(sidecar)
    )
}

/// None means the file already names boite and should not be touched.
fn merge_grok_mcp(existing: Option<&str>, sidecar: &str) -> Option<String> {
    if existing.is_some_and(|t| t.contains("[mcp_servers.boite]")) {
        return None;
    }
    let block = grok_mcp_block(sidecar);
    match existing {
        None | Some("") => Some(block),
        Some(prev) => {
            let mut out = prev.to_string();
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push('\n');
            out.push_str(&block);
            Some(out)
        }
    }
}

#[cfg(test)]
mod registration_tests {
    use super::registration_in;

    const CREDS: &str = "/Users/x/Library/Application Support/dev.boite.app/mcp/abc.json";

    #[test]
    fn absent_config_is_none() {
        assert_eq!(registration_in(&[], CREDS), "none");
        assert_eq!(
            registration_in(&[r#"{"mcpServers":{"supabase":{}}}"#.to_string()], CREDS),
            "none"
        );
    }

    #[test]
    fn this_projects_credentials_are_recognized() {
        let text = format!(r#"{{"command":"/x/boite-mcp","args":["{CREDS}"]}}"#);
        assert_eq!(registration_in(&[text], CREDS), "this");
    }

    /// An entry made from another project used to be a third state, because the
    /// file it named was the only thing that decided which list was written.
    /// The shim now sends its directory and the endpoint resolves the project
    /// from that, so the same entry reaches this project too.
    #[test]
    fn an_entry_made_from_another_project_still_reaches_this_one() {
        let text = r#"{"command":"/x/boite-mcp","args":["/Users/x/.../mcp/other.json"]}"#;
        assert_eq!(registration_in(&[text.to_string()], CREDS), "this");
    }

    /// A Windows path is stored with escaped separators in a JSON config; the
    /// raw form would never match it.
    #[test]
    fn windows_separators_survive_json_escaping() {
        let creds = r"C:\Users\x\AppData\Roaming\dev.boite.app\mcp\abc.json";
        let text = r#"{"args":["C:\\Users\\x\\AppData\\Roaming\\dev.boite.app\\mcp\\abc.json"]}"#;
        assert_eq!(registration_in(&[text.to_string()], creds), "this");
    }

    /// TOML and YAML keep the path verbatim, which the raw match already covers.
    #[test]
    fn unquoted_formats_match_too() {
        let toml = format!("[mcp_servers.boite]\ncommand = \"/x/boite-mcp\"\nargs = [\"{CREDS}\"]");
        assert_eq!(registration_in(&[toml], CREDS), "this");
    }

    /// One agent, several candidate files: any of them naming the shim answers
    /// for the agent, whichever one it is found in.
    #[test]
    fn a_later_file_can_still_be_this_project() {
        let stale = r#"{"args":["/Users/x/.../mcp/other.json"],"command":"/x/boite-mcp"}"#;
        let good = format!(r#"{{"args":["{CREDS}"]}}"#);
        assert_eq!(registration_in(&[stale.to_string(), good], CREDS), "this");
    }
}

#[cfg(test)]
mod grok_mcp_tests {
    use super::{merge_grok_mcp, toml_basic_string};

    #[test]
    fn a_missing_file_is_just_the_boite_block() {
        let out = merge_grok_mcp(None, r"C:\boite-mcp.exe").unwrap();
        assert!(out.contains("[mcp_servers.boite]"));
        assert!(out.contains(&toml_basic_string(r"C:\boite-mcp.exe")));
    }

    #[test]
    fn an_existing_boite_block_is_left_alone() {
        let prev = "[mcp_servers.boite]\ncommand = \"/old\"\n";
        assert_eq!(merge_grok_mcp(Some(prev), "/new"), None);
    }

    #[test]
    fn other_tables_are_kept() {
        let prev = "[mcp_servers.semble]\ncommand = \"semble\"\n";
        let out = merge_grok_mcp(Some(prev), "/boite-mcp").unwrap();
        assert!(out.contains("[mcp_servers.semble]"));
        assert!(out.contains("[mcp_servers.boite]"));
        assert!(out.contains("semble"));
    }
}

/// Where a project's credentials file lives, for an agent that cannot be handed
/// anything at launch.
///
/// Startup writes one per project it finds, which leaves out every project
/// created since — and those are the ones someone is most likely to be wiring
/// an agent for right now. So a missing file is written rather than reported:
/// the endpoint is already up, and its address is the only thing the file says.
#[tauri::command]
pub fn agent_mcp_project_path(app: AppHandle, project_id: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    let path = dir.join("mcp").join(format!("{project_id}.json"));
    if path.is_file() {
        return Ok(path.to_string_lossy().into_owned());
    }
    let api = app
        .try_state::<crate::agent_api::AgentApi>()
        .ok_or("the agent endpoint is not running")?;
    let written = crate::agent_api::write_one(&app, &api, &project_id)?;
    Ok(written.to_string_lossy().into_owned())
}

/// Whether the agent endpoint is up. The panel asks before calling an agent
/// ready: having the binary and knowing how to wire it says nothing about the
/// door being open, and a thread launched before it was answered its agent with
/// no credentials at all.
#[tauri::command]
pub fn agent_api_ready(app: AppHandle) -> bool {
    app.try_state::<crate::agent_api::AgentApi>().is_some()
}
