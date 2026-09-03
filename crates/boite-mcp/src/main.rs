//! The stdio door to the Boite MCP server.
//!
//! It holds no configuration of its own. Boite stamps `BOITE_MCP_URL`,
//! `BOITE_KEY_FILE` and `BOITE_THREAD_ID` into every PTY it spawns, so this
//! reads its whole identity from the environment. Launched anywhere else, those
//! variables are absent and it refuses to start — which is the point: an agent
//! outside Boite has nothing to present.
//!
//! The key arrives as a path rather than a value, because an environment is
//! something a terminal prints: `BOITE_TOKEN` put a credential into the output
//! of any `env` an agent typed, and that output is kept and replayed.
//!
//! What goes over the socket is a signature, never the key. Each request is
//! signed for its own method, path, thread, timestamp and body, so a request
//! captured anywhere is worth nothing on its own and one thread cannot speak
//! for another. See `boite_identity`.
//!
//! The same binary serves the desktop app and `boite-server`; only the URL in
//! the environment differs, so a remote workspace needs no separate shim.
//!
//! The protocol itself, both the handshake era and the stateless 2026-07-28
//! era, lives in `boite_mcp::rpc` and is shared with the `/mcp` HTTP route:
//! this file is only the loop that feeds it lines.

use std::io::BufRead;

use serde_json::Value;

use boite_mcp::host::Host;
use boite_mcp::backend::Backend;
use boite_mcp::{call_blocks, call_tool, hook, rpc, write_line};

fn run_stop_hook() {
    if std::env::args().nth(2).as_deref().unwrap_or("stop") != "stop" {
        return;
    }
    let mut input = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut input);
    if hook::stop_already_active(&input) {
        return;
    }
    let Ok(host) = Host::resolve() else {
        return;
    };
    let Ok(body) = host.send("GET", "/v1/finish", None) else {
        return;
    };
    if let Some(text) = hook::stop_output(false, &body) {
        println!("{text}");
    }
}

/// Where this shim logs, when anywhere.
///
/// `--log-dir` first, then `BOITE_LOG_DIR`, then the directory the desktop app
/// uses on this machine, so one boite's four hosts land in one place. `None`
/// means this machine has no such directory, which is honest and is not a
/// reason to fail: a sidecar that refuses to start because it could not open a
/// log takes every tool call with it.
fn log_dir() -> Option<std::path::PathBuf> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(at) = args.iter().position(|a| a == "--log-dir") {
        if let Some(dir) = args.get(at + 1).filter(|d| !d.starts_with("--")) {
            return Some(std::path::PathBuf::from(dir));
        }
    }
    if let Ok(dir) = std::env::var("BOITE_LOG_DIR") {
        if !dir.trim().is_empty() {
            return Some(std::path::PathBuf::from(dir));
        }
    }
    boite_core::log::desktop_log_dir()
}

/// Brings the log up, or does not, and says nothing either way.
///
/// Nothing here may print: this process speaks JSON-RPC on stdout and a line
/// of its own would break the client's parse. A directory that cannot be
/// written is the ordinary case on a machine with no desktop install, and it
/// leaves the shim exactly as capable as it was before this existed.
fn start_log() {
    let Some(dir) = log_dir() else { return };
    let _ = boite_core::log::init(boite_core::log::LogConfig {
        dir,
        host: "mcp".to_string(),
        extra_stderr: false,
    });
}

fn main() {
    start_log();

    // Stop is the one hook this binary answers. Anything else (or a stop we
    // cannot reach the endpoint for) prints nothing and exits 0: a hook that
    // errors is a slower way of saying "carry on", and a hook that can fire
    // twice for the same stop must never block the second pass.
    if std::env::args().nth(1).as_deref() == Some("--hook") {
        run_stop_hook();
        std::process::exit(0);
    }

    // Resolved but not required. Exiting here would kill the connection during
    // the handshake, and a client can only report that as "connection closed" —
    // hiding a cause that is one sentence long. Answering initialize and failing
    // at the call instead puts that sentence in front of the agent, which is the
    // only place anyone will read it.
    let host = Host::resolve();

    let call = |name: &str, args: &Value| match &host {
        Ok(h) => call_tool(h, name, args),
        Err(e) => Err(e.clone()),
    };
    // The screenshot answers content blocks, an image among them, which is why
    // it cannot ride the `String` pipeline above. With no host there is nothing
    // to photograph: answering `None` drops the call through to `call`, which
    // says why in the one sentence the agent should read.
    let blocks = |name: &str, args: &Value| match &host {
        Ok(h) => call_blocks(h, name, args),
        Err(_) => None,
    };
    // The role is a hint from the environment Boite stamped at spawn; the
    // endpoint re-checks the row on every privileged call, so exporting it by
    // hand widens the menu and nothing else.
    let role = std::env::var(boite_identity::env::ROLE).ok();
    let scope = std::env::var(boite_identity::env::ORCHESTRATOR_SCOPE).ok();
    let instructions = boite_mcp::instructions_for_role(role.as_deref(), scope.as_deref());
    let service = rpc::Service {
        call: &call,
        blocks: Some(&blocks),
        tools: boite_mcp::tools_for_role(role.as_deref()),
        instructions: &instructions,
    };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(reply) = rpc::answer(&service, &msg) {
            write_line(&mut stdout, &reply);
        }
    }
}
