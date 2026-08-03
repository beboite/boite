//! Finding something across a workspace, without knowing where to look.
//!
//! Three kinds of thing get searched, and they are searched two different ways
//! because they are two different shapes.
//!
//! **Todos and the journal** are rows, small, and written through [`Store`], so
//! they go in an FTS5 index kept in step at write time. There is no rebuild and
//! no reconciliation: the one place a todo is written is the one place it is
//! indexed.
//!
//! **Transcripts** are files, large, and appended to from a PTY reader thread.
//! Indexing them would mean a database write on the hot path of every terminal
//! in the workspace, so they are scanned at query time instead — the tail of
//! each, which is where the question "what did it just say" lives. Twenty live
//! terminals is a couple of megabytes, read once.
//!
//! The FTS table is created on demand rather than through `crate::migrations`,
//! and that is deliberate. The desktop's schema is applied by tauri-plugin-sql
//! over sqlx, which builds its own SQLite; a `CREATE VIRTUAL TABLE ... fts5` in
//! that ledger would brick every install whose build has FTS5 compiled out.
//! Created from here it is only ever touched by the connection that made it.

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

use crate::transcript;

/// What kind of thing was found. The caller draws these differently, and an
/// agent reads them differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Todo,
    /// Something that happened, out of the project's log.
    Event,
    /// What a terminal printed.
    Transcript,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Todo => "todo",
            Kind::Event => "event",
            Kind::Transcript => "transcript",
        }
    }

    fn parse(raw: &str) -> Kind {
        match raw {
            "todo" => Kind::Todo,
            "transcript" => Kind::Transcript,
            _ => Kind::Event,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub kind: Kind,
    /// The project it belongs to. Empty for a transcript, whose thread names
    /// its project rather than the file doing so.
    pub project_id: String,
    /// The todo id, the event's object, or the thread id.
    pub ref_id: String,
    /// One line of context, with the match in it.
    pub excerpt: String,
}

/// How much of each transcript is scanned.
///
/// The tail, because the question is nearly always what a terminal said
/// recently. Searching a whole run would mean reading the directory's entire
/// contents on every query, and the answer would be dominated by an install log
/// from three days ago.
const TRANSCRIPT_TAIL: usize = 256 * 1024;

/// One line either side of a match, which is what makes an excerpt readable
/// rather than a fragment.
const EXCERPT_CHARS: usize = 240;

/// Makes the index if it is not there. Cheap, and called before every use.
///
/// Returns whether there is an index to use at all: a SQLite built without
/// FTS5 answers no, and the caller falls back to the transcripts alone rather
/// than to an error.
pub(crate) fn ensure(conn: &Connection) -> bool {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
            kind UNINDEXED,
            project_id UNINDEXED,
            ref_id UNINDEXED,
            body
        );",
    )
    .is_ok()
}

/// Puts one row in the index, replacing whatever was there for that reference.
///
/// FTS5 has no `ON CONFLICT`, so this is a delete and an insert. A todo whose
/// text changes is re-indexed rather than duplicated, and a journal entry never
/// changes so its delete matches nothing.
pub(crate) fn index(conn: &Connection, kind: Kind, project_id: &str, ref_id: &str, body: &str) {
    if !ensure(conn) {
        return;
    }
    let _ = conn.execute(
        "DELETE FROM search WHERE kind = ?1 AND ref_id = ?2",
        rusqlite::params![kind.as_str(), ref_id],
    );
    let _ = conn.execute(
        "INSERT INTO search (kind, project_id, ref_id, body) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![kind.as_str(), project_id, ref_id, body],
    );
}

pub(crate) fn forget(conn: &Connection, kind: Kind, ref_id: &str) {
    let _ = conn.execute(
        "DELETE FROM search WHERE kind = ?1 AND ref_id = ?2",
        rusqlite::params![kind.as_str(), ref_id],
    );
}

/// What the index has for this text.
pub(crate) fn rows(conn: &Connection, needle: &str, limit: usize) -> Vec<Hit> {
    if !ensure(conn) {
        return Vec::new();
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT kind, project_id, ref_id, snippet(search, 3, '', '', '…', 20)
         FROM search WHERE search MATCH ?1 ORDER BY rank LIMIT ?2",
    ) else {
        return Vec::new();
    };
    let Ok(found) = stmt.query_map(rusqlite::params![query_for(needle), limit as i64], |r| {
        Ok(Hit {
            kind: Kind::parse(&r.get::<_, String>(0)?),
            project_id: r.get(1)?,
            ref_id: r.get(2)?,
            excerpt: r.get(3)?,
        })
    }) else {
        return Vec::new();
    };
    found.filter_map(Result::ok).collect()
}

/// What a user typed, as something FTS5 will accept.
///
/// Quoted per word, so a path, a sha or anything with punctuation in it is a
/// search rather than a syntax error. FTS5's own operators are not offered:
/// the one place this is typed is a box that says "search", and a stray `-`
/// in a branch name would otherwise mean "not".
fn query_for(needle: &str) -> String {
    needle
        .split_whitespace()
        .map(|word| format!("\"{}\"", word.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Lines in the recent tail of each transcript that contain the text.
///
/// A plain substring match, case-insensitively, rather than the FTS grammar:
/// what people look for in terminal output is a path, an error string or a
/// command, and tokenising those loses more than it finds.
pub fn transcripts(dir: &Path, needle: &str, limit: usize) -> Vec<Hit> {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut hits = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        if hits.len() >= limit {
            break;
        }
        let path = entry.path();
        // The current generation only. The previous one is there to be read
        // deliberately, not to double the cost of every search.
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let Some(thread_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(text) = transcript::tail(dir, thread_id, TRANSCRIPT_TAIL) else {
            continue;
        };
        for line in text.lines() {
            if hits.len() >= limit {
                break;
            }
            if !line.to_lowercase().contains(&needle) {
                continue;
            }
            hits.push(Hit {
                kind: Kind::Transcript,
                project_id: String::new(),
                ref_id: thread_id.to_string(),
                excerpt: clip(line),
            });
        }
    }
    hits
}

fn clip(line: &str) -> String {
    let line = line.trim();
    if line.chars().count() <= EXCERPT_CHARS {
        return line.to_string();
    }
    line.chars().take(EXCERPT_CHARS).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn indexed() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        assert!(ensure(&conn), "the bundled sqlite has fts5");
        index(&conn, Kind::Todo, "p1", "t1", "rewrite the worktree pool");
        index(&conn, Kind::Todo, "p1", "t2", "fix the redaction of an email");
        index(&conn, Kind::Event, "p1", "e1", "denied worktree.claim reason branch taken");
        conn
    }

    #[test]
    fn a_word_finds_the_rows_that_carry_it() {
        let conn = indexed();
        let found = rows(&conn, "worktree", 10);
        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|h| h.ref_id == "t1" && h.kind == Kind::Todo));
        assert!(found.iter().any(|h| h.ref_id == "e1" && h.kind == Kind::Event));
    }

    /// Re-indexing replaces rather than duplicating, which is what makes a todo
    /// that was edited findable once instead of twice.
    #[test]
    fn a_row_that_changed_is_not_found_under_both_texts() {
        let conn = indexed();
        index(&conn, Kind::Todo, "p1", "t1", "rewrite the branch reserve");
        assert!(rows(&conn, "pool", 10).is_empty());
        assert_eq!(rows(&conn, "reserve", 10).len(), 1);
    }

    #[test]
    fn forgetting_a_row_takes_it_out_of_the_index() {
        let conn = indexed();
        forget(&conn, Kind::Todo, "t2");
        assert!(rows(&conn, "redaction", 10).is_empty());
        // And leaves its neighbours alone.
        assert_eq!(rows(&conn, "worktree", 10).len(), 2);
    }

    /// The reason every word is quoted: FTS5 reads punctuation as its own
    /// grammar, so an unquoted path or a branch name with a dash in it is a
    /// syntax error rather than a search.
    #[test]
    fn punctuation_is_searched_rather_than_parsed() {
        let conn = Connection::open_in_memory().unwrap();
        ensure(&conn);
        index(&conn, Kind::Event, "p1", "e1", "fix/ci-gate-and-smoke landed");
        assert_eq!(rows(&conn, "fix/ci-gate-and-smoke", 10).len(), 1);
        assert_eq!(rows(&conn, "ci-gate", 10).len(), 1);
        // And a quote in the needle does not end up unbalanced in the query.
        assert!(rows(&conn, "it\"s", 10).is_empty());
    }

    #[test]
    fn what_a_terminal_said_is_searched_where_it_was_written() {
        let dir = std::env::temp_dir().join(format!("boite-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("t1.log"),
            "cargo build\nerror[E0432]: unresolved import\ndone\n",
        )
        .unwrap();

        let found = transcripts(&dir, "E0432", 10);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].ref_id, "t1");
        assert!(found[0].excerpt.contains("unresolved import"));

        // Case-insensitively, because nobody types an error code the way the
        // compiler did.
        assert_eq!(transcripts(&dir, "e0432", 10).len(), 1);
        assert!(transcripts(&dir, "nothing here", 10).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
