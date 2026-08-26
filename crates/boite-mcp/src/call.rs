//! One tool call, from the name the agent used to the text it reads back.
//!
//! The refusals matter more than the successes. An agent that is told "not
//! found" goes looking in the wrong place, so each one here says which of the
//! two things a status code could have meant, and `refusable` passes the
//! endpoint's own sentence through instead of inventing a diagnosis.

use serde_json::{json, Value};

use crate::backend::Backend;
use crate::render::{
    format_acted, format_artifacts, format_browser_panes, format_drove, format_hits,
    format_moments, format_page_settled, format_projects, format_pulse, format_snapshot,
    format_todos, format_wait, format_whereami, format_worktree, prefix,
};
use crate::toon::Toon;
use crate::{encode_query, MAX_BRANCHES};

pub fn call_tool<B: Backend>(host: &B, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "todo_list" => {
            let out = host.send("GET", "/v1/todos", None)?;
            Ok(format_todos(host, &out))
        }
        "todo_add" => {
            // `text` is still read: a model that learnt the old single-field
            // shape from a cached tool list would otherwise get a refusal it
            // cannot act on, and the title is the same string either way.
            let title = args
                .get("title")
                .or_else(|| args.get("text"))
                .and_then(|v| v.as_str())
                .ok_or("todo_add needs a title")?;
            let description = args.get("description").and_then(|v| v.as_str());
            let out = host.send(
                "POST",
                "/v1/todos",
                Some(json!({ "title": title, "description": description })),
            )?;
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
        "whereami" => {
            let out = host.send("GET", "/v1/whereami", None)?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            Ok(format_whereami(&out))
        }
        "worktree_status" => {
            let out = host.send("GET", "/v1/worktree", None)?;
            Ok(format_worktree(&out))
        }
        // Verbatim JSON rather than TOON: this is the one answer whose shape is
        // the point, and an agent reading it is about to compare two lists
        // field by field.
        "workspace_snapshot" => {
            let out = host.send("GET", "/v1/snapshot", None)?;
            Ok(serde_json::to_string_pretty(&out).unwrap_or_else(|_| out.to_string()))
        }
        "workspace_timeline" => {
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(40);
            let mut path = format!("/v1/timeline?limit={limit}");
            if let Some(project) = args.get("project").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                path.push_str("&project=");
                path.push_str(&encode_query(project));
            }
            let out = host.send("GET", &path, None)?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            Ok(format_moments(&out))
        }
        "workspace_search" => {
            let needle = args.get("q").and_then(|v| v.as_str()).unwrap_or("").trim();
            if needle.is_empty() {
                return Err("say what to look for".into());
            }
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20);
            let path = format!(
                "/v1/search?limit={limit}&q={}",
                encode_query(needle)
            );
            let out = host.send("GET", &path, None)?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            Ok(format_hits(&out))
        }
        // Text, not TOON: it is what a screen said, and any framing around it
        // is one more thing between the agent and the line it is looking for.
        "terminal_transcript" => {
            let mut path = String::from("/v1/transcript?bytes=");
            path.push_str(&args.get("bytes").and_then(|v| v.as_u64()).unwrap_or(16_384).to_string());
            if let Some(id) = args.get("threadId").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                path.push_str("&threadId=");
                path.push_str(id);
            }
            let out = host.send("GET", &path, None)?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            let text = out.get("text").and_then(|v| v.as_str()).unwrap_or("");
            Ok(if text.is_empty() {
                "this terminal has printed nothing that was kept".to_string()
            } else {
                text.to_string()
            })
        }
        "worktree_branch" => branch_call(host, args, "/v1/worktree/branch", "worktree_branch"),
        "worktree_reserve" => branch_call(host, args, "/v1/worktree/reserve", "worktree_reserve"),
        "artifacts_status" => {
            let out = host.send("GET", "/v1/artifacts", None)?;
            Ok(format_artifacts(&out))
        }
        "artifacts_set" => {
            let shared = args
                .get("shared")
                .and_then(|v| v.as_array())
                .ok_or("artifacts_set needs shared, the complete list of directories")?;
            // Forwarded as it came: every field is the endpoint's to validate,
            // and a name it refuses comes back as a sentence rather than as a
            // shape this shim guessed at.
            let out = refusable(host, "/v1/artifacts", json!({ "shared": shared }))?;
            let names: Vec<String> = shared
                .iter()
                .filter_map(|e| e.get("dir").and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect();
            let mut w = Toon::new();
            w.field("declared", out.get("file").and_then(|v| v.as_str()).unwrap_or("-"))
                .inline("shares", &names, MAX_BRANCHES)
                .hint("it applies to worktrees opened from now on, not to this one");
            Ok(w.into_string())
        }
        "projects_list" => {
            let out = host.send("GET", "/v1/projects", None)?;
            Ok(format_projects(&out))
        }
        "thread_move" => {
            let project = args
                .get("project")
                .and_then(|v| v.as_str())
                .ok_or("thread_move needs a project")?;
            let out = refusable(
                host,
                "/v1/thread/move",
                json!({ "project": project, "note": args.get("note").and_then(|v| v.as_str()) }),
            )?;
            if let Some(waiting) = awaiting(&out) {
                return Ok(waiting);
            }
            let name = out.get("project").and_then(|v| v.as_str()).unwrap_or(project);
            // Written for a reader that will almost certainly never exist: the
            // terminal goes down before an agent gets to read it. Worth the
            // three fields anyway, for a move that fails late enough that this
            // stays on screen.
            let mut w = Toon::new();
            w.field("moving-to", name)
                .field("terminal", "restarting there")
                .hint("your next turn happens in the new folder, with this conversation resumed");
            Ok(w.into_string())
        }
        "project_create" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or("project_create needs a name")?;
            let mut body = json!({ "name": name });
            // Forwarded only when given, so the endpoint's own defaults apply
            // rather than being overwritten with nulls.
            for key in ["path", "parent", "note"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                    body[key] = json!(v);
                }
            }
            for key in ["adopt", "git", "move"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_bool()) {
                    body[key] = json!(v);
                }
            }
            let moving = args.get("move").and_then(|v| v.as_bool()).unwrap_or(true);
            let out = refusable(host, "/v1/projects", body)?;
            if let Some(waiting) = awaiting(&out) {
                return Ok(waiting);
            }
            let mut w = Toon::new();
            w.field("creating", name).flag("moves-this-terminal", moving);
            if moving {
                w.hint("your next turn happens in the new folder, with this conversation resumed");
            }
            Ok(w.into_string())
        }
        "thread_spawn" => {
            let mut body = json!({});
            for key in ["agent", "project", "prompt"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                    body[key] = json!(v);
                }
            }
            let out = refusable(host, "/v1/threads", body)?;
            if let Some(waiting) = awaiting(&out) {
                return Ok(waiting);
            }
            let id = out.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
            let mut w = Toon::new();
            w.field("opened", args.get("agent").and_then(|v| v.as_str()).unwrap_or("agent"))
                .field("threadId", id)
                .hint("terminal_transcript threadId=<id> reads what it printed; thread_wait waits for it");
            Ok(w.into_string())
        }
        "thread_close" => {
            let id = args
                .get("threadId")
                .and_then(|v| v.as_str())
                .ok_or("thread_close needs a threadId")?;
            let out = refusable(host, "/v1/thread/close", json!({ "threadId": id }))?;
            if let Some(waiting) = awaiting(&out) {
                return Ok(waiting);
            }
            let mut w = Toon::new();
            w.field("closed", id);
            Ok(w.into_string())
        }
        "thread_wait" => {
            let id = args
                .get("threadId")
                .and_then(|v| v.as_str())
                .ok_or("thread_wait needs a threadId")?;
            let mut path = format!("/v1/thread/wait?threadId={}", crate::encode_query(id));
            if let Some(ms) = args.get("timeoutMs").and_then(|v| v.as_u64()) {
                path.push_str(&format!("&timeoutMs={ms}"));
            }
            let out = host.send("GET", &path, None)?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            Ok(format_wait(&out))
        }
        "workspace_pulse" => {
            let mut path = String::from("/v1/pulse?");
            if let Some(seq) = args.get("sinceSeq").and_then(|v| v.as_i64()) {
                path.push_str(&format!("sinceSeq={seq}&"));
            }
            let timeout_ms = args
                .get("timeoutMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(30_000);
            path.push_str(&format!("timeoutMs={timeout_ms}"));
            if let Some(p) = args.get("project").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                path.push_str("&project=");
                path.push_str(&encode_query(p));
            }
            // The socket's patience sits above the endpoint's hold, so a full
            // wait comes back as `timedOut: true` and never as a dead door.
            let out = host.send_long("GET", &path, None, timeout_ms / 1000 + 15)?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            Ok(format_pulse(&out))
        }
        "say" => {
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or("say needs text")?;
            let mut body = json!({ "text": text });
            for key in ["aloud", "urgency"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                    body[key] = json!(v);
                }
            }
            let out = host.send("POST", "/v1/say", Some(body))?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            let mut w = Toon::new();
            w.field("said", out.get("messageId").and_then(|v| v.as_str()).unwrap_or("?"));
            Ok(w.into_string())
        }
        "thread_dispatch" => {
            let to = args
                .get("threadId")
                .and_then(|v| v.as_str())
                .ok_or("thread_dispatch needs a threadId")?;
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or("thread_dispatch needs text")?;
            let mut body = json!({ "toThreadId": to, "text": text });
            if let Some(mode) = args.get("mode").and_then(|v| v.as_str()) {
                body["mode"] = json!(mode);
            }
            let out = host.send("POST", "/v1/dispatch", Some(body))?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            let mut w = Toon::new();
            w.field("queued", out.get("dispatchId").and_then(|v| v.as_str()).unwrap_or("?"))
                .field("to", to)
                .hint("the pulse says what became of it: dispatch.settled with delivered, dropped or refused");
            Ok(w.into_string())
        }
        "thread_dismiss" => {
            let id = args
                .get("threadId")
                .and_then(|v| v.as_str())
                .ok_or("thread_dismiss needs a threadId")?;
            let out = host.send("POST", "/v1/thread/dismiss", Some(json!({ "threadId": id })))?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            let mut w = Toon::new();
            w.field("dismissed", id);
            Ok(w.into_string())
        }
        "pane_open" => {
            let mut body = json!({});
            for key in ["kind", "url", "side", "path"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                    body[key] = json!(v);
                }
            }
            refusable(host, "/v1/pane/open", body)?;
            let mut w = Toon::new();
            w.field("opened", args.get("kind").and_then(|v| v.as_str()).unwrap_or("pane"));
            if let Some(url) = args.get("url").and_then(|v| v.as_str()) {
                w.field("url", url);
            }
            w.hint("the user sees it now; you cannot read what is in it, and a page off this machine waits on them agreeing to it");
            Ok(w.into_string())
        }
        "browser" => browser_call(host, args),
        "browser_status" => {
            let out = host.send("GET", "/v1/browser", None)?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            Ok(format_browser_panes(&out))
        }
        "browser_wait_for" => {
            let mut path = String::from("/v1/browser/wait?");
            if let Some(ms) = args.get("timeoutMs").and_then(|v| v.as_u64()) {
                path.push_str(&format!("timeoutMs={ms}&"));
            }
            if let Some(id) = args.get("paneId").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                path.push_str("paneId=");
                path.push_str(&encode_query(id));
            }
            let out = host.send("GET", &path, None)?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            Ok(format_page_settled(&out))
        }
        "browser_navigate" => {
            let url = args
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or("browser_navigate needs a url")?;
            let mut body = json!({ "url": url });
            if let Some(id) = args.get("paneId").and_then(|v| v.as_str()) {
                body["paneId"] = json!(id);
            }
            let out = refusable(host, "/v1/browser/navigate", body)?;
            Ok(format_drove(&out, "pointed", Some(url)))
        }
        "browser_reload" | "browser_close" => {
            let (path, done) = if name == "browser_reload" {
                ("/v1/browser/reload", "reloading")
            } else {
                ("/v1/browser/close", "closed")
            };
            let mut body = json!({});
            if let Some(id) = args.get("paneId").and_then(|v| v.as_str()) {
                body["paneId"] = json!(id);
            }
            let out = refusable(host, path, body)?;
            Ok(format_drove(&out, done, None))
        }
        "browser_snapshot" => {
            let mut path = String::from("/v1/browser/snapshot?");
            if let Some(mode) = args.get("mode").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                path.push_str("mode=");
                path.push_str(&encode_query(mode));
                path.push('&');
            }
            if let Some(n) = args.get("maxChars").and_then(|v| v.as_u64()) {
                path.push_str(&format!("maxChars={n}&"));
            }
            if let Some(id) = args.get("paneId").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                path.push_str("paneId=");
                path.push_str(&encode_query(id));
            }
            let out = host.send("GET", &path, None)?;
            if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            Ok(format_snapshot(&out))
        }
        "browser_click" | "browser_type" | "browser_press" | "browser_scroll" => {
            let path = match name {
                "browser_click" => "/v1/browser/click",
                "browser_type" => "/v1/browser/type",
                "browser_press" => "/v1/browser/press",
                _ => "/v1/browser/scroll",
            };
            // Forwarded field by field rather than wholesale: the endpoint owns
            // what each verb takes, and a key it never heard of should not ride
            // along just because a model invented it.
            let mut body = json!({});
            for key in ["uid", "text", "key", "paneId"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                    body[key] = json!(v);
                }
            }
            for key in ["double", "clear", "submit"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_bool()) {
                    body[key] = json!(v);
                }
            }
            if let Some(dy) = args.get("dy").and_then(|v| v.as_f64()) {
                body["dy"] = json!(dy);
            }
            let out = refusable(host, path, body)?;
            Ok(format_acted(&out, name.trim_start_matches("browser_")))
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

fn browser_call<B: Backend>(host: &B, args: &Value) -> Result<String, String> {
    let action = args
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("browser needs an action")?;
    let name = match action {
        "status" => "browser_status",
        "snapshot" => "browser_snapshot",
        "screenshot" => {
            return Err("use the image result of action=screenshot; this text path is unused".into())
        }
        "click" => "browser_click",
        "type" => "browser_type",
        "press" => "browser_press",
        "scroll" => "browser_scroll",
        "navigate" => "browser_navigate",
        "reload" => "browser_reload",
        "wait_for" => "browser_wait_for",
        "close" => "browser_close",
        other => return Err(format!("unknown browser action: {other}")),
    };
    call_tool(host, name, args)
}

/// The one tool whose answer is not text.
///
/// Kept out of [`call_tool`] so the text tools stay a `String` pipeline;
/// [`crate::rpc::answer`] asks here first and falls through. `Some(Ok(...))` is
/// a content array ready to go out as-is: a caption, then the PNG as an MCP
/// image block, which is what a vision-capable agent renders and reads.
pub fn call_blocks<B: Backend>(
    host: &B,
    name: &str,
    args: &Value,
) -> Option<Result<Value, String>> {
    let screenshot = name == "browser_screenshot"
        || (name == "browser"
            && args.get("action").and_then(|v| v.as_str()) == Some("screenshot"));
    if !screenshot {
        return None;
    }
    Some((|| {
        let mut path = String::from("/v1/browser/screenshot?");
        if let Some(uid) = args.get("uid").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            path.push_str("uid=");
            path.push_str(&encode_query(uid));
            path.push('&');
        }
        if let Some(id) = args.get("paneId").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            path.push_str("paneId=");
            path.push_str(&encode_query(id));
        }
        let out = host.send("GET", &path, None)?;
        if let Some(error) = out.get("error").and_then(|v| v.as_str()) {
            return Err(error.to_string());
        }
        let image = out
            .get("image")
            .and_then(|v| v.as_str())
            .ok_or("the device answered without an image")?;
        let width = out.get("width").and_then(|v| v.as_u64()).unwrap_or(0);
        let height = out.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
        Ok(json!([
            { "type": "text", "text": format!("the pane as drawn, {width}x{height} png") },
            { "type": "image", "data": image, "mimeType": "image/png" }
        ]))
    })())
}

/// The `status` the endpoint answers with when a call is now the user's to
/// allow. Spelled here rather than imported: this shim links serde and the
/// identity crate, and one string is not worth a third dependency.
const AWAITING: &str = "awaiting-user";

/// The answer to a call that worked and is waiting on the user.
///
/// Not an `Err`, and that is the whole point. A tool result flagged as an error
/// is read as a failure: agents apologised for a call that had gone through,
/// then tried to reach the same thing another way, which is precisely what a
/// gate exists to stop. This says accepted, says who has it, and says the wait
/// is the normal path.
fn awaiting(out: &Value) -> Option<String> {
    if out.get("status").and_then(|v| v.as_str()) != Some(AWAITING) {
        return None;
    }
    let mut w = Toon::new();
    w.field("call", "accepted").field("state", "waiting-on-user");
    w.hint(out.get("note").and_then(|v| v.as_str()).unwrap_or(
        "it worked and the user has it in Boite; it runs on its own when they allow it. \
         Nothing failed, asking again changes nothing, and there is no other way round it",
    ));
    Some(w.into_string())
}

/// A POST whose refusals arrive as a 200 carrying an `error`.
///
/// The endpoint answers that way whenever the reason is the agent's to act on —
/// a project that does not exist, a name that matches two of them. A transport
/// failure is something else and stays a transport failure.
fn refusable<B: Backend>(host: &B, path: &str, body: Value) -> Result<Value, String> {
    let out = host.send("POST", path, Some(body))?;
    if let Some(err) = out.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(out)
}

/// Both branch tools take one name and answer the same three ways: it worked,
/// git would not, or this terminal has no worktree to put a branch on.
fn branch_call<B: Backend>(host: &B, args: &Value, path: &str, tool: &str) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Backend, IdCache};
    use std::cell::RefCell;
    use std::collections::HashMap;

    struct MapHost {
        replies: HashMap<String, Value>,
        posts: RefCell<Vec<(String, Value)>>,
        ids: IdCache,
    }

    impl MapHost {
        fn new(replies: HashMap<String, Value>) -> Self {
            Self {
                replies,
                posts: RefCell::new(Vec::new()),
                ids: IdCache::new(),
            }
        }
    }

    impl Backend for MapHost {
        fn send(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
            let key = format!("{method} {path}");
            if let Some(body) = body {
                self.posts.borrow_mut().push((path.to_string(), body));
            }
            self.replies
                .get(&key)
                .cloned()
                .or_else(|| {
                    self.replies
                        .iter()
                        .find(|(k, _)| path.starts_with(k.trim_start_matches("GET ").trim_start_matches("POST ")))
                        .map(|(_, v)| v.clone())
                })
                .ok_or_else(|| format!("no reply for {key}"))
        }

        fn remember(&self, short: &str, full: &str) {
            self.ids.remember(short, full);
        }

        fn full_id(&self, given: &str) -> String {
            self.ids.resolve(self, given)
        }
    }

    #[test]
    fn spawn_names_the_thread_and_does_not_say_unread() {
        let host = MapHost::new(HashMap::from([(
            "POST /v1/threads".into(),
            json!({ "ok": true, "threadId": "new-1" }),
        )]));
        let text = call_tool(&host, "thread_spawn", &json!({ "agent": "claude" })).unwrap();
        assert!(text.contains("threadId: new-1"), "{text}");
        assert!(!text.contains("cannot read its output"), "{text}");
        assert!(text.contains("terminal_transcript"), "{text}");
    }

    #[test]
    fn wait_reports_status() {
        let host = MapHost::new(HashMap::from([(
            "/v1/thread/wait".into(),
            json!({ "threadId": "new-1", "status": "ready", "live": false, "waitedMs": 0 }),
        )]));
        let text = call_tool(
            &host,
            "thread_wait",
            &json!({ "threadId": "new-1" }),
        )
        .unwrap();
        assert!(text.contains("status: ready"), "{text}");
        assert!(text.contains("live: false") || text.contains("live:"), "{text}");
    }

    #[test]
    fn whereami_is_toon() {
        let host = MapHost::new(HashMap::from([(
            "GET /v1/whereami".into(),
            json!({
                "thread": "t1",
                "project": "boite",
                "worktree": "/w/t1",
                "branch": "-",
                "detached": true
            }),
        )]));
        let text = call_tool(&host, "whereami", &json!({})).unwrap();
        assert!(text.contains("thread: t1"), "{text}");
        assert!(text.contains("project: boite"), "{text}");
        assert!(text.contains("detached: true"), "{text}");
    }

    #[test]
    fn pane_open_forwards_path() {
        let host = MapHost::new(HashMap::from([(
            "POST /v1/pane/open".into(),
            json!({ "ok": true }),
        )]));
        call_tool(
            &host,
            "pane_open",
            &json!({ "kind": "editor", "path": "src/lib.rs" }),
        )
        .unwrap();
        let posts = host.posts.borrow();
        assert_eq!(posts[0].1["path"], json!("src/lib.rs"));
        assert_eq!(posts[0].1["kind"], json!("editor"));
    }

    #[test]
    fn unclaimed_spawn_is_not_success() {
        let host = MapHost::new(HashMap::from([(
            "POST /v1/threads".into(),
            json!({ "error": "no Boite device is connected, and the server cannot do this on its own: it means killing a      PTY and rearranging rows a client owns. Open Boite on a device and ask again." }),
        )]));
        let err = call_tool(&host, "thread_spawn", &json!({})).unwrap_err();
        assert!(err.contains("no Boite device"), "{err}");
    }
}
