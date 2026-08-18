//! The Boite MCP implementation, shared by its two doors.
//!
//! The stdio shim (`main.rs`) and the agent endpoint's `/mcp` route serve the
//! same tools to the same kind of caller, and until this library existed the
//! only way to have both was to write the protocol twice. What lives here is
//! everything transport-agnostic: the JSON-RPC engine with both protocol eras
//! in it (`rpc`), the tool list (`tools`), the dispatch from a tool name to a
//! workspace call (`call`), and the TOON the answers go out in (`toon`,
//! `render`). What stays outside is how a request reaches the workspace: the
//! shim signs HTTP over loopback (`host`, `http`), the server route dispatches
//! in-process, and both say so through one trait (`backend::Backend`).

pub mod backend;
mod call;
pub mod hook;
pub mod host;
mod http;
mod render;
pub mod rpc;
pub mod toon;
mod tools;

pub use call::{call_blocks, call_tool};
pub use tools::{tools, INSTRUCTIONS};

use std::io::Write;

use serde_json::Value;

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

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A todo's title is one line by convention and a pasted paragraph in practice,
/// and its description is a paragraph on purpose.
pub(crate) const MAX_CELL: usize = 200;
/// Branch lists grow without bound in a long-lived repository; the agent needs
/// the naming convention and the few most recent, not all of them.
pub(crate) const MAX_BRANCHES: usize = 40;

/// What a page is allowed to spend of the agent's context.
///
/// The driver caps text and element counts too, but it runs inside the page and
/// shares its JS realm, so those caps are enforced by the side that would want
/// to break them. These are the copy on the trusted side of the wire.
pub(crate) const MAX_PAGE_TEXT: usize = 60_000;
pub(crate) const MAX_PAGE_ELEMENTS: usize = 400;

/// Writes one JSON-RPC message and flushes it, for the stdio door.
pub fn write_line(out: &mut impl Write, msg: &Value) {
    let _ = writeln!(out, "{msg}");
    let _ = out.flush();
}
