//! What happened here, in order.
//!
//! `search` answers where something is. This answers when, and next to what,
//! which is the other half of every "why is this broken" and the one Boite
//! could not answer at all: the journal knew what agents did, the todo rows
//! knew when they moved, the thread rows knew when a terminal was opened, and
//! nothing put the three on the same line.
//!
//! Everything here comes off a clock the database already keeps. Nothing is
//! inferred and nothing is stamped on read, so a moment's time is the time the
//! row was written rather than the time somebody asked.
//!
//! **What is not in it, and why.** The Rust log and the frontend log are files
//! with their own clocks, and on the server the Rust log is stdout. Merging
//! them means a caller that has both, which is the desktop and not the server,
//! so [`merge`] takes whatever sources a caller can produce rather than
//! reaching for files this crate has no business knowing about.

use rusqlite::Connection;
use serde::Serialize;

/// One thing that happened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moment {
    /// Milliseconds since the epoch, as the row recorded it.
    pub at: i64,
    /// What kind of thing: `event`, `todo`, `thread`, or whatever a caller
    /// merging its own log calls its records.
    pub kind: String,
    /// The project, when the source knows one. Empty otherwise.
    pub project_id: String,
    /// One line. Written to be read in a list, not to be parsed.
    pub text: String,
}

/// The last `limit` moments the database remembers, newest first.
///
/// Three sources, and each is there because the other two miss it: an agent's
/// work is in the journal, a user ticking a box is only in the todo row, and a
/// terminal being opened is only on the thread. A timeline with any one of them
/// missing is a timeline with a hole exactly where somebody is looking.
pub fn from_store(conn: &Connection, project_id: Option<&str>, limit: usize) -> Vec<Moment> {
    let mut out = Vec::new();
    out.extend(events(conn, project_id, limit));
    out.extend(todos(conn, project_id, limit));
    out.extend(threads(conn, project_id, limit));
    merge(vec![out], limit)
}

/// Puts several sources in order and keeps the newest.
///
/// Stable on the timestamp alone: two rows written in the same millisecond keep
/// the order their sources were given in, which is the only ordering anybody
/// can defend when the clock cannot tell them apart.
pub fn merge(sources: Vec<Vec<Moment>>, limit: usize) -> Vec<Moment> {
    let mut all: Vec<Moment> = sources.into_iter().flatten().collect();
    all.sort_by(|a, b| b.at.cmp(&a.at));
    all.truncate(limit);
    all
}

fn events(conn: &Connection, project_id: Option<&str>, limit: usize) -> Vec<Moment> {
    let sql = "SELECT created_at, project_id, action, actor, object_id, detail
               FROM events WHERE (?1 IS NULL OR project_id = ?1)
               ORDER BY created_at DESC LIMIT ?2";
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![project_id, limit as i64], |r| {
        let action: String = r.get(2)?;
        let actor: String = r.get(3)?;
        let object: Option<String> = r.get(4)?;
        let detail: String = r.get(5)?;
        Ok(Moment {
            at: r.get(0)?,
            kind: "event".into(),
            project_id: r.get(1)?,
            text: format!(
                "{action} by {actor}{}{}",
                object.map(|o| format!(" on {o}")).unwrap_or_default(),
                summarise(&detail),
            ),
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

fn todos(conn: &Connection, project_id: Option<&str>, limit: usize) -> Vec<Moment> {
    let sql = "SELECT updated_at, project_id, state, text, claimed_by
               FROM todos WHERE (?1 IS NULL OR project_id = ?1)
               ORDER BY updated_at DESC LIMIT ?2";
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![project_id, limit as i64], |r| {
        let state: String = r.get(2)?;
        let title: String = r.get(3)?;
        let by: Option<String> = r.get(4)?;
        Ok(Moment {
            at: r.get(0)?,
            kind: "todo".into(),
            project_id: r.get(1)?,
            text: format!(
                "{state}: {title}{}",
                by.map(|b| format!(" ({b})")).unwrap_or_default()
            ),
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

fn threads(conn: &Connection, project_id: Option<&str>, limit: usize) -> Vec<Moment> {
    let sql = "SELECT created_at, project_id, COALESCE(NULLIF(title, ''), label), cmd, status
               FROM threads WHERE (?1 IS NULL OR project_id = ?1)
               ORDER BY created_at DESC LIMIT ?2";
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![project_id, limit as i64], |r| {
        let name: String = r.get(2)?;
        let cmd: String = r.get(3)?;
        let status: Option<String> = r.get(4)?;
        Ok(Moment {
            at: r.get(0)?,
            kind: "thread".into(),
            project_id: r.get(1)?,
            text: format!(
                "terminal {name} opened on {cmd}{}",
                status.map(|s| format!(", now {s}")).unwrap_or_default()
            ),
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

/// The interesting half of a journal entry's detail, as one clause.
///
/// The detail is a JSON object of short strings. Rendering it as JSON would put
/// braces and quotes in a line meant to be read, and dropping it would lose the
/// reason attached to every refusal, which is the single most useful thing in
/// the log.
fn summarise(detail: &str) -> String {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(detail)
    else {
        return String::new();
    };
    let pairs: Vec<String> = map
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|v| format!("{k}={v}")))
        .collect();
    if pairs.is_empty() {
        return String::new();
    }
    format!(" ({})", pairs.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moment(at: i64, kind: &str, text: &str) -> Moment {
        Moment {
            at,
            kind: kind.into(),
            project_id: "p1".into(),
            text: text.into(),
        }
    }

    #[test]
    fn the_newest_comes_first_across_every_source() {
        let merged = merge(
            vec![
                vec![moment(30, "event", "c"), moment(10, "event", "a")],
                vec![moment(20, "todo", "b")],
            ],
            10,
        );
        assert_eq!(
            merged.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["c", "b", "a"]
        );
    }

    /// Two rows in the same millisecond keep the order their sources were given
    /// in. It is the only ordering anybody can defend when the clock cannot
    /// tell them apart, and a sort that is not stable would shuffle them on
    /// every read.
    #[test]
    fn a_tie_keeps_the_order_it_arrived_in() {
        let merged = merge(
            vec![vec![moment(5, "event", "first"), moment(5, "todo", "second")]],
            10,
        );
        assert_eq!(
            merged.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["first", "second"]
        );
    }

    #[test]
    fn the_limit_keeps_the_newest_rather_than_the_first_source() {
        let merged = merge(
            vec![vec![moment(1, "event", "old")], vec![moment(9, "todo", "new")]],
            1,
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text, "new");
    }

    /// The reason attached to a refusal is the most useful thing in the log,
    /// and it lives in the detail. Rendered as a clause rather than as JSON,
    /// because this line is read rather than parsed.
    #[test]
    fn a_refusals_reason_survives_into_the_line() {
        assert_eq!(
            summarise(r#"{"of":"worktree.claim","reason":"branch taken"}"#),
            " (of=worktree.claim, reason=branch taken)"
        );
        assert_eq!(summarise("{}"), "");
        assert_eq!(summarise("not json"), "");
        // A non-string value is left out rather than printed as its debug form.
        assert_eq!(summarise(r#"{"n":1}"#), "");
    }

    #[test]
    fn every_source_lands_on_one_clock() {
        let conn = Connection::open_in_memory().unwrap();
        for (_, _, sql) in crate::migrations::desktop() {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO threads (id, project_id, label, cmd, args, created_at, status)
                 VALUES ('t1', 'p1', 'one', 'claude', '[]', 100, 'idle');
             INSERT INTO todos (id, project_id, text, state, position, created_at, updated_at)
                 VALUES ('d1', 'p1', 'write it down', 'open', 0, 150, 200);
             INSERT INTO events (project_id, seq, hash, action, actor, object_id, detail, created_at)
                 VALUES ('p1', 1, x'00', 'denied', 'thread:t1', 'main', '{\"reason\":\"taken\"}', 300);",
        )
        .unwrap();

        let moments = from_store(&conn, None, 10);
        assert_eq!(
            moments.iter().map(|m| m.kind.as_str()).collect::<Vec<_>>(),
            ["event", "todo", "thread"]
        );
        assert!(moments[0].text.contains("reason=taken"), "{:?}", moments[0]);
        assert!(moments[1].text.contains("write it down"));
        assert!(moments[2].text.contains("claude"));

        // And a project that has nothing shows nothing, rather than the rest.
        assert!(from_store(&conn, Some("p2"), 10).is_empty());
        assert_eq!(from_store(&conn, Some("p1"), 10).len(), 3);
    }
}
