//! MCP server exposing the todo list of the Boite terminal it was launched in.
//!
//! It holds no configuration and no credentials of its own. Boite stamps
//! `BOITE_MCP_URL`, `BOITE_TOKEN` and `BOITE_THREAD_ID` into every PTY it
//! spawns, so this reads its whole identity from the environment. Launched
//! anywhere else, those variables are absent and it refuses to start — which is
//! the point: an agent outside Boite has nothing to present.
//!
//! The same binary serves the desktop app and `boite-server`; only the URL in
//! the environment differs, so a remote workspace needs no separate shim.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2024-11-05";

struct Host {
    url: String,
    token: String,
    thread_id: String,
    http: reqwest::blocking::Client,
}

impl Host {
    fn from_env() -> Result<Host, String> {
        let url = std::env::var("BOITE_MCP_URL")
            .map_err(|_| "BOITE_MCP_URL is unset — run this from a Boite terminal".to_string())?;
        let token = std::env::var("BOITE_TOKEN").map_err(|_| "BOITE_TOKEN is unset".to_string())?;
        let thread_id =
            std::env::var("BOITE_THREAD_ID").map_err(|_| "BOITE_THREAD_ID is unset".to_string())?;
        Ok(Host {
            url,
            token,
            thread_id,
            http: reqwest::blocking::Client::new(),
        })
    }

    fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.url))
            .bearer_auth(&self.token)
            .header("x-boite-thread", &self.thread_id);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().map_err(|e| format!("boite unreachable: {e}"))?;
        let status = res.status();
        if status == reqwest::StatusCode::CONFLICT {
            // The endpoint refuses without saying which reason applied; say the
            // same here rather than inventing a diagnosis.
            return Err("that item is not open, or does not belong to this project".into());
        }
        if !status.is_success() {
            return Err(format!("boite refused the call ({status})"));
        }
        res.json::<Value>().map_err(|e| format!("bad response: {e}"))
    }
}

fn tools() -> Value {
    json!([
        {
            "name": "todo_list",
            "description": "List the todo items of the project this terminal belongs to.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "todo_add",
            "description": "Add a todo item to this project's list.",
            "inputSchema": {
                "type": "object",
                "properties": { "text": { "type": "string", "description": "One line describing the task." } },
                "required": ["text"],
                "additionalProperties": false
            }
        },
        {
            "name": "todo_claim",
            "description": "Report a todo item as finished, with a one-line summary of what changed. \
                            This does NOT tick it off: it marks the item as awaiting the user's \
                            confirmation, which only they can give.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The id given in the task prompt." },
                    "note": { "type": "string", "description": "One line on what was done." }
                },
                "required": ["id"],
                "additionalProperties": false
            }
        }
    ])
}

fn call_tool(host: &Host, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "todo_list" => {
            let out = host.send(reqwest::Method::GET, "/v1/todos", None)?;
            Ok(serde_json::to_string_pretty(&out).unwrap_or_else(|_| out.to_string()))
        }
        "todo_add" => {
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or("todo_add needs a text")?;
            let out = host.send(reqwest::Method::POST, "/v1/todos", Some(json!({ "text": text })))?;
            let id = out.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            Ok(format!("Added. id {id}"))
        }
        "todo_claim" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("todo_claim needs an id")?;
            let note = args.get("note").and_then(|v| v.as_str());
            host.send(
                reqwest::Method::POST,
                "/v1/todos/claim",
                Some(json!({ "id": id, "note": note })),
            )?;
            Ok("Reported. The user still has to confirm it.".into())
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

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

fn main() {
    // Resolved but not required. Exiting here would kill the connection during
    // the handshake, and a client can only report that as "connection closed" —
    // hiding a cause that is one sentence long. Answering initialize and failing
    // at the call instead puts that sentence in front of the agent, which is the
    // only place anyone will read it.
    let host = Host::from_env();

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
            "initialize" => reply(
                &mut stdout,
                &id,
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "boite", "version": env!("CARGO_PKG_VERSION") }
                }),
            ),
            "tools/list" => reply(&mut stdout, &id, json!({ "tools": tools() })),
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
