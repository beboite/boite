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
}
