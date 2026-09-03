//! Turning an answer into the fewest tokens that still say it.
//!
//! Everything here writes TOON rather than JSON: one row per item, one header
//! row, no repeated keys. Ids are shortened to the prefix that still tells them
//! apart, and a column every row leaves empty is dropped rather than printed as
//! a wall of dashes.

use serde_json::Value;

use crate::backend::Backend;
use crate::toon::{clip, Toon};
use crate::{MAX_BRANCHES, MAX_CELL, MAX_PAGE_ELEMENTS, MAX_PAGE_TEXT};

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

pub(crate) fn prefix(id: &str, width: usize) -> &str {
    id.get(..width).unwrap_or(id)
}

/// Record every id in a listing under its short form, so a later claim can
/// quote what it was shown. Returns the width that was handed out.
pub(crate) fn index_todos(host: &dyn Backend, out: &Value) -> usize {
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

pub(crate) fn format_todos(host: &dyn Backend, out: &Value) -> String {
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
                str_at(t, "title"),
                str_at(t, "description"),
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
    let any_description = rows.iter().any(|r| !r[3].is_empty());
    let any_note = rows.iter().any(|r| !r[4].is_empty());
    let mut cols: Vec<&str> = vec!["id"];
    if uniform_state.is_none() {
        cols.push("state");
    }
    cols.push("title");
    if any_description {
        cols.push("description");
    }
    if any_note {
        cols.push("note");
    }
    let rows: Vec<Vec<String>> = rows
        .into_iter()
        .map(|r| {
            let [id, state, title, description, note] = r.try_into().expect("five columns");
            let mut kept = vec![id];
            if uniform_state.is_none() {
                kept.push(state);
            }
            kept.push(title);
            if any_description {
                kept.push(description);
            }
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
        w.hint("nothing on this project's list: todo_add title=<one line>");
    } else {
        w.hint("todo_claim id=<id> note=<what changed> — the user confirms, not you");
    }
    w.into_string()
}

pub(crate) fn format_worktree(out: &Value) -> String {
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
        .flag("uncommitted", dirty);
    if let Some(state) = push_state(out, detached) {
        w.field("push", &state);
    }
    w.inline("branches", &branches, MAX_BRANCHES);
    if detached {
        w.hint("worktree_branch name=<new> once the work is worth keeping");
    }
    w.into_string()
}

/// What the remote has of this branch, in one line, or nothing to say.
///
/// Nothing to say covers a detached worktree (no branch to push) and a
/// repository with no remote at all (never behind on pushing). Reported rather
/// than objected to at the end of a turn: closing the thread keeps the commits.
fn push_state(out: &Value, detached: bool) -> Option<String> {
    if detached || !out.get("hasRemote").and_then(|v| v.as_bool()).unwrap_or(false) {
        return None;
    }
    let ahead = out.get("ahead").and_then(|v| v.as_u64()).unwrap_or(0);
    match out.get("upstream").and_then(|v| v.as_str()) {
        None => Some("no remote has this branch".into()),
        Some(upstream) if ahead > 0 => Some(format!(
            "{ahead} {} ahead of {upstream}",
            if ahead == 1 { "commit" } else { "commits" }
        )),
        Some(upstream) => Some(format!("level with {upstream}")),
    }
}

pub(crate) fn format_whereami(out: &Value) -> String {
    let string_at = |key: &str| out.get(key).and_then(|v| v.as_str()).unwrap_or("-");
    let detached = out
        .get("detached")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut w = Toon::new();
    w.field("thread", string_at("thread"))
        .field("project", string_at("project"))
        .field("worktree", string_at("worktree"))
        .field("branch", string_at("branch"))
        .flag("detached", detached);
    w.into_string()
}

pub(crate) fn format_wait(out: &Value) -> String {
    let mut w = Toon::new();
    w.field(
        "threadId",
        out.get("threadId").and_then(|v| v.as_str()).unwrap_or(""),
    )
    .field(
        "status",
        out.get("status").and_then(|v| v.as_str()).unwrap_or(""),
    )
    .flag("live", out.get("live").and_then(|v| v.as_bool()).unwrap_or(false));
    if let Some(ms) = out.get("waitedMs").and_then(|v| v.as_u64()) {
        w.field("waitedMs", &ms.to_string());
    }
    w.into_string()
}

/// The sharing rule, one row per directory.
///
/// `source` comes first and is the point of the whole answer: the rows read the
/// same either way, and only that line tells the agent whether it is looking at
/// a decision or at a guess it is free to replace.
pub(crate) fn format_artifacts(out: &Value) -> String {
    let empty = Vec::new();
    let shared = out.get("shared").and_then(|v| v.as_array()).unwrap_or(&empty);
    let declared = out.get("declared").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut any_cargo = false;
    let rows: Vec<Vec<String>> = shared
        .iter()
        .map(|e| {
            let string_at = |key: &str| e.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let cargo = e
                .get("cargoWorkspace")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            any_cargo |= cargo;
            // The globs go in one cell, comma-separated: a row per glob would
            // repeat the directory, and this list is read as a whole anyway.
            let exclude = e
                .get("exclude")
                .and_then(|v| v.as_array())
                .map(|g| {
                    g.iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            vec![
                string_at("dir"),
                string_at("mode"),
                clip(&exclude, MAX_CELL),
                if cargo { "yes".into() } else { String::new() },
            ]
        })
        .collect();

    // The cargo rule is off on all but one project in a hundred, and a column
    // that is empty on every row is paid for on every row.
    let mut cols: Vec<&str> = vec!["dir", "mode", "exclude"];
    if any_cargo {
        cols.push("cargoWorkspace");
    }
    let rows: Vec<Vec<String>> = rows
        .into_iter()
        .map(|mut r| {
            if !any_cargo {
                r.pop();
            }
            r
        })
        .collect();

    let mut w = Toon::new();
    w.field("source", if declared { "declared" } else { "detected" })
        .field("file", out.get("file").and_then(|v| v.as_str()).unwrap_or(""))
        .table("shared", &cols, &rows);
    if declared {
        w.hint("the project declared this; artifacts_set replaces the whole list");
    } else {
        w.hint("nothing is declared: this is guessed from the manifests, artifacts_set to fix it");
    }
    w.into_string()
}

/// The project list, one row each. The path is what an agent matches against
/// its own cwd, so it is never clipped away; the name is what a user says out
/// loud, and both are accepted by `thread_move`.
pub(crate) fn format_projects(out: &Value) -> String {
    let empty = Vec::new();
    let projects = out
        .get("projects")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let mut any_archived = false;
    let rows: Vec<Vec<String>> = projects
        .iter()
        .map(|p| {
            let string_at = |key: &str| {
                p.get(key)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let flag_at = |key: &str| p.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
            let archived = flag_at("archived");
            any_archived |= archived;
            vec![
                string_at("id"),
                clip(&string_at("name"), MAX_CELL),
                clip(&string_at("path"), MAX_CELL),
                match (flag_at("current"), archived) {
                    (true, _) => "here".into(),
                    (_, true) => "archived".into(),
                    _ => "-".into(),
                },
            ]
        })
        .collect();

    let mut w = Toon::new();
    w.table("projects", &["id", "name", "path", "note"], &rows);
    if any_archived {
        w.hint("an archived project is unarchived by moving into it, never duplicated");
    } else {
        w.hint("thread_move project=<id|name|path>, or project_create name=<new>");
    }
    w.into_string()
}

/// What happened, one row each, newest first.
///
/// No timestamps in the table. They are milliseconds since the epoch and the
/// order is the answer, so a column of thirteen-digit numbers would cost a
/// token per row and tell the reader nothing they do not already have from the
/// order itself.
pub(crate) fn format_moments(out: &Value) -> String {
    let moments = out
        .get("moments")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if moments.is_empty() {
        let mut w = Toon::new();
        w.field("moments", "none");
        return w.into_string();
    }
    let rows: Vec<Vec<String>> = moments
        .iter()
        .map(|m| {
            let at = |key: &str| m.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
            vec![at("kind"), clip(&at("text"), MAX_CELL)]
        })
        .collect();
    let mut w = Toon::new();
    w.table("moments", &["kind", "what"], &rows);
    w.hint("newest first; workspace_search finds where something is, this shows what it was next to");
    w.into_string()
}

/// What the pulse answered: the cursor, then what happened, oldest first.
///
/// The order is the opposite of the timeline's on purpose: an orchestrator
/// replays what it slept through, and replaying newest-first is how a reply
/// lands before the question it answers.
pub(crate) fn format_pulse(out: &Value) -> String {
    let mut w = Toon::new();
    let seq = out.get("seq").and_then(|v| v.as_i64()).unwrap_or(0);
    w.field("seq", &seq.to_string());
    if out.get("truncated").and_then(|v| v.as_bool()) == Some(true) {
        w.field("truncated", "true");
        w.hint("you slept past the ring: re-read state with workspace_snapshot, do not replay");
        return w.into_string();
    }
    let moments = out
        .get("moments")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if moments.is_empty() {
        w.field("changed", "nothing");
        w.hint("a quiet wait is an answer; sleep again with the same seq");
        return w.into_string();
    }
    let rows: Vec<Vec<String>> = moments
        .iter()
        .map(|m| {
            let at = |key: &str| m.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
            vec![at("kind"), at("projectId"), at("objectId"), clip(&at("detail"), MAX_CELL)]
        })
        .collect();
    w.table("moments", &["kind", "project", "object", "detail"], &rows);
    w.hint("oldest first; pass this seq back as sinceSeq on your next pulse");
    w.into_string()
}

/// One log record per line, oldest first.
///
/// The columns are what a reader filters on next: the time to bound a window,
/// the level to decide whether it matters, the host and target to know which
/// half of the app said it. The four ids come last and only when they are set,
/// because most records carry none of them and a column of dashes is bytes
/// spent saying nothing.
pub(crate) fn format_log_records(out: &Value) -> String {
    let records = out
        .get("records")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut w = Toon::new();
    if records.is_empty() {
        w.field("records", "none");
        w.hint("widen it: drop the level, or ask again with action=query, which reads the files");
        return w.into_string();
    }
    let rows: Vec<Vec<String>> = records
        .iter()
        .map(|record| {
            let at = |key: &str| {
                record
                    .get(key)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let ts = record.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
            let mut msg = at("msg");
            // The ids the record carries, appended to the message rather than
            // given columns of their own: a record has at most a couple set and
            // which ones differ line by line.
            let mut ids = Vec::new();
            for key in ["thread", "turn", "request", "device", "span"] {
                let value = at(key);
                if !value.is_empty() {
                    ids.push(format!("{key}={value}"));
                }
            }
            if let Some(fields) = record.get("fields").and_then(|v| v.as_object()) {
                for (key, value) in fields {
                    let text = match value {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    ids.push(format!("{key}={text}"));
                }
            }
            if !ids.is_empty() {
                msg.push_str(" [");
                msg.push_str(&ids.join(" "));
                msg.push(']');
            }
            vec![
                iso_time(ts),
                at("level"),
                at("host"),
                clip(&at("target"), 48),
                clip(&msg, MAX_CELL),
            ]
        })
        .collect();
    w.table("records", &["ts", "level", "host", "target", "msg"], &rows);
    w.hint("oldest first; narrow with thread=<id>, level=warn, or since=<unix ms>");
    w.into_string()
}

/// Unix milliseconds as an ISO time, in UTC.
///
/// Hand-rolled rather than a date crate: this shim links serde and nothing
/// else on purpose, and the one thing a reader does with a timestamp is line
/// two records up against each other.
fn iso_time(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Days since 1970-01-01 to a calendar date.
///
/// Howard Hinnant's `civil_from_days`, which is the shortest correct answer:
/// the era arithmetic handles every leap rule without a table.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

/// What a search found, one row each.
///
/// The kind is the first column on purpose: a hit in the log carries a reason
/// somebody already wrote down, and a hit in a transcript is raw output. Which
/// one it is decides what to do next.
pub(crate) fn format_hits(out: &Value) -> String {
    let hits = out.get("hits").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if hits.is_empty() {
        let mut w = Toon::new();
        w.field("hits", "none");
        w.hint("try fewer words, or a path or error code exactly as it was printed");
        return w.into_string();
    }
    let rows: Vec<Vec<String>> = hits
        .iter()
        .map(|hit| {
            let at = |key: &str| {
                hit.get(key)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            vec![at("kind"), clip(&at("refId"), 12), clip(&at("excerpt"), MAX_CELL)]
        })
        .collect();
    let mut w = Toon::new();
    w.table("hits", &["kind", "ref", "text"], &rows);
    w.hint("a transcript ref is a thread id: terminal_transcript threadId=<ref> reads more of it");
    w.into_string()
}

/// The browser panes on the user's window.
///
/// The `opaque` sentence rides on every one of these rather than being said once
/// in a tool description, because the tool list is read at the start of a session
/// and this is read at the moment an agent is deciding what to do next. It is
/// also the answer to the question the shape of this table invites: there is no
/// text column because there is no text to put in one.
pub(crate) fn format_browser_panes(out: &Value) -> String {
    let panes = out.get("panes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut w = Toon::new();
    let rows: Vec<Vec<String>> = panes
        .iter()
        .map(|pane| {
            let at = |key: &str| pane.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let flag = |key: &str| pane.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
            let size = |key: &str| {
                pane.get(key)
                    .and_then(|v| v.as_f64())
                    .map(|n| n.round() as i64)
                    .unwrap_or(0)
            };
            vec![
                at("paneId"),
                clip(&at("url"), MAX_CELL),
                at("page"),
                flag("yours").to_string(),
                // The one measurement worth a column: a pane laid out at no
                // width is open and showing the user nothing.
                if flag("visible") {
                    format!("{}x{}", size("width"), size("height"))
                } else {
                    "hidden".to_string()
                },
            ]
        })
        .collect();
    w.table("panes", &["paneId", "url", "page", "yours", "size"], &rows);
    if let Some(note) = out.get("opaque").and_then(|v| v.as_str()) {
        w.hint(note);
    }
    if rows.is_empty() {
        w.hint("pane_open kind=browser url=<address> opens one");
    }
    w.into_string()
}

/// Whether the page came up, for an agent that is about to say it did.
pub(crate) fn format_page_settled(out: &Value) -> String {
    let state = out.get("page").and_then(|v| v.as_str()).unwrap_or("loading");
    let timed_out = out.get("timedOut").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut w = Toon::new();
    w.field("paneId", out.get("paneId").and_then(|v| v.as_str()).unwrap_or(""))
        .field("page", state);
    match state {
        // Two causes, one observation, and saying so is the whole point: an
        // agent told "failed" goes and debugs a server that is fine.
        "stalled" => w.hint(
            "it did not load: either it is slow, or the site refuses to be framed. Nothing on this \
             side can tell which, and the user has a button to open it outside",
        ),
        _ if timed_out => w.hint("still loading when the wait ran out; ask again or leave it"),
        _ => w.hint("the page came up; you still cannot read what is in it"),
    };
    w.into_string()
}

/// One line saying where the frame is, shared by every answer that reads it.
///
/// The driver reports `location.href` rather than the address the container
/// framed, because the two part company the moment anything inside the page
/// navigates. It is still the page's own account of itself: the driver shares
/// that page's JS realm and runs after its scripts, so every field here is
/// data a hostile page can shape, this address included.
fn page_line(w: &mut Toon, out: &Value) {
    let title = out.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let url = out.get("url").and_then(|v| v.as_str()).unwrap_or("");
    if !title.is_empty() || !url.is_empty() {
        w.field("page", &format!("{} {}", clip(title, 80), clip(url, MAX_CELL)));
    }
}

/// One element as a row: uid, role, name, value, and whatever else is worth a
/// cell. The driver sends single-letter keys because every key is paid for
/// once per element, per snapshot, per read of the answer.
fn element_row(e: &Value) -> Vec<String> {
    let at = |key: &str| e.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut note = e
        .get("s")
        .and_then(|v| v.as_array())
        .map(|flags| {
            flags
                .iter()
                .filter_map(|f| f.as_str())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let href = at("h");
    if !href.is_empty() {
        if !note.is_empty() {
            note.push(' ');
        }
        note.push_str(&clip(&href, 60));
    }
    vec![at("u"), at("r"), clip(&at("n"), 100), clip(&at("v"), 60), note]
}

const ELEMENT_COLS: [&str; 5] = ["uid", "role", "name", "value", "note"];

fn element_rows(out: &Value, key: &str) -> Vec<Vec<String>> {
    out.get(key)
        .and_then(|v| v.as_array())
        .map(|els| els.iter().take(MAX_PAGE_ELEMENTS).map(element_row).collect())
        .unwrap_or_default()
}

/// What the driver read out of the page, in the shape the mode asked for.
pub(crate) fn format_snapshot(out: &Value) -> String {
    // Prose is prose: TOON around a page's text is one more thing between the
    // agent and the sentence it is looking for.
    if let Some(text) = out.get("text").and_then(|v| v.as_str()) {
        let mut head = Toon::new();
        page_line(&mut head, out);
        let mut answer = head.into_string();
        let cut = text.len() > MAX_PAGE_TEXT;
        if text.is_empty() {
            answer.push_str("(no readable text)");
        } else {
            answer.push_str(&clip(text, MAX_PAGE_TEXT));
        }
        if cut || out.get("truncated").and_then(|v| v.as_bool()) == Some(true) {
            answer.push_str("\n[cut here; maxChars raises the budget]");
        }
        return answer;
    }

    let mut w = Toon::new();
    page_line(&mut w, out);
    if out.get("mode").and_then(|v| v.as_str()) == Some("diff") {
        let added = element_rows(out, "added");
        let changed = element_rows(out, "changed");
        let removed: Vec<String> = out
            .get("removed")
            .and_then(|v| v.as_array())
            .map(|ids| ids.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
            .unwrap_or_default();
        if added.is_empty() && changed.is_empty() && removed.is_empty() {
            w.field("diff", "nothing changed since the last snapshot");
            return w.into_string();
        }
        if !added.is_empty() {
            w.table("added", &ELEMENT_COLS, &added);
        }
        if !changed.is_empty() {
            w.table("changed", &ELEMENT_COLS, &changed);
        }
        if !removed.is_empty() {
            w.inline("removed", &removed, MAX_BRANCHES);
        }
        return w.into_string();
    }

    let rows = element_rows(out, "elements");
    w.table("elements", &ELEMENT_COLS, &rows);
    if let Some(more) = out.get("dropped").and_then(|v| v.as_u64()).filter(|n| *n > 0) {
        w.hint(&format!(
            "{more} more elements were not worth carrying; browser_scroll moves the page and \
             mode=text reads the prose"
        ));
    }
    w.hint("browser action=click uid=<uid> acts on a row; after acting, mode=diff costs less than looking again");
    w.into_string()
}

/// One action landed in the page, and where the page is now.
pub(crate) fn format_acted(out: &Value, did: &str) -> String {
    let mut w = Toon::new();
    w.field("did", did);
    page_line(&mut w, out);
    w.hint("browser_snapshot mode=diff shows what it changed");
    w.into_string()
}

/// One browser pane driven, and whether the answer is an outcome or an errand.
pub(crate) fn format_drove(out: &Value, done: &str, url: Option<&str>) -> String {
    let mut w = Toon::new();
    w.field("pane", done);
    if let Some(url) = url {
        w.field("url", url);
    }
    // `checked: false` is a boite with no window of its own: the request is on
    // its way to whichever device is drawing the pane, and nothing here saw the
    // pane before sending it. An agent that treats that as done is the bug this
    // field exists to stop.
    if out.get("checked").and_then(|v| v.as_bool()) == Some(false) {
        w.hint("sent to the device drawing the pane; this boite has no window, so browser_status here says nothing");
    }
    w.into_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::Host;
    use serde_json::json;

    fn host() -> Host {
        Host::probe()
    }

    /// One record per line, with the ids that are set and none of the ones
    /// that are not.
    ///
    /// The time is the part worth pinning: an agent lines two records up
    /// against each other, and a millisecond count would make it do arithmetic
    /// to find out whether something happened before or after.
    #[test]
    fn a_log_reads_as_one_line_per_record_with_the_ids_that_are_set() {
        let text = format_log_records(&json!({
            "records": [
                {
                    "ts": 1_756_000_000_000u64, "seq": 1, "host": "server",
                    "level": "warn", "target": "boite_server::ws",
                    "msg": "rpc.failed", "thread": "t-7", "device": "phone-1",
                    "fields": { "method": "git.commit" }
                },
                {
                    "ts": 1_756_000_000_500u64, "seq": 2, "host": "desktop",
                    "level": "info", "target": "boite_core::pty", "msg": "pty.exited"
                }
            ]
        }));
        assert!(text.contains("records(2):"), "{text}");
        assert!(text.contains("2025-08-24T01:46:40.000Z"), "{text}");
        assert!(text.contains("thread=t-7"), "{text}");
        assert!(text.contains("device=phone-1"), "{text}");
        assert!(text.contains("method=git.commit"), "{text}");
        // A record with no ids carries no empty brackets: bytes spent saying
        // nothing are bytes out of the agent's window.
        let last = text.lines().find(|l| l.contains("pty.exited")).unwrap();
        assert!(!last.contains('['), "{last}");

        // Nothing found says so, and says what to widen.
        let empty = format_log_records(&json!({ "records": [] }));
        assert!(empty.contains("records: none"), "{empty}");
        assert!(empty.contains("action=query"), "{empty}");
    }

    #[test]
    fn a_listing_costs_a_row_per_todo() {
        let h = host();
        let out = json!({ "todos": [
            { "id": "1a5f3698-27dc-4f9d-90e5-d732c50e839c", "projectId": "e7c778e0-6a14-4cfe-a7df-b9a2f5b04fc5",
              "title": "opti mcp axi", "state": "open", "note": null, "position": 0 },
            { "id": "596ce966-971c-4702-9040-1b1393ed8447", "projectId": "e7c778e0-6a14-4cfe-a7df-b9a2f5b04fc5",
              "title": "readme", "state": "claimed", "note": "done", "position": 1 }
        ]});
        assert_eq!(
            format_todos(&h, &out),
            "todos(2):\n  id state title note\n  1a5f3698 open \"opti mcp axi\" -\n  \
             596ce966 claimed readme done\nhint: todo_claim id=<id> note=<what changed> — the user confirms, not you\n"
        );
    }

    #[test]
    fn a_column_that_says_nothing_is_dropped() {
        let h = host();
        // Every item open, no note: two columns carry no information, and the
        // state they all share is worth one line rather than one cell per row.
        let out = json!({ "todos": [
            { "id": "1a5f3698-27dc-4f9d-90e5-d732c50e839c", "title": "opti mcp axi", "state": "open", "note": null },
            { "id": "596ce966-971c-4702-9040-1b1393ed8447", "title": "readme", "state": "open", "note": null }
        ]});
        assert_eq!(
            format_todos(&h, &out),
            concat!(
                "state: \"open (every item)\"\n",
                "todos(2):\n",
                "  id title\n",
                "  1a5f3698 \"opti mcp axi\"\n",
                "  596ce966 readme\n",
                "hint: todo_claim id=<id> note=<what changed> — the user confirms, not you\n",
            )
        );
    }

    #[test]
    fn a_description_earns_a_column_only_when_one_card_carries_it() {
        let h = host();
        // The panel keeps the description behind the card, but the agent that
        // has to act on it reads the list and nothing else.
        let out = json!({ "todos": [
            { "id": "1a5f3698-27dc-4f9d-90e5-d732c50e839c", "title": "opti mcp axi",
              "description": "drop reqwest", "state": "open", "note": null },
            { "id": "596ce966-971c-4702-9040-1b1393ed8447", "title": "readme", "state": "open", "note": null }
        ]});
        assert_eq!(
            format_todos(&h, &out),
            concat!(
                "state: \"open (every item)\"\n",
                "todos(2):\n",
                "  id title description\n",
                "  1a5f3698 \"opti mcp axi\" \"drop reqwest\"\n",
                "  596ce966 readme -\n",
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
        assert!(!text.contains("push:"), "detached has no branch to push: {text}");
    }

    /// The push state the Stop hook used to block a turn over. Silent when
    /// there is nothing a push would change.
    #[test]
    fn worktree_status_says_what_the_remote_has() {
        let base = json!({
            "path": "C:\\worktrees\\3506",
            "repo": "D:\\Dev\\Collab\\boite",
            "branch": "feat/x",
            "detached": false,
            "uncommittedChanges": false,
            "hasRemote": true,
            "upstream": null,
            "ahead": 0,
            "branches": ["master", "feat/x"]
        });
        assert!(
            format_worktree(&base).contains("push: \"no remote has this branch\"\n"),
            "{}",
            format_worktree(&base)
        );

        let mut ahead = base.clone();
        ahead["upstream"] = json!("origin/feat/x");
        ahead["ahead"] = json!(2);
        let text = format_worktree(&ahead);
        assert!(
            text.contains("push: \"2 commits ahead of origin/feat/x\"\n"),
            "{text}"
        );

        let mut level = ahead.clone();
        level["ahead"] = json!(0);
        let text = format_worktree(&level);
        assert!(text.contains("push: \"level with origin/feat/x\"\n"), "{text}");

        let mut no_remote = base.clone();
        no_remote["hasRemote"] = json!(false);
        let text = format_worktree(&no_remote);
        assert!(!text.contains("push:"), "no remote, nothing to be behind on: {text}");
    }

    /// A detected policy and a declared one differ in one line, and that line is
    /// what stops an agent from overwriting somebody's decision.
    #[test]
    fn the_artifact_policy_says_where_it_came_from() {
        let out = json!({
            "repo": "D:\\Dev\\Collab\\boite",
            "file": ".boite/artifacts.json",
            "declared": false,
            "shared": [
                { "dir": "target", "mode": "hardlink", "exclude": [], "cargoWorkspace": true },
                { "dir": "node_modules", "mode": "link", "exclude": [], "cargoWorkspace": false }
            ]
        });
        let text = format_artifacts(&out);
        assert!(text.contains("source: detected\n"), "{text}");
        assert!(text.contains("shared(2):\n"), "{text}");
        assert!(text.contains("  dir mode exclude cargoWorkspace\n"), "{text}");
        assert!(text.contains("  target hardlink - yes\n"), "{text}");
        assert!(text.contains("artifacts_set"), "{text}");

        let declared = json!({
            "file": ".boite/artifacts.json",
            "declared": true,
            "shared": [{ "dir": "_build", "mode": "hardlink", "exclude": ["dev/lib/mine/**"] }]
        });
        let text = format_artifacts(&declared);
        assert!(text.contains("source: declared\n"), "{text}");
        // No row asks for the cargo rule, so nobody pays for the column.
        assert!(text.contains("  dir mode exclude\n"), "{text}");
        assert!(text.contains("  _build hardlink dev/lib/mine/**\n"), "{text}");
    }
}
