//! One dev tool call, from the name the agent used to the text it reads back.
//!
//! The same shape as `crate::call`, and the refusals matter as much: an agent
//! told "not found" goes looking in the wrong place, so a bridge that is not
//! there says the window is down rather than that the call failed.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::render::format_log_records;
use crate::toon::Toon;

use super::bridge::Bridge;
use super::window::{Phase, DEV_WINDOW_TITLE};
use super::{db, paths, Dev};

pub fn call_dev_tool(dev: &Dev, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "dev_window" => window_call(dev, args),
        "dev_inspect" => inspect_call(args),
        "dev_drive" => drive_call(args),
        "dev_logs" => logs_call(args),
        "dev_db" => {
            let sql = args
                .get("sql")
                .and_then(|v| v.as_str())
                .ok_or("dev_db needs sql")?;
            db::query(sql)
        }
        "dev_scenario" => scenario_call(dev, args),
        other => Err(format!("unknown tool: {other}")),
    }
}

fn window_call(dev: &Dev, args: &Value) -> Result<String, String> {
    let action = args
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("status");
    let fresh = args.get("fresh").and_then(|v| v.as_bool()).unwrap_or(false);
    let env = env_arg(args)?;
    let mut window = dev
        .window
        .lock()
        .map_err(|_| "the dev window state is poisoned; restart the server".to_string())?;

    match action {
        "status" => {
            let phase = window.phase();
            let mut w = Toon::new();
            w.field("state", phase.as_str());
            if let Some(pid) = window.pid() {
                w.field("pid", &pid.to_string());
            }
            if let Some(ms) = window.elapsed_ms() {
                w.field("elapsedMs", &ms.to_string());
            }
            w.field("repo", &window.repo().display().to_string());
            w.field("port", &window.port().to_string());
            if phase == Phase::Building {
                let tail: Vec<String> = window.recent_output().into_iter().rev().take(8).collect();
                w.inline("building", &tail.into_iter().rev().collect::<Vec<_>>(), 8);
            }
            if phase == Phase::Down {
                w.hint("dev_window action=start; the first start compiles the app and takes minutes");
            }
            Ok(w.into_string())
        }
        "start" | "restart" => {
            if action == "restart" {
                window.stop();
            }
            let wiped = if fresh { window.wipe_database()? } else { Vec::new() };
            let report = window.start(&env)?;
            let mut w = Toon::new();
            w.field("state", "up")
                .field("pid", &report.pid.to_string())
                .field("bridgePort", &report.bridge_port.to_string())
                .field("vitePortMs", &report.vite_ms.to_string())
                .field("elapsedMs", &report.total_ms.to_string());
            if !wiped.is_empty() {
                w.inline("wiped", &wiped, 4);
            }
            Ok(w.into_string())
        }
        "stop" => {
            let report = window.stop();
            let mut w = Toon::new();
            w.field("state", "down");
            match report.pid {
                Some(pid) => {
                    w.field("pid", &pid.to_string());
                    w.flag("survived", report.survived);
                }
                None => {
                    w.field("pid", "-");
                    w.hint("nothing was running; this server only ever stops what it started");
                }
            }
            Ok(w.into_string())
        }
        other => Err(format!(
            "action is start, stop, status or restart, not {other}"
        )),
    }
}

/// `list` or `run`, against the repo `--repo` named.
///
/// The lock is taken to read the repo and to see whether this shim is holding
/// a window, then dropped: a run is twenty minutes, and holding the mutex
/// across it would make `dev_window action=status` hang rather than answer.
fn scenario_call(dev: &Dev, args: &Value) -> Result<String, String> {
    let action = args
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("list");
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty());
    let (repo, window_up) = {
        let mut window = dev
            .window
            .lock()
            .map_err(|_| "the dev window state is poisoned; restart the server".to_string())?;
        let up = window.phase() != Phase::Down;
        (window.repo().to_path_buf(), up)
    };
    match action {
        "list" => super::scenario::list_call(&repo),
        "run" => {
            if window_up {
                return Err(
                    "a run starts its own window on port 1430 and this session is holding one; \
                     dev_window action=stop first"
                        .into(),
                );
            }
            super::scenario::run_call(&repo, name)
        }
        other => Err(format!("action is list or run, not {other}")),
    }
}

/// `env` as the map the spawn takes. A non-string value is refused rather than
/// stringified: an environment is text, and `{"PORT": 1430}` meaning `"1430"`
/// is a guess that would be wrong the one time it mattered.
fn env_arg(args: &Value) -> Result<BTreeMap<String, String>, String> {
    let mut env = BTreeMap::new();
    let Some(object) = args.get("env").and_then(|v| v.as_object()) else {
        return Ok(env);
    };
    for (key, value) in object {
        let text = value
            .as_str()
            .ok_or_else(|| format!("env.{key} is not a string"))?;
        env.insert(key.clone(), text.to_string());
    }
    Ok(env)
}

/// One `window.__boite.*()` call, rendered as the JSON the inspector returns.
fn inspect_call(args: &Value) -> Result<String, String> {
    let what = args
        .get("what")
        .and_then(|v| v.as_str())
        .unwrap_or("overview");
    let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let tail = args.get("tail").and_then(|v| v.as_u64());
    let script = inspector_script(what, id, tail)?;
    let mut bridge = connect()?;
    let answer = bridge.execute_js(&script)?;
    Ok(serde_json::to_string_pretty(&answer).unwrap_or_else(|_| answer.to_string()))
}

/// The JavaScript for one `what`.
///
/// Built here rather than in the caller so it can be tested without a window:
/// the argument shapes are `inspect.ts`'s, and a call written with the wrong
/// arity comes back as `undefined` rather than as an error.
pub fn inspector_script(what: &str, id: &str, tail: Option<u64>) -> Result<String, String> {
    let quoted = json!(id).to_string();
    let call = match what {
        "overview" => "overview()".to_string(),
        "projects" => "projects()".to_string(),
        "threads" if id.is_empty() => "threads()".to_string(),
        "threads" => format!("threads({quoted})"),
        "thread" => {
            if id.is_empty() {
                return Err("dev_inspect what=thread needs an id or a label".into());
            }
            format!("thread({quoted})")
        }
        "read" => {
            if id.is_empty() {
                return Err("dev_inspect what=read needs a thread id or label".into());
            }
            match tail {
                Some(n) => format!("read({quoted}, {n})"),
                None => format!("read({quoted})"),
            }
        }
        "mounted" => "mounted()".to_string(),
        "toasts" => match tail {
            Some(n) => format!("toasts({n})"),
            None => "toasts()".to_string(),
        },
        "panes" => "panes()".to_string(),
        "settings" => "settings()".to_string(),
        other => {
            return Err(format!(
                "what is overview, projects, threads, thread, read, mounted, toasts, panes or settings, not {other}"
            ))
        }
    };
    Ok(format!(
        "if (!window.__boite) {{ throw new Error('window.__boite is not there: this is not a dev build'); }} return window.__boite.{call};"
    ))
}

fn drive_call(args: &Value) -> Result<String, String> {
    let action = args
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("dev_drive needs an action")?;
    let selector = args.get("selector").and_then(|v| v.as_str()).unwrap_or("");
    let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");

    match action {
        "screenshot" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .filter(|p| !p.is_empty())
                .ok_or("dev_drive action=screenshot needs a path to write the PNG to")?;
            let mut bridge = connect()?;
            let bytes = bridge.screenshot(None)?;
            let path = std::path::PathBuf::from(path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot make {}: {e}", parent.display()))?;
            }
            std::fs::write(&path, &bytes)
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            let mut w = Toon::new();
            w.field("wrote", &path.display().to_string())
                .field("bytes", &bytes.len().to_string())
                .hint("the terminals are a WebGL canvas and photograph blank; dev_inspect what=read is their text");
            Ok(w.into_string())
        }
        "eval" => {
            let script = args
                .get("script")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .ok_or("dev_drive action=eval needs a script")?;
            let mut bridge = connect()?;
            let answer = bridge.execute_js(script)?;
            Ok(serde_json::to_string_pretty(&answer).unwrap_or_else(|_| answer.to_string()))
        }
        "click" | "type" | "press" => {
            let script = drive_script(action, selector, text, args.get("key").and_then(|v| v.as_str()).unwrap_or(""))?;
            let mut bridge = connect()?;
            let answer = bridge.execute_js(&script)?;
            let mut w = Toon::new();
            w.field("did", action);
            if answer.get("found").and_then(|v| v.as_bool()) == Some(false) {
                return Err(answer
                    .get("why")
                    .and_then(|v| v.as_str())
                    .unwrap_or("nothing matched")
                    .to_string());
            }
            if let Some(on) = answer.get("on").and_then(|v| v.as_str()) {
                w.field("on", on);
            }
            Ok(w.into_string())
        }
        other => Err(format!(
            "action is click, type, press, screenshot or eval, not {other}"
        )),
    }
}

/// The JavaScript one drive action runs.
///
/// Each answers `{found, on}` or `{found: false, why}`: a click that hit
/// nothing has to be a refusal an agent reads, not a silent success it builds
/// three more calls on top of.
pub fn drive_script(action: &str, selector: &str, text: &str, key: &str) -> Result<String, String> {
    let selector_json = json!(selector).to_string();
    let text_json = json!(text).to_string();
    match action {
        "click" => {
            if selector.is_empty() && text.is_empty() {
                return Err("dev_drive action=click needs a selector or a text".into());
            }
            Ok(format!(
                "const sel = {selector_json}; const label = {text_json};\n\
                 let el = sel ? document.querySelector(sel) : null;\n\
                 if (!el && label) {{\n\
                   const candidates = Array.from(document.querySelectorAll('button, a, [role=\"button\"], [role=\"menuitem\"], [role=\"tab\"], summary, label'));\n\
                   el = candidates.find((c) => (c.textContent || '').trim() === label)\n\
                     || candidates.find((c) => (c.textContent || '').trim().includes(label))\n\
                     || document.querySelector('[aria-label=\"' + label.replace(/\"/g, '\\\\\"') + '\"]');\n\
                 }}\n\
                 if (!el) return {{ found: false, why: 'nothing matches ' + (sel || label) }};\n\
                 el.scrollIntoView({{ block: 'center' }});\n\
                 el.click();\n\
                 return {{ found: true, on: (el.tagName || '').toLowerCase() + (el.id ? '#' + el.id : '') }};"
            ))
        }
        "type" => {
            if selector.is_empty() {
                return Err("dev_drive action=type needs a selector".into());
            }
            // The native value setter, then an `input` event: a framework that
            // tracks the field reads the property it installed, and a plain
            // `el.value = x` never reaches it.
            Ok(format!(
                "const el = document.querySelector({selector_json});\n\
                 if (!el) return {{ found: false, why: 'nothing matches {0}' }};\n\
                 el.focus();\n\
                 const value = {text_json};\n\
                 if (el.isContentEditable) {{ el.textContent = value; }} else {{\n\
                   const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;\n\
                   const setter = Object.getOwnPropertyDescriptor(proto, 'value');\n\
                   if (setter && setter.set) {{ setter.set.call(el, value); }} else {{ el.value = value; }}\n\
                 }}\n\
                 el.dispatchEvent(new Event('input', {{ bubbles: true }}));\n\
                 el.dispatchEvent(new Event('change', {{ bubbles: true }}));\n\
                 return {{ found: true, on: (el.tagName || '').toLowerCase() }};",
                selector.replace('\'', "\\'")
            ))
        }
        "press" => {
            if key.is_empty() {
                return Err("dev_drive action=press needs a key".into());
            }
            let key_json = json!(key).to_string();
            Ok(format!(
                "const key = {key_json};\n\
                 const el = document.activeElement || document.body;\n\
                 for (const type of ['keydown', 'keypress', 'keyup']) {{\n\
                   el.dispatchEvent(new KeyboardEvent(type, {{ key, bubbles: true, cancelable: true }}));\n\
                 }}\n\
                 return {{ found: true, on: (el.tagName || '').toLowerCase() }};"
            ))
        }
        other => Err(format!("no drive script for {other}")),
    }
}

/// The dev instance's log directory, read as files.
///
/// Both actions read files here, unlike the `logs` tool of a running boite:
/// the ring is in the window's process, which is not this one, and a `tail`
/// that answered this shim's own memory would answer about the wrong host.
fn logs_call(args: &Value) -> Result<String, String> {
    let action = args
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("query");
    if !matches!(action, "tail" | "query") {
        return Err("action is tail or query".into());
    }
    let dir = paths::dev_log_dir()?;
    let default_limit = if action == "tail" { 50 } else { 100 };
    let query = boite_core::log::Query {
        since: args.get("since").and_then(|v| v.as_u64()),
        until: args.get("until").and_then(|v| v.as_u64()),
        level: string_arg(args, "level"),
        host: string_arg(args, "host"),
        thread: string_arg(args, "thread"),
        turn: string_arg(args, "turn"),
        target: string_arg(args, "target"),
        text: string_arg(args, "text"),
        limit: Some(
            args.get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(default_limit)
                .clamp(1, 1000) as usize,
        ),
    };
    if !dir.is_dir() {
        let mut w = Toon::new();
        w.field("records", "none").hint(&format!(
            "{} does not exist yet: the dev window has not logged anything",
            dir.display()
        ));
        return Ok(w.into_string());
    }
    let records = boite_core::log::query_in(&dir, &query);
    let value = json!({ "records": records });
    Ok(format_log_records(&value))
}

fn string_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A bridge, or the sentence saying the window is not up.
fn connect() -> Result<Bridge, String> {
    Bridge::discover(DEV_WINDOW_TITLE).map_err(|why| {
        format!("the dev window is not answering ({why}); dev_window action=status says where it is")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_what_calls_the_inspector_with_the_arity_it_declares() {
        assert!(inspector_script("overview", "", None)
            .expect("overview")
            .contains("__boite.overview()"));
        assert!(inspector_script("threads", "", None)
            .expect("threads")
            .contains("__boite.threads()"));
        assert!(inspector_script("threads", "p1", None)
            .expect("threads")
            .contains("__boite.threads(\"p1\")"));
        assert!(inspector_script("read", "Claude #1", Some(40))
            .expect("read")
            .contains("__boite.read(\"Claude #1\", 40)"));
        assert!(inspector_script("toasts", "", Some(5))
            .expect("toasts")
            .contains("__boite.toasts(5)"));
    }

    /// A label with a quote in it would end the string and run whatever came
    /// after; the name goes through `serde_json` for exactly that reason.
    #[test]
    fn a_label_is_escaped_rather_than_pasted() {
        let script = inspector_script("thread", "he said \"hi\"", None).expect("thread");
        assert!(script.contains(r#"thread("he said \"hi\"")"#), "{script}");
    }

    #[test]
    fn the_calls_that_need_a_name_refuse_without_one() {
        assert!(inspector_script("thread", "", None).is_err());
        assert!(inspector_script("read", "", None).is_err());
        assert!(inspector_script("nonsense", "", None).is_err());
    }

    /// Every script is a function body for the bridge's wrapper, so it has to
    /// return, and it has to say the inspector is missing rather than throw a
    /// `TypeError` an agent cannot act on.
    #[test]
    fn every_script_returns_and_names_a_missing_inspector() {
        let script = inspector_script("overview", "", None).expect("overview");
        assert!(script.contains("return window.__boite."));
        assert!(script.contains("not a dev build"));
    }

    #[test]
    fn a_drive_action_needs_what_it_acts_on() {
        assert!(drive_script("click", "", "", "").is_err());
        assert!(drive_script("type", "", "hello", "").is_err());
        assert!(drive_script("press", "", "", "").is_err());
        assert!(drive_script("click", "#new", "", "").is_ok());
        assert!(drive_script("click", "", "New project", "").is_ok());
    }

    #[test]
    fn a_click_that_matches_nothing_answers_a_refusal_the_caller_can_read() {
        let script = drive_script("click", "#nope", "", "").expect("click");
        assert!(script.contains("found: false"), "{script}");
        assert!(script.contains("nothing matches"), "{script}");
    }

    #[test]
    fn typing_goes_through_the_native_setter_so_a_framework_sees_it() {
        let script = drive_script("type", "input", "hello", "").expect("type");
        assert!(script.contains("getOwnPropertyDescriptor"), "{script}");
        assert!(script.contains("new Event('input'"), "{script}");
    }

    #[test]
    fn a_key_is_sent_as_the_three_events_a_field_listens_for() {
        let script = drive_script("press", "", "", "Enter").expect("press");
        assert!(script.contains("keydown"));
        assert!(script.contains("keyup"));
        assert!(script.contains("\"Enter\""), "{script}");
    }
}
