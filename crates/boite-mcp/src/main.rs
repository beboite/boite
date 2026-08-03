//! MCP server exposing the todo list of the Boite terminal it was launched in.
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
//! Everything it says goes out in TOON (`toon.rs`) rather than JSON. The tool
//! list is paid for in every session that connects, and each answer is paid for
//! again in the context window that reads it, so both are written to be short:
//! one line per tool, one row per todo, and ids shortened to the prefix that
//! still distinguishes them.

mod call;
mod host;
mod http;
mod render;
mod toon;
mod tools;

use host::Host;

use std::io::{BufRead, Write};

use serde_json::{json, Value};

use call::call_tool;
use tools::{tools, INSTRUCTIONS};

/// Percent-encodes a value so it survives as a query parameter.
///
/// A needle is whatever somebody typed: a path with spaces in it, an error
/// string with a `&`, a branch name. Unencoded, the first `&` would end the
/// parameter and the search would quietly be for half of it.
pub(crate) fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Newest version this speaks. A client asking for an older one gets that one
/// back — the shape of these five tools has not changed across any of them, and
/// answering with a version the client did not offer ends the handshake.
const LATEST_PROTOCOL: &str = "2025-06-18";
const SUPPORTED_PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// A todo's title is one line by convention and a pasted paragraph in practice,
/// and its description is a paragraph on purpose.
const MAX_CELL: usize = 200;
/// Branch lists grow without bound in a long-lived repository; the agent needs
/// the naming convention and the few most recent, not all of them.
const MAX_BRANCHES: usize = 40;

fn reply(out: &mut impl Write, id: &Value, result: Value) {
    let msg = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let _ = writeln!(out, "{msg}");
    let _ = out.flush();
}

/// Tool failures come back as a result with `isError`, not as a JSON-RPC error:
/// the call reached the tool and the agent should read what went wrong and
/// adapt. Protocol-level errors are a different thing and stay rare.
fn reply_tool_error(out: &mut impl Write, id: &Value, message: &str) {
    reply(
        out,
        id,
        json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
    );
}

/// Answer in the version the client asked for when it is one this speaks, and
/// in the newest one otherwise. A client that offers nothing gets the newest —
/// which is what the specification asks a server to do.
fn negotiate(params: &Value) -> &'static str {
    let asked = params.get("protocolVersion").and_then(|v| v.as_str());
    asked
        .and_then(|a| SUPPORTED_PROTOCOLS.into_iter().find(|s| *s == a))
        .unwrap_or(LATEST_PROTOCOL)
}

fn main() {
    // Resolved but not required. Exiting here would kill the connection during
    // the handshake, and a client can only report that as "connection closed" —
    // hiding a cause that is one sentence long. Answering initialize and failing
    // at the call instead puts that sentence in front of the agent, which is the
    // only place anyone will read it.
    let host = Host::resolve();

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
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        // Notifications carry no id and expect no answer.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };

        match method {
            "initialize" => {
                let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
                reply(
                    &mut stdout,
                    &id,
                    json!({
                        "protocolVersion": negotiate(&params),
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "boite", "version": env!("CARGO_PKG_VERSION") },
                        "instructions": INSTRUCTIONS
                    }),
                )
            }
            "tools/list" => reply(&mut stdout, &id, json!({ "tools": tools(host.as_ref().ok()) })),
            "tools/call" => {
                let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
                let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let called = match &host {
                    Ok(h) => call_tool(h, name, &args),
                    Err(e) => Err(e.clone()),
                };
                match called {
                    Ok(text) => reply(
                        &mut stdout,
                        &id,
                        json!({ "content": [{ "type": "text", "text": text }] }),
                    ),
                    Err(e) => reply_tool_error(&mut stdout, &id, &e),
                }
            }
            "ping" => reply(&mut stdout, &id, json!({})),
            other => {
                let msg = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("method not found: {other}") }
                });
                let _ = writeln!(stdout, "{msg}");
                let _ = stdout.flush();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Answering with a version the client did not offer ends the handshake, so
    /// an older client gets the version it asked for rather than the newest.
    #[test]
    fn the_protocol_answers_what_the_client_offered() {
        assert_eq!(negotiate(&json!({ "protocolVersion": "2024-11-05" })), "2024-11-05");
        assert_eq!(negotiate(&json!({ "protocolVersion": "1999-01-01" })), LATEST_PROTOCOL);
        assert_eq!(negotiate(&json!({})), LATEST_PROTOCOL);
    }
}
