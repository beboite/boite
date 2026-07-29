//! Asking `fastpick` what a thread could be launched on.
//!
//! fastpick is a separate tool that owns the awkward half of running an agent against a
//! third-party endpoint: the key files, the local proxy it has to start, the machine it has
//! to wake, and the environment each agent wants that setup expressed in. Boite does not
//! reimplement any of that. It asks for the choices, draws them in its own menu, and then
//! launches `fastpick --harness <h> --provider <p> --model <m>` as the thread's command.
//!
//! The answer is passed through as the raw JSON document fastpick printed, deliberately.
//! Parsing it into structs here would mean tracking its schema in two languages and a boite
//! release for every field it grows; the frontend types the shape it actually reads, and
//! the payload carries a `schema` number for when that stops being enough.
//!
//! This runs where the agents run, which for a remote boite is the server. That is the
//! whole reason the key never has to travel: fastpick reads it on the machine that spawns
//! the PTY, and no part of it reaches whatever device is drawing the menu.

use std::process::{Command, Stdio};

/// The `--json` payloads fastpick prints are a few hundred lines at most. A binary that is
/// not fastpick could print anything, so the read is bounded rather than trusting.
const MAX_OUTPUT: usize = 4 * 1024 * 1024;

fn fastpick() -> Command {
    let mut cmd = Command::new("fastpick");
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// The harnesses, providers and bindings fastpick's config declares, as JSON.
///
/// With `provider` named, that provider's models too. They are a separate call because
/// listing every provider's models means one HTTP request each; fastpick answers from its
/// own cache unless `refresh` is set, so the menu opens without waiting on the network.
pub fn list_blocking(
    provider: Option<String>,
    refresh: bool,
) -> Result<String, String> {
    let mut cmd = fastpick();
    cmd.args(["--list", "--json"]);
    if let Some(id) = provider.as_deref() {
        cmd.args(["--provider", id]);
    }
    if refresh {
        cmd.arg("--refresh");
    }

    let out = cmd
        .output()
        .map_err(|e| format!("fastpick could not be started: {e}"))?;

    // fastpick's contract: exit 0 means one JSON document on stdout and nothing else, and
    // every notice and every error goes to stderr. So a failure has a usable message
    // already, and there is no case where stdout has to be sniffed for one.
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() {
            format!("fastpick exited with {}", out.status)
        } else {
            msg
        });
    }
    if out.stdout.len() > MAX_OUTPUT {
        return Err("fastpick printed more than this can be expected to parse".into());
    }
    String::from_utf8(out.stdout).map_err(|_| "fastpick printed invalid UTF-8".to_string())
}
