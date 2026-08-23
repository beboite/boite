//! Asking `fast-mcp-ssh` which version is on this machine.
//!
//! That binary is [klNuno/fast-mcp-ssh](https://github.com/klNuno/fast-mcp-ssh),
//! an MCP server the agents reach their machines through. Boite neither starts
//! it nor reads its config: a thread's own MCP client owns that. The plugins
//! panel only has to tell an install from an update, and that is one question.
//!
//! It runs where the agents run, which for a remote boite is the server. A
//! desktop asking its own PATH would answer for the wrong machine.

use std::process::{Command, Stdio};

const BIN: &str = "fast-mcp-ssh";

/// What `fast-mcp-ssh --version` says, or `None` when there is none to ask.
///
/// Absence is not an error. The panel asks this to decide between offering an
/// install and offering an update, and "not on this machine" is one of the two
/// answers it wants rather than a failure to report.
pub fn version_blocking() -> Option<String> {
    let mut cmd = Command::new(BIN);
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // `fast-mcp-ssh 0.5.0`, the convention every `--version` follows. The name
    // is already known here, so only the number is carried back.
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
