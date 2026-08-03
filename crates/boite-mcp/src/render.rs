//! Turning an answer into the fewest tokens that still say it.
//!
//! Everything here writes TOON rather than JSON: one row per item, one header
//! row, no repeated keys. Ids are shortened to the prefix that still tells them
//! apart, and a column every row leaves empty is dropped rather than printed as
//! a wall of dashes.

use serde_json::Value;

use crate::toon::{clip, Toon};
use crate::host::Host;
use crate::{MAX_BRANCHES, MAX_CELL};

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
pub(crate) fn index_todos(host: &Host, out: &Value) -> usize {
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

pub(crate) fn format_todos(host: &Host, out: &Value) -> String {
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
        .flag("uncommitted", dirty)
        .inline("branches", &branches, MAX_BRANCHES);
    if detached {
        w.hint("worktree_branch name=<new> once the work is worth keeping");
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn host() -> Host {
        Host::probe()
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
