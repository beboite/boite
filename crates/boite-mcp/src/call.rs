//! One tool call, from the name the agent used to the text it reads back.
//!
//! The refusals matter more than the successes. An agent that is told "not
//! found" goes looking in the wrong place, so each one here says which of the
//! two things a status code could have meant, and `refusable` passes the
//! endpoint's own sentence through instead of inventing a diagnosis.

use serde_json::{json, Value};

use crate::host::Host;
use crate::render::{
    format_acted, format_artifacts, format_browser_panes, format_drove, format_hits,
    format_moments, format_page_settled, format_projects, format_snapshot, format_todos,
    format_worktree, prefix,
};
use crate::toon::Toon;
use crate::{encode_query, MAX_BRANCHES};

pub(crate) fn call_tool(host: &Host, name: &str, args: &Value) -> Result<String, String> {
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
            let mut w = Toon::new();
            w.field("opened", args.get("agent").and_then(|v| v.as_str()).unwrap_or("agent"))
                .hint("it runs on its own: no report back, and you cannot read its output");
            Ok(w.into_string())
        }
        "pane_open" => {
            let mut body = json!({});
            for key in ["kind", "url", "side"] {
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

/// The one tool whose answer is not text.
///
/// Kept out of [`call_tool`] so the text tools stay a `String` pipeline;
/// `main.rs` asks here first and falls through. `Some(Ok(...))` is a content
/// array ready to go out as-is: a caption, then the PNG as an MCP image
/// block, which is what a vision-capable agent renders and reads.
pub(crate) fn call_blocks(host: &Host, name: &str, args: &Value) -> Option<Result<Value, String>> {
    if name != "browser_screenshot" {
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
fn refusable(host: &Host, path: &str, body: Value) -> Result<Value, String> {
    let out = host.send("POST", path, Some(body))?;
    if let Some(err) = out.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(out)
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
