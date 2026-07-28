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
//!
//! Everything it says goes out in TOON (`toon.rs`) rather than JSON. The tool
//! list is paid for in every session that connects, and each answer is paid for
//! again in the context window that reads it, so both are written to be short:
//! one line per tool, one row per todo, and ids shortened to the prefix that
//! still distinguishes them.

mod http;
mod toon;

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, Write};

use serde_json::{json, Value};

use http::Endpoint;

use toon::{clip, Toon};

/// Newest version this speaks. A client asking for an older one gets that one
/// back — the shape of these five tools has not changed across any of them, and
/// answering with a version the client did not offer ends the handshake.
const LATEST_PROTOCOL: &str = "2025-06-18";
const SUPPORTED_PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// A todo's text is one line by convention and a pasted paragraph in practice.
const MAX_CELL: usize = 200;
/// Branch lists grow without bound in a long-lived repository; the agent needs
/// the naming convention and the few most recent, not all of them.
const MAX_BRANCHES: usize = 40;

struct Host {
    endpoint: Endpoint,
    token: String,
    /// The thread this shim was spawned for, when Boite launched the agent.
    thread_id: Option<String>,
    /// The project, when credentials came from a file instead. Agents that do
    /// not pass their environment to a server process can only be reached this
    /// way — the endpoint takes either, and resolves both to one project.
    project_id: Option<String>,
    /// Which agent this is, when the registration said so. Only ever used to
    /// put the right badge on a claim; it grants nothing.
    agent: Option<String>,
    /// Short id to full id, filled by every listing. The process lives as long
    /// as the agent does, so a claim can quote the eight characters it was
    /// shown instead of a full uuid. Single-threaded loop, hence `RefCell`.
    ids: RefCell<HashMap<String, String>>,
}

#[derive(serde::Deserialize)]
struct Credentials {
    url: String,
    token: String,
    #[serde(rename = "projectId")]
    project_id: String,
}

/// Percent-encodes a path so it survives as an HTTP header value.
///
/// A header value is visible ASCII, and a directory is not: an accented path
/// would fail the whole request rather than just the lookup it feeds. Encoding
/// beats skipping the header on those paths, which would have left exactly the
/// users with non-ASCII directories on the old per-project behaviour.
fn encode_header_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

impl Host {
    /// Environment first, then the credentials file named on the command line.
    ///
    /// The environment is what Boite stamps into a terminal it launched, and it
    /// carries the thread — the most precise answer. The file exists for agents
    /// that hand a server process nothing but PATH, where the environment can
    /// never arrive; it names a project instead, which is the unit the list
    /// belongs to anyway.
    fn resolve() -> Result<Host, String> {
        if let (Ok(url), Ok(token), Ok(thread_id)) = (
            std::env::var("BOITE_MCP_URL"),
            std::env::var("BOITE_TOKEN"),
            std::env::var("BOITE_THREAD_ID"),
        ) {
            return Ok(Host {
                endpoint: Endpoint::parse(&url)?,
                token,
                thread_id: Some(thread_id),
                project_id: None,
                // The thread names the agent better than any argument could:
                // Boite launched it and knows what it is.
                agent: None,
                ids: RefCell::new(HashMap::new()),
            });
        }

        let path = std::env::args().nth(1).ok_or_else(|| {
            "no Boite credentials: run this from a Boite terminal, or pass the \
             credentials file the Todo panel offers"
                .to_string()
        })?;
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read credentials at {path}: {e}"))?;
        let creds: Credentials =
            serde_json::from_str(&text).map_err(|e| format!("bad credentials file: {e}"))?;
        // The Todo panel writes the agent's own name into the line it offers,
        // because it knows which row the button was under. Without it a claim
        // arrives from "some agent" and the list can only show a generic mark.
        let agent = std::env::args().nth(2).filter(|s| !s.is_empty());
        Ok(Host {
            endpoint: Endpoint::parse(&creds.url)?,
            token: creds.token,
            thread_id: None,
            project_id: Some(creds.project_id),
            agent,
            ids: RefCell::new(HashMap::new()),
        })
    }

    fn send(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let auth = format!("Bearer {}", self.token);
        // Only ever alongside a project: a thread already names one exactly.
        // Bound before the header list so it outlives the borrows in it.
        let cwd = self.project_id.as_ref().and_then(|_| {
            std::env::current_dir()
                .ok()
                .and_then(|p| p.to_str().map(encode_header_path))
        });
        let mut headers: Vec<(&str, &str)> = vec![("Authorization", &auth)];
        if let Some(thread) = &self.thread_id {
            headers.push(("x-boite-thread", thread));
        }
        if let Some(project) = &self.project_id {
            headers.push(("x-boite-project", project));
        }
        // What lets one registration serve every project: the file names the
        // project it was made from, this names the one the agent is actually
        // in. The endpoint decides whether any project claims it.
        if let Some(cwd) = &cwd {
            headers.push(("x-boite-cwd", cwd));
        }
        if let Some(agent) = &self.agent {
            headers.push(("x-boite-agent", agent));
        }
        let body = body.map(|b| b.to_string().into_bytes());
        let res = self.endpoint.send(method, path, &headers, body)?;
        let status = res.status;
        if status == 409 {
            // The endpoint refuses without saying which reason applied; say the
            // same here rather than inventing a diagnosis. The two routes mean
            // different things by it, and telling an agent its todo is closed
            // when the real answer is "you have no worktree" sends it looking
            // in the wrong place entirely.
            return Err(if path.starts_with("/v1/worktree") {
                "this terminal has no worktree: it runs directly in the project folder, \
                 so branches here are the user's to make"
                    .into()
            } else {
                "that item is not open, or does not belong to this project".to_string()
            });
        }
        if !(200..300).contains(&status) {
            return Err(format!("boite refused the call ({status})"));
        }
        serde_json::from_slice(&res.body).map_err(|e| format!("bad response: {e}"))
    }

    fn remember(&self, short: &str, full: &str) {
        self.ids
            .borrow_mut()
            .insert(short.to_string(), full.to_string());
    }

    /// The full id behind whatever the agent quoted.
    ///
    /// A short id it saw in a listing this process made resolves from memory. A
    /// short id it saw before a restart does not, so the list is fetched once
    /// and asked again — one extra round trip on a path that would otherwise
    /// fail with a refusal the agent cannot act on. Anything else goes through
    /// untouched: a full uuid out of a task prompt is already the answer.
    fn full_id(&self, given: &str) -> String {
        if let Some(full) = self.ids.borrow().get(given) {
            return full.clone();
        }
        if given.len() >= 32 {
            return given.to_string();
        }
        if let Ok(out) = self.send("GET", "/v1/todos", None) {
            index_todos(self, &out);
        }
        self.ids
            .borrow()
            .get(given)
            .cloned()
            .unwrap_or_else(|| given.to_string())
    }
}

/// The tool list, and the one place this shim spends tokens unconditionally:
/// every session that connects reads all of it before doing anything. Each
/// description says what the tool does and, where two tools are confusable,
/// which one the other case belongs to. Everything a failed call would explain
/// on its own is left to the failure.
fn tools() -> Value {
    json!([
        {
            "name": "todo_list",
            "description": "List this project's todos: short id, state, text, note.",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Todos", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "todo_add",
            "description": "Add one todo to this project's list.",
            "inputSchema": {
                "type": "object",
                "properties": { "text": { "type": "string", "description": "One line describing the task." } },
                "required": ["text"],
                "additionalProperties": false
            },
            "annotations": { "title": "Add todo", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "todo_claim",
            "description": "Report a todo as done. Does NOT tick it off: it moves to awaiting the \
                            user's confirmation, which only they can give.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Id from todo_list or from the task prompt; the short form works." },
                    "note": { "type": "string", "description": "One line on what changed." },
                    "commit": {
                        "type": "string",
                        "description": "Sha the work landed in, if it was committed. Resolved against \
                                        the repository, so one that does not exist reads as unknown — \
                                        omit rather than guess."
                    }
                },
                "required": ["id"],
                "additionalProperties": false
            },
            "annotations": { "title": "Claim todo", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "worktree_status",
            "description": "Where this terminal works: its own detached worktree of the project, \
                            isolated from the user's checkout and from other terminals, sharing one \
                            history. Reports path, repo, branch if one was taken, uncommitted \
                            changes, and the existing branches.",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Worktree", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "worktree_branch",
            "description": "Create a NEW branch for the work in this terminal. Call it once the work \
                            is worth keeping: until then detached leaves no trace, and the worktree \
                            is discarded when the thread closes. Fails if the name is taken — use \
                            worktree_reserve for a branch that exists.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Branch name, in the convention the repository already uses (see worktree_status)." }
                },
                "required": ["name"],
                "additionalProperties": false
            },
            "annotations": { "title": "New branch", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "worktree_reserve",
            "description": "Move this terminal onto a branch that ALREADY exists, to continue it. \
                            Git allows a branch in one worktree at a time, so this fails if another \
                            terminal or the user's checkout holds it; the error says which.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "An existing local branch." }
                },
                "required": ["name"],
                "additionalProperties": false
            },
            "annotations": { "title": "Take branch", "destructiveHint": false, "openWorldHint": false }
        }
    ])
}

/// The shortest prefix that still tells these ids apart. Uuids collide at eight
/// characters about as often as they collide outright, but a list is small and
/// checking costs nothing, so widen rather than hand out an ambiguous id.
fn short_width(ids: &[&str]) -> usize {
    for width in [8usize, 13, 18] {
        let mut seen: Vec<&str> = ids.iter().map(|id| prefix(id, width)).collect();
        let total = seen.len();
        seen.sort_unstable();
        seen.dedup();
        if seen.len() == total {
            return width;
        }
    }
    usize::MAX
}

fn prefix(id: &str, width: usize) -> &str {
    id.get(..width).unwrap_or(id)
}

/// Record every id in a listing under its short form, so a later claim can
/// quote what it was shown. Returns the width that was handed out.
fn index_todos(host: &Host, out: &Value) -> usize {
    let empty = Vec::new();
    let todos = out
        .get("todos")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let ids: Vec<&str> = todos
        .iter()
        .filter_map(|t| t.get("id").and_then(|v| v.as_str()))
        .collect();
    let width = short_width(&ids);
    for id in ids {
        host.remember(prefix(id, width), id);
    }
    width
}

fn format_todos(host: &Host, out: &Value) -> String {
    let empty = Vec::new();
    let todos = out
        .get("todos")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let width = index_todos(host, out);
    let str_at = |t: &Value, key: &str| {
        t.get(key)
            .and_then(|v| v.as_str())
            .map(|s| clip(s, MAX_CELL))
            .unwrap_or_default()
    };
    let rows: Vec<Vec<String>> = todos
        .iter()
        .map(|t| {
            let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            vec![
                prefix(id, width).to_string(),
                str_at(t, "state"),
                str_at(t, "text"),
                str_at(t, "note"),
            ]
        })
        .collect();

    // A column that says the same thing on every row, or nothing on any of
    // them, is paid for once per row and answers nothing. A list where every
    // item is still open — which is most lists — says so on one line instead.
    let uniform_state = rows
        .first()
        .map(|r| r[1].clone())
        .filter(|first| rows.iter().all(|r| &r[1] == first));
    let any_note = rows.iter().any(|r| !r[3].is_empty());
    let mut cols: Vec<&str> = vec!["id"];
    if uniform_state.is_none() {
        cols.push("state");
    }
    cols.push("text");
    if any_note {
        cols.push("note");
    }
    let rows: Vec<Vec<String>> = rows
        .into_iter()
        .map(|r| {
            let [id, state, text, note] = r.try_into().expect("four columns");
            let mut kept = vec![id];
            if uniform_state.is_none() {
                kept.push(state);
            }
            kept.push(text);
            if any_note {
                kept.push(note);
            }
            kept
        })
        .collect();

    let mut w = Toon::new();
    if let Some(state) = &uniform_state {
        w.field("state", &format!("{state} (every item)"));
    }
    w.table("todos", &cols, &rows);
    if rows.is_empty() {
        w.hint("nothing on this project's list: todo_add text=<one line>");
    } else {
        w.hint("todo_claim id=<id> note=<what changed> — the user confirms, not you");
    }
    w.into_string()
}

fn format_worktree(out: &Value) -> String {
    let string_at = |key: &str| out.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let branches: Vec<String> = out
        .get("branches")
        .and_then(|v| v.as_array())
        .map(|b| {
            b.iter()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let detached = out
        .get("detached")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let dirty = out
        .get("uncommittedChanges")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut w = Toon::new();
    w.field("path", string_at("path"))
        .field("repo", string_at("repo"))
        .field("branch", string_at("branch"))
        .flag("detached", detached)
        .flag("uncommitted", dirty)
        .inline("branches", &branches, MAX_BRANCHES);
    if detached {
        w.hint("worktree_branch name=<new> once the work is worth keeping");
    }
    w.into_string()
}

fn call_tool(host: &Host, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "todo_list" => {
            let out = host.send("GET", "/v1/todos", None)?;
            Ok(format_todos(host, &out))
        }
        "todo_add" => {
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or("todo_add needs a text")?;
            let out = host.send("POST", "/v1/todos", Some(json!({ "text": text })))?;
            let id = out.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let short = prefix(id, 8);
            host.remember(short, id);
            let mut w = Toon::new();
            w.field("added", short);
            Ok(w.into_string())
        }
        "todo_claim" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("todo_claim needs an id")?;
            let full = host.full_id(id);
            let note = args.get("note").and_then(|v| v.as_str());
            let commit = args.get("commit").and_then(|v| v.as_str());
            host.send(
                "POST",
                "/v1/todos/claim",
                Some(json!({ "id": full, "note": note, "commit": commit })),
            )?;
            let mut w = Toon::new();
            w.field("reported", prefix(&full, 8))
                .field("state", "awaiting-user");
            Ok(w.into_string())
        }
        "worktree_status" => {
            let out = host.send("GET", "/v1/worktree", None)?;
            Ok(format_worktree(&out))
        }
        "worktree_branch" => branch_call(host, args, "/v1/worktree/branch", "worktree_branch"),
        "worktree_reserve" => branch_call(host, args, "/v1/worktree/reserve", "worktree_reserve"),
        other => Err(format!("unknown tool: {other}")),
    }
}

/// Both branch tools take one name and answer the same three ways: it worked,
/// git would not, or this terminal has no worktree to put a branch on.
fn branch_call(host: &Host, args: &Value, path: &str, tool: &str) -> Result<String, String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{tool} needs a name"))?;
    let out = host.send("POST", path, Some(json!({ "name": name })))?;
    // The endpoint answers 200 with an `error` field for a refusal git made, so
    // the agent reads the reason and picks another name instead of seeing a
    // transport failure it cannot act on.
    if let Some(err) = out.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    let mut w = Toon::new();
    w.field("branch", name).field("terminal", "attached");
    Ok(w.into_string())
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
                        // Read once per session, and it saves every tool from
                        // repeating where it is running.
                        "instructions": "This terminal belongs to a Boite project: it has a shared \
                                         todo list and its own detached git worktree. Answers are \
                                         TOON — `key: value`, and `name(N):` followed by a header \
                                         row then one row per item."
                    }),
                )
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> Host {
        Host {
            endpoint: Endpoint::parse("http://127.0.0.1:1").unwrap(),
            token: "t".into(),
            thread_id: Some("thread".into()),
            project_id: None,
            agent: None,
            ids: RefCell::new(HashMap::new()),
        }
    }

    #[test]
    fn a_listing_costs_a_row_per_todo() {
        let h = host();
        let out = json!({ "todos": [
            { "id": "1a5f3698-27dc-4f9d-90e5-d732c50e839c", "projectId": "e7c778e0-6a14-4cfe-a7df-b9a2f5b04fc5",
              "text": "opti mcp axi", "state": "open", "note": null, "position": 0 },
            { "id": "596ce966-971c-4702-9040-1b1393ed8447", "projectId": "e7c778e0-6a14-4cfe-a7df-b9a2f5b04fc5",
              "text": "readme", "state": "claimed", "note": "done", "position": 1 }
        ]});
        assert_eq!(
            format_todos(&h, &out),
            "todos(2):\n  id state text note\n  1a5f3698 open \"opti mcp axi\" -\n  \
             596ce966 claimed readme done\nhint: todo_claim id=<id> note=<what changed> — the user confirms, not you\n"
        );
    }

    #[test]
    fn a_column_that_says_nothing_is_dropped() {
        let h = host();
        // Every item open, no note: two columns carry no information, and the
        // state they all share is worth one line rather than one cell per row.
        let out = json!({ "todos": [
            { "id": "1a5f3698-27dc-4f9d-90e5-d732c50e839c", "text": "opti mcp axi", "state": "open", "note": null },
            { "id": "596ce966-971c-4702-9040-1b1393ed8447", "text": "readme", "state": "open", "note": null }
        ]});
        assert_eq!(
            format_todos(&h, &out),
            concat!(
                "state: \"open (every item)\"\n",
                "todos(2):\n",
                "  id text\n",
                "  1a5f3698 \"opti mcp axi\"\n",
                "  596ce966 readme\n",
                "hint: todo_claim id=<id> note=<what changed> — the user confirms, not you\n",
            )
        );
    }

    #[test]
    fn an_empty_list_says_so_and_offers_the_next_call() {
        let h = host();
        let out = format_todos(&h, &json!({ "todos": [] }));
        assert!(out.starts_with("todos(0): empty\n"));
        assert!(out.contains("todo_add"));
    }

    #[test]
    fn short_ids_resolve_to_the_full_one() {
        let h = host();
        index_todos(
            &h,
            &json!({ "todos": [{ "id": "1a5f3698-27dc-4f9d-90e5-d732c50e839c" }] }),
        );
        assert_eq!(h.full_id("1a5f3698"), "1a5f3698-27dc-4f9d-90e5-d732c50e839c");
    }

    #[test]
    fn a_full_id_goes_through_untouched() {
        let h = host();
        // Nothing indexed, and no endpoint to ask: a uuid is already the answer,
        // so this must not depend on a round trip.
        assert_eq!(
            h.full_id("1a5f3698-27dc-4f9d-90e5-d732c50e839c"),
            "1a5f3698-27dc-4f9d-90e5-d732c50e839c"
        );
    }

    #[test]
    fn ids_sharing_a_prefix_widen_instead_of_colliding() {
        let ids = [
            "1a5f3698-27dc-4f9d-90e5-d732c50e839c",
            "1a5f3698-99dc-4f9d-90e5-000000000000",
        ];
        assert_eq!(short_width(&ids), 13);
        assert_eq!(short_width(&["1a5f3698-a", "596ce966-b"]), 8);
        // Ids that differ only in the last group: no prefix separates them, so
        // the full id is handed out rather than an ambiguous one.
        let twins = [
            "1a5f3698-27dc-4f9d-90e5-d732c50e839c",
            "1a5f3698-27dc-4f9d-90e5-000000000000",
        ];
        assert_eq!(short_width(&twins), usize::MAX);
        assert_eq!(prefix(twins[0], usize::MAX), twins[0]);
    }

    #[test]
    fn worktree_status_is_six_lines() {
        let out = json!({
            "path": "C:\\worktrees\\3506",
            "repo": "D:\\Dev\\Collab\\boite",
            "branch": null,
            "detached": true,
            "uncommittedChanges": false,
            "branches": ["master", "feat/x"]
        });
        let text = format_worktree(&out);
        assert!(text.contains("branch: -\n"), "{text}");
        assert!(text.contains("detached: true\n"), "{text}");
        assert!(text.contains("uncommitted: false\n"), "{text}");
        assert!(text.contains("branches(2): master feat/x\n"), "{text}");
        assert!(text.contains("hint: worktree_branch"), "{text}");
    }

    #[test]
    fn the_protocol_answers_what_the_client_offered() {
        assert_eq!(negotiate(&json!({ "protocolVersion": "2024-11-05" })), "2024-11-05");
        assert_eq!(negotiate(&json!({ "protocolVersion": "1999-01-01" })), LATEST_PROTOCOL);
        assert_eq!(negotiate(&json!({})), LATEST_PROTOCOL);
    }
}
