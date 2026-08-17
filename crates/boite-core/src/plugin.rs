//! Asking an account-switcher CLI what it holds, and telling it to flip.
//!
//! The switcher is a separate tool, the way fastpick is. Boite does not
//! snapshot OAuth tokens or rewrite `~/.claude`. It runs a known binary,
//! passes the JSON document through, and the window reloads its own threads
//! afterwards. The contract is small on purpose:
//!
//! ```text
//!   <cmd> status --json
//!   <cmd> switch --json <who>
//! ```
//!
//! `who` is `next` or an account id the status document named. Exit 0 is
//! success. A tool that does not understand `--json` is retried without it,
//! and the raw text comes back under `schema: 0` so the panel can still
//! show something.
//!
//! Claude looks for `claude-cc` on PATH, then `~/.claude-tools/claude-cc.ps1`.
//! Codex looks for `codex-cc`, then `~/.codex-tools/codex-cc.ps1`. Anything
//! else is "not on this machine".

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

const MAX_OUTPUT: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Claude,
    Codex,
}

impl Kind {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "claude" => Ok(Kind::Claude),
            "codex" => Ok(Kind::Codex),
            other => Err(format!("unknown plugin kind: {other}")),
        }
    }

    fn cmd_name(self) -> &'static str {
        match self {
            Kind::Claude => "claude-cc",
            Kind::Codex => "codex-cc",
        }
    }

    fn tools_dir(self) -> &'static str {
        match self {
            Kind::Claude => ".claude-tools",
            Kind::Codex => ".codex-tools",
        }
    }
}

enum Launch {
    Direct(PathBuf),
    Pwsh(PathBuf),
}

fn no_window(cmd: &mut Command) {
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
}

fn resolve(kind: Kind) -> Option<Launch> {
    if let Ok(path) = which::which(kind.cmd_name()) {
        return Some(Launch::Direct(path));
    }
    let home = dirs::home_dir()?;
    let script = home
        .join(kind.tools_dir())
        .join(format!("{}.ps1", kind.cmd_name()));
    if script.is_file() {
        return Some(Launch::Pwsh(script));
    }
    None
}

fn command_for(launch: &Launch) -> Command {
    match launch {
        Launch::Direct(path) => {
            let mut cmd = Command::new(path);
            no_window(&mut cmd);
            cmd
        }
        Launch::Pwsh(script) => {
            let shell = which::which("pwsh")
                .or_else(|_| which::which("powershell"))
                .unwrap_or_else(|_| PathBuf::from("pwsh"));
            let mut cmd = Command::new(shell);
            no_window(&mut cmd);
            cmd.args(["-NoProfile", "-File"]).arg(script);
            cmd
        }
    }
}

fn bound_utf8(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_OUTPUT {
        return Err("the switcher printed more than this can be expected to parse".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "the switcher printed invalid UTF-8".into())
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

fn run(kind: Kind, args: &[&str]) -> Result<Output, String> {
    let launch =
        resolve(kind).ok_or_else(|| format!("{} is not on this machine", kind.cmd_name()))?;
    command_for(&launch)
        .args(args)
        .output()
        .map_err(|e| format!("{} could not be started: {e}", kind.cmd_name()))
}

fn wrap_text(stdout: &str, stderr: &str) -> String {
    let text = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::json!({ "schema": 0, "text": text }).to_string()
}

/// One JSON document: the switcher's `status --json`, or `schema: 0` text.
pub fn status_blocking(kind: Kind) -> Result<String, String> {
    let first = run(kind, &["status", "--json"])?;
    if first.status.success() {
        return bound_utf8(&first.stdout);
    }
    let retry = run(kind, &["status"])?;
    if retry.status.success() {
        return Ok(wrap_text(&bound_utf8(&retry.stdout)?, &stderr_of(&retry)));
    }
    let msg = stderr_of(&first);
    Err(if msg.is_empty() {
        format!("{} status exited with {}", kind.cmd_name(), first.status)
    } else {
        msg
    })
}

/// Flip to `who` (`next` or an id). JSON on success, or `schema: 0`.
pub fn switch_blocking(kind: Kind, who: &str) -> Result<String, String> {
    let who = if who.is_empty() { "next" } else { who };
    let first = run(kind, &["switch", "--json", who])?;
    if first.status.success() {
        return bound_utf8(&first.stdout);
    }
    let retry = run(kind, &["switch", who])?;
    // kebab's claude-cc uses 10 for "switched". 0 is the usual success.
    let code = retry.status.code();
    if retry.status.success() || code == Some(10) {
        let text = bound_utf8(&retry.stdout).unwrap_or_default();
        return Ok(serde_json::json!({
            "schema": 0,
            "current": who,
            "text": text.trim(),
        })
        .to_string());
    }
    let msg = stderr_of(&first);
    let fallback = stderr_of(&retry);
    let picked = if fallback.is_empty() { msg } else { fallback };
    Err(if picked.is_empty() {
        format!("{} switch exited with {}", kind.cmd_name(), retry.status)
    } else {
        picked
    })
}

/// What `--version` prints, or `None` when the tool is not here.
pub fn version_blocking(kind: Kind) -> Option<String> {
    let out = run(kind, &["--version"]).ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_parse_only_knows_the_two_switchers() {
        assert_eq!(Kind::parse("claude").unwrap(), Kind::Claude);
        assert_eq!(Kind::parse("codex").unwrap(), Kind::Codex);
        assert!(Kind::parse("fastpick").is_err());
        assert!(Kind::parse("").is_err());
    }

    #[test]
    fn wrap_text_skips_empty_halves() {
        let raw = wrap_text("hello", "");
        assert!(raw.contains("\"schema\":0"));
        assert!(raw.contains("hello"));
        assert!(!raw.contains("\\n\\n"));
    }
}
