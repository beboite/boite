//! Asking `kebacc-switch` what it holds, and telling it to flip.
//!
//! That binary is [kebab1337420/kebacc-switch](https://github.com/kebab1337420/kebacc-switch).
//! Boite does not snapshot Claude or Codex credentials. It runs the published
//! CLI, passes the `-Json` document through, and the window reloads its own
//! threads afterwards.

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const BIN: &str = "kebacc-switch";

fn tools_dir_binary() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let dir = home.join(".claude-tools");
    let exe = if cfg!(windows) {
        dir.join("kebacc-switch.exe")
    } else {
        dir.join("kebacc-switch")
    };
    exe.is_file().then_some(exe)
}

fn resolve() -> Option<PathBuf> {
    if let Ok(path) = which::which(BIN) {
        return Some(path);
    }
    tools_dir_binary()
}

fn tool() -> Result<Command, String> {
    let path = resolve().ok_or_else(|| format!("{BIN} is not on this machine"))?;
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    Ok(cmd)
}

fn fail(out: &Output) -> String {
    let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if msg.is_empty() {
        format!("{BIN} exited with {}", out.status)
    } else {
        msg
    }
}

fn stdout_json(out: Output) -> Result<String, String> {
    if !out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        if stdout.trim_start().starts_with('{') {
            return String::from_utf8(out.stdout)
                .map_err(|_| format!("{BIN} printed invalid UTF-8"));
        }
        return Err(fail(&out));
    }
    if out.stdout.len() > MAX_OUTPUT {
        return Err(format!(
            "{BIN} printed more than this can be expected to parse"
        ));
    }
    String::from_utf8(out.stdout).map_err(|_| format!("{BIN} printed invalid UTF-8"))
}

fn run(args: &[&str]) -> Result<Output, String> {
    tool()?
        .args(args)
        .output()
        .map_err(|e| format!("{BIN} could not be started: {e}"))
}

fn provider_or_all(provider: Option<&str>) -> Result<&str, String> {
    match provider.unwrap_or("all") {
        p @ ("claude" | "codex" | "all") => Ok(p),
        other => Err(format!("unknown provider '{other}'")),
    }
}

/// `kebacc-switch list -Provider <p> -Json`
pub fn list_blocking(provider: Option<&str>) -> Result<String, String> {
    let p = provider_or_all(provider)?;
    stdout_json(run(&["list", "-Provider", p, "-Json"])?)
}

/// `kebacc-switch add -Provider <p> -Json`
pub fn add_blocking(provider: &str) -> Result<String, String> {
    let p = provider_or_all(Some(provider))?;
    if p == "all" {
        return Err("add needs claude or codex".into());
    }
    stdout_json(run(&["add", "-Provider", p, "-Json"])?)
}

/// `kebacc-switch switch -Provider <p> -Email <email> -Yes -Json`
pub fn switch_blocking(provider: &str, email: &str) -> Result<String, String> {
    let p = provider_or_all(Some(provider))?;
    if p == "all" {
        return Err("switch needs claude or codex".into());
    }
    if email.is_empty() {
        return Err("switch needs an email".into());
    }
    stdout_json(run(&[
        "switch",
        "-Provider",
        p,
        "-Email",
        email,
        "-Yes",
        "-Json",
    ])?)
}

/// `kebacc-switch auto -Provider <p> -Json`
pub fn auto_blocking(provider: Option<&str>) -> Result<String, String> {
    let p = provider_or_all(provider)?;
    stdout_json(run(&["auto", "-Provider", p, "-Json"])?)
}

/// What `--version` prints, or `None` when the binary is not here.
pub fn version_blocking() -> Option<String> {
    let mut cmd = tool().ok()?;
    let out = cmd.arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let version = text
        .split_whitespace()
        .last()
        .unwrap_or_default()
        .trim()
        .to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Whether the binary is on PATH or in `~/.claude-tools`.
pub fn installed_blocking() -> bool {
    resolve().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_email_is_refused_before_the_binary_runs() {
        let err = switch_blocking("claude", "").expect_err("empty email");
        assert!(err.contains("email"));
    }

    #[test]
    fn add_refuses_all() {
        let err = add_blocking("all").expect_err("all");
        assert!(err.contains("claude or codex"));
    }

    #[test]
    fn unknown_provider_is_refused() {
        let err = list_blocking(Some("grok")).expect_err("grok");
        assert!(err.contains("unknown provider"));
    }
}
