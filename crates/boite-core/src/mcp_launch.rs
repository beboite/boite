//! Launch flags that point an agent at this workspace's MCP shim.
//!
//! The same three files on every host: the sidecar binary, a generated
//! `--mcp-config` document, and a Claude `--settings` file that wires the
//! stop hook. Written here so the desktop and the server cannot drift on
//! the shape, and so a spawn path can inject the flags without knowing
//! which host minted them.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::mcp_catalog::{self, BOITE_MCP_ID};

/// Where the generated MCP files live, and the binary they name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpPaths {
    pub sidecar: PathBuf,
    pub config: PathBuf,
    pub settings: PathBuf,
}

/// Write `mcp-boite.json` and `settings-boite.json` next to each other.
///
/// Rewritten every time: the sidecar moves with an update, and a stale
/// file would point an agent at a binary that is no longer there.
pub fn write_files(dir: &Path, sidecar: &Path) -> Result<McpPaths, String> {
    fs::create_dir_all(dir).map_err(|e| format!("create mcp dir: {e}"))?;
    let config = dir.join("mcp-boite.json");
    let settings = dir.join("settings-boite.json");
    let sidecar_s = sidecar.to_string_lossy();

    let cfg = json!({
        "mcpServers": {
            "boite": { "command": sidecar_s }
        }
    });
    fs::write(
        &config,
        serde_json::to_vec_pretty(&cfg).map_err(|e| format!("serialize mcp config: {e}"))?,
    )
    .map_err(|e| format!("write mcp config: {e}"))?;

    // Quoted so a space in Application Support or Program Files is one
    // argument. The hook binary is this sidecar; it already knows who it is
    // from the environment Boite stamps into the PTY.
    let command = format!("\"{sidecar_s}\" --hook stop");
    let hooks = json!({
        "hooks": {
            "Stop": [{
                "hooks": [{
                    "type": "command",
                    "command": command
                }]
            }]
        }
    });
    fs::write(
        &settings,
        serde_json::to_vec_pretty(&hooks).map_err(|e| format!("serialize settings: {e}"))?,
    )
    .map_err(|e| format!("write settings: {e}"))?;

    Ok(McpPaths {
        sidecar: sidecar.to_path_buf(),
        config,
        settings,
    })
}

/// The extra argv this command should get, or empty when this CLI cannot
/// take a server at launch.
///
/// Claude takes a config document and a settings file. Codex takes a TOML
/// override naming the sidecar. Everyone else is paste-only and is not
/// touched here.
pub fn flags_for(cmd: &str, paths: &McpPaths) -> Vec<String> {
    match agent_name(cmd) {
        "claude" => vec![
            "--mcp-config".into(),
            paths.config.to_string_lossy().into_owned(),
            "--settings".into(),
            paths.settings.to_string_lossy().into_owned(),
        ],
        "codex" => vec![
            "-c".into(),
            format!(
                "mcp_servers.boite.command={}",
                serde_json::to_string(&paths.sidecar.to_string_lossy().as_ref())
                    .unwrap_or_else(|_| format!("\"{}\"", paths.sidecar.display()))
            ),
        ],
        _ => Vec::new(),
    }
}

/// Launch flags for one project's explicit MCP allow-list.
///
/// `None` is the compatibility path: leave every global server alone and only
/// add Boite when the app-wide setting says so. `Some`, including an empty
/// slice, is authoritative. Codex receives an enabled override for every
/// discovered global server; Claude receives a strict generated config.
pub fn project_flags_for(
    cmd: &str,
    paths: &McpPaths,
    project_id: &str,
    selected_ids: Option<&[String]>,
    default_boite: bool,
) -> Result<Vec<String>, String> {
    let Some(selected_ids) = selected_ids else {
        return Ok(if default_boite {
            flags_for(cmd, paths)
        } else {
            Vec::new()
        });
    };
    let boite_selected = selected_ids.iter().any(|id| id == BOITE_MCP_ID);

    match agent_name(cmd) {
        "claude" => {
            let mut servers = mcp_catalog::claude_servers(selected_ids)?;
            if boite_selected {
                servers.insert(
                    BOITE_MCP_ID.into(),
                    json!({ "command": paths.sidecar.to_string_lossy() }),
                );
            }
            let digest = Sha256::digest(project_id.as_bytes());
            let suffix: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
            let config = paths
                .config
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(format!("mcp-project-{suffix}.json"));
            let document = json!({ "mcpServers": servers });
            fs::write(
                &config,
                serde_json::to_vec_pretty(&document)
                    .map_err(|e| format!("serialize project mcp config: {e}"))?,
            )
            .map_err(|e| format!("write project mcp config: {e}"))?;

            let mut args = vec![
                "--mcp-config".into(),
                config.to_string_lossy().into_owned(),
                "--strict-mcp-config".into(),
            ];
            if boite_selected {
                args.push("--settings".into());
                args.push(paths.settings.to_string_lossy().into_owned());
            }
            Ok(args)
        }
        "codex" => {
            let mut args = mcp_catalog::codex_selection_flags(selected_ids)?;
            if boite_selected {
                args.extend([
                    "-c".into(),
                    format!(
                        "mcp_servers.boite.command={}",
                        serde_json::to_string(&paths.sidecar.to_string_lossy().as_ref())
                            .unwrap_or_else(|_| format!("\"{}\"", paths.sidecar.display()))
                    ),
                    "-c".into(),
                    "mcp_servers.boite.enabled=true".into(),
                ]);
            }
            Ok(args)
        }
        _ => Ok(Vec::new()),
    }
}

/// Insert the flags in front of the first `--`, so a Claude opening prompt
/// is not read as a second config file.
pub fn inject(cmd: &str, args: Vec<String>, paths: &McpPaths) -> Vec<String> {
    if already_wired(&args) {
        return args;
    }
    let extra = flags_for(cmd, paths);
    if extra.is_empty() {
        return args;
    }
    let mut out = args;
    if let Some(i) = out.iter().position(|a| a == "--") {
        out.splice(i..i, extra);
    } else {
        out.extend(extra);
    }
    out
}

/// Project-aware form of [`inject`]. The row keeps its original argv; callers
/// apply this to the spawn copy so changing the checkboxes affects a relaunch.
pub fn inject_project(
    cmd: &str,
    args: Vec<String>,
    paths: &McpPaths,
    project_id: &str,
    selected_ids: Option<&[String]>,
    default_boite: bool,
) -> Result<Vec<String>, String> {
    let args = if selected_ids.is_some() {
        without_legacy_wiring(args, paths)
    } else {
        args
    };
    if already_wired(&args) {
        return Ok(args);
    }
    let extra = project_flags_for(cmd, paths, project_id, selected_ids, default_boite)?;
    if extra.is_empty() {
        return Ok(args);
    }
    let mut out = args;
    if let Some(i) = out.iter().position(|a| a == "--") {
        out.splice(i..i, extra);
    } else {
        out.extend(extra);
    }
    Ok(out)
}

fn without_legacy_wiring(args: Vec<String>, paths: &McpPaths) -> Vec<String> {
    let config = paths.config.to_string_lossy();
    let settings = paths.settings.to_string_lossy();
    let mut out = Vec::with_capacity(args.len());
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if (arg == "--mcp-config"
            && args.get(index + 1).map(String::as_str) == Some(config.as_ref()))
            || (arg == "--settings"
                && args.get(index + 1).map(String::as_str) == Some(settings.as_ref()))
        {
            index += 2;
            continue;
        }
        if arg == "-c"
            && args
                .get(index + 1)
                .is_some_and(|value| value.contains("mcp_servers.boite.command="))
        {
            index += 2;
            continue;
        }
        out.push(arg.clone());
        index += 1;
    }
    out
}

fn already_wired(args: &[String]) -> bool {
    args.iter().any(|a| {
        a == "--mcp-config"
            || a.contains("mcp_servers.boite")
            || a == "--settings"
    })
}

/// Both separators, on every host. `Path` reads what the host it is compiled
/// for reads, so a Linux `boite-server` handed `C:\bin\codex.exe` by a Windows
/// device sees one long file name, matches nothing, and launches that thread
/// with no MCP flags at all. A command line is the device's, not the server's.
fn agent_name(cmd: &str) -> &str {
    let file = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let stem = Path::new(file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file);
    if stem.eq_ignore_ascii_case("claude") {
        "claude"
    } else if stem.eq_ignore_ascii_case("codex") {
        "codex"
    } else {
        stem
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(dir: &Path) -> McpPaths {
        let sidecar = dir.join("boite-mcp");
        fs::write(&sidecar, "shim").unwrap();
        write_files(dir, &sidecar).unwrap()
    }

    #[test]
    fn write_files_names_the_sidecar_and_the_hook() {
        let dir = std::env::temp_dir().join(format!("boite-mcp-launch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = paths(&dir);
        let cfg = fs::read_to_string(&p.config).unwrap();
        assert!(cfg.contains("boite-mcp"), "{cfg}");
        let settings = fs::read_to_string(&p.settings).unwrap();
        assert!(settings.contains("--hook stop"), "{settings}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_gets_config_and_settings_before_the_prompt() {
        let dir = std::env::temp_dir().join(format!("boite-mcp-claude-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = paths(&dir);
        let out = inject(
            "claude",
            vec!["--".into(), "hello".into()],
            &p,
        );
        let cfg_at = out.iter().position(|a| a == "--mcp-config").unwrap();
        let dash = out.iter().position(|a| a == "--").unwrap();
        assert!(cfg_at < dash, "{out:?}");
        assert!(out.contains(&"--settings".to_string()), "{out:?}");
        assert_eq!(out.last().map(String::as_str), Some("hello"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn already_wired_args_are_left_alone() {
        let dir = std::env::temp_dir().join(format!("boite-mcp-wired-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = paths(&dir);
        let given = vec!["--mcp-config".into(), "other.json".into()];
        assert_eq!(inject("claude", given.clone(), &p), given);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_plain_shell_gets_nothing() {
        let dir = std::env::temp_dir().join(format!("boite-mcp-shell-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = paths(&dir);
        assert!(flags_for("pwsh", &p).is_empty());
        assert_eq!(
            inject("pwsh", vec!["-NoLogo".into()], &p),
            vec!["-NoLogo".to_string()]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_names_the_sidecar() {
        let dir = std::env::temp_dir().join(format!("boite-mcp-codex-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = paths(&dir);
        // Both spellings from every host: the command line belongs to the
        // device that made the thread, and a Linux server reads Windows rows.
        for cmd in ["codex", "C:\\bin\\codex.exe", "/usr/local/bin/codex"] {
            let flags = flags_for(cmd, &p);
            assert_eq!(flags.len(), 2, "{cmd}: {flags:?}");
            assert_eq!(flags[0], "-c");
            assert!(flags[1].contains("mcp_servers.boite.command="), "{flags:?}");
            assert!(flags[1].contains("boite-mcp"), "{flags:?}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn explicit_empty_claude_selection_is_strict() {
        let dir = std::env::temp_dir().join(format!("boite-mcp-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = paths(&dir);
        let flags = project_flags_for("claude", &p, "project", Some(&[]), true).unwrap();
        assert!(flags.contains(&"--strict-mcp-config".to_string()));
        assert!(!flags.contains(&"--settings".to_string()));
        let config = flags
            .iter()
            .position(|arg| arg == "--mcp-config")
            .and_then(|at| flags.get(at + 1))
            .unwrap();
        let body = fs::read_to_string(config).unwrap();
        assert!(body.contains("\"mcpServers\": {}"), "{body}");
        let _ = fs::remove_dir_all(&dir);
    }
}
