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
use boite_mcp::{call_tool, rpc, tools, write_line, INSTRUCTIONS};

fn main() {
    // This binary answers no lifecycle hook. The guard stays because settings
    // files written by older versions still name `--hook stop`, and reaching the
    // stdio loop below would leave that process waiting for a `jsonrpc` line
    // that is never coming. Silence and a zero exit is what every hook contract
    // reads as "nothing to say".
    if std::env::args().nth(1).as_deref() == Some("--hook") {
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
    let service = rpc::Service {
        call: &call,
        tools: tools(),
        instructions: INSTRUCTIONS,
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
