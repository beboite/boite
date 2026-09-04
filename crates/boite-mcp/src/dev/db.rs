//! Read-only SQL on the dev instance's SQLite.
//!
//! Two guards, and the order matters. The file is `dev.boite.dev`'s, named by
//! [`super::paths`] and never by an argument; the connection is opened with
//! `SQLITE_OPEN_READ_ONLY`, so even a statement that slipped past the first
//! guard could not write. The first guard exists anyway, because the useful
//! refusal is the one an agent reads before its `DELETE` reached anything.

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use crate::toon::Toon;

/// How many rows come back. A table read for a check fits; a dump does not,
/// and an agent that wants one should say `LIMIT` and a `WHERE`.
pub const MAX_ROWS: usize = 200;

/// The three verbs a read may start with.
const ALLOWED: [&str; 3] = ["select", "pragma", "explain"];

/// Whether `sql` is one read and nothing else.
///
/// A leading comment is stripped first: `-- what this is\nSELECT ...` is what
/// a person writes, and refusing it teaches nothing. A `;` with anything after
/// it is refused whole rather than truncated, because truncating would run
/// half of what was asked and say it ran all of it.
pub fn check(sql: &str) -> Result<&str, String> {
    let trimmed = strip_leading_comments(sql).trim();
    if trimmed.is_empty() {
        return Err("say what to read: a SELECT, a PRAGMA or an EXPLAIN".into());
    }
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed).trim_end();
    if body.contains(';') {
        return Err("one statement at a time: dev_db refuses a batch".into());
    }
    let first = body
        .split(|c: char| c.is_whitespace() || c == '(')
        .find(|w| !w.is_empty())
        .unwrap_or("")
        .to_lowercase();
    if !ALLOWED.contains(&first.as_str()) {
        return Err(format!(
            "dev_db is read-only: {first} is refused, only SELECT, PRAGMA and EXPLAIN are read"
        ));
    }
    Ok(body)
}

/// Run one read against the dev instance's database.
pub fn query(sql: &str) -> Result<String, String> {
    let statement = check(sql)?;
    let path = super::paths::dev_database()?;
    if !path.exists() {
        return Err(format!(
            "the dev instance has no database yet at {}; start the window once",
            path.display()
        ));
    }
    // Read-only, and no `create`: a missing file must be a refusal rather than
    // an empty database this tool brought into existence beside the real one.
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("cannot open {} read-only: {e}", path.display()))?;
    let mut prepared = connection
        .prepare(statement)
        .map_err(|e| format!("sqlite refused it: {e}"))?;
    let columns: Vec<String> = prepared
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();
    let mut rows = prepared
        .query([])
        .map_err(|e| format!("sqlite refused it: {e}"))?;
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut truncated = false;
    while let Some(row) = rows.next().map_err(|e| format!("sqlite: {e}"))? {
        if out.len() == MAX_ROWS {
            truncated = true;
            break;
        }
        let mut cells = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            cells.push(cell(row.get_ref(index).unwrap_or(ValueRef::Null)));
        }
        out.push(cells);
    }

    let mut w = Toon::new();
    if out.is_empty() {
        w.field("rows", "none");
        return Ok(w.into_string());
    }
    let headers: Vec<&str> = columns.iter().map(String::as_str).collect();
    w.table("rows", &headers, &out);
    if truncated {
        w.hint("capped at 200 rows; add a LIMIT and an ORDER BY to say which ones");
    }
    Ok(w.into_string())
}

/// One value as the text a row prints. A blob is reported by its size: it is
/// scrollback or a key, and neither is readable inline.
fn cell(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "-".to_string(),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(bytes) => crate::toon::clip(&String::from_utf8_lossy(bytes), 200),
        ValueRef::Blob(bytes) => format!("<{} bytes>", bytes.len()),
    }
}

/// Drop `--` comment lines from the front, so a commented query is judged on
/// its first real word.
fn strip_leading_comments(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    while let Some(after) = rest.strip_prefix("--") {
        match after.find('\n') {
            Some(end) => rest = after[end + 1..].trim_start(),
            None => return "",
        }
    }
    rest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_read_verbs_pass() {
        assert_eq!(check("SELECT 1").expect("select"), "SELECT 1");
        assert_eq!(
            check("pragma table_info(threads)").expect("pragma"),
            "pragma table_info(threads)"
        );
        assert!(check("EXPLAIN QUERY PLAN SELECT 1").is_ok());
    }

    #[test]
    fn everything_that_writes_is_refused() {
        for sql in [
            "DELETE FROM threads",
            "drop table threads",
            "UPDATE threads SET label = 'x'",
            "INSERT INTO threads (id) VALUES ('x')",
            "ATTACH DATABASE 'other.db' AS other",
            "VACUUM",
            "WITH x AS (SELECT 1) DELETE FROM threads",
        ] {
            assert!(check(sql).is_err(), "{sql} should be refused");
        }
    }

    #[test]
    fn a_write_hidden_behind_a_read_is_still_refused() {
        assert!(check("SELECT 1; DELETE FROM threads").is_err());
        assert!(check("SELECT 1;DROP TABLE threads;").is_err());
    }

    #[test]
    fn a_trailing_semicolon_is_the_one_that_is_allowed() {
        assert_eq!(check("SELECT 1;").expect("one statement"), "SELECT 1");
        assert_eq!(check("  SELECT 1 ;  ").expect("one statement"), "SELECT 1");
    }

    #[test]
    fn a_comment_does_not_hide_the_verb() {
        assert!(check("-- count them\nSELECT count(*) FROM threads").is_ok());
        assert!(check("-- innocent\nDELETE FROM threads").is_err());
        assert!(check("-- nothing after this").is_err());
    }

    #[test]
    fn nothing_at_all_is_refused_with_the_shape_it_wanted() {
        assert!(check("   ").expect_err("empty").contains("SELECT"));
    }
}
