//! What happened, in order, and who did it.
//!
//! Boite mutates rows in place. A todo claimed by one thread, released, then
//! taken by another leaves a single `claimed_by` behind, so nothing can answer
//! which of six agents had it first, or when a branch was reserved, or why a
//! worktree is held. The current state is the only thing that exists, and when
//! something goes wrong there is nothing to read back.
//!
//! This is the missing half: an append-only log, one monotonic sequence per
//! project, each entry carrying the hash of the one before it. Rows keep being
//! the state; the log is how the state got there.
//!
//! Three properties, and each one is load-bearing:
//!
//! - **An entry cannot be received.** [`Entry`] has no `Deserialize`, and
//!   [`Action`] is an enum rather than a string. Nothing arriving from a client,
//!   an agent or a socket can become a log entry: the log is built here, from a
//!   call the code made, or it is not written at all. A journal a caller can
//!   dictate records what the caller wants it to.
//! - **The chain is checkable.** Each hash covers the project, the sequence, the
//!   previous hash, the action, the actor and the detail, so a row edited or
//!   removed after the fact breaks [`verify`] at that point rather than passing
//!   silently.
//! - **Refusals are entries too.** Something that was asked for and denied is
//!   the case somebody will need to debug; a log that only holds successes is a
//!   log that answers the easy question.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Who is acting.
///
/// Not a free string: an actor a caller can spell is an actor a caller can
/// impersonate in the record. A thread identifies itself by id today, and by a
/// key once threads have one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Actor {
    /// The person, through the window.
    Human,
    /// An agent, named by the thread it runs in.
    Thread(String),
    /// The app itself: a migration, a sweep, something no one asked for.
    System,
}

impl Actor {
    fn as_str(&self) -> String {
        match self {
            Actor::Human => "human".to_string(),
            Actor::Thread(id) => format!("thread:{id}"),
            Actor::System => "system".to_string(),
        }
    }
}

/// What happened. Closed on purpose: adding a case is a deliberate edit here,
/// which is what keeps the vocabulary of the log from drifting into prose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    TodoAdded,
    TodoClaimed,
    ProjectCreated,
    ThreadSpawned,
    ThreadMoved,
    WorktreeBranchClaimed,
    WorktreeReserved,
    PaneOpened,
    ArtifactsSet,
    /// Asked for, and refused. The reason is in the detail.
    Denied,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::TodoAdded => "todo.added",
            Action::TodoClaimed => "todo.claimed",
            Action::ProjectCreated => "project.created",
            Action::ThreadSpawned => "thread.spawned",
            Action::ThreadMoved => "thread.moved",
            Action::WorktreeBranchClaimed => "worktree.branch_claimed",
            Action::WorktreeReserved => "worktree.reserved",
            Action::PaneOpened => "pane.opened",
            Action::ArtifactsSet => "artifacts.set",
            Action::Denied => "denied",
        }
    }
}

/// One thing that happened, before it is written.
///
/// Deliberately not `Deserialize`. See the module docs.
pub struct Entry {
    pub project_id: String,
    pub actor: Actor,
    pub action: Action,
    /// What the action was about, when there is one thing: a todo id, a branch
    /// name, a thread id.
    pub object_id: Option<String>,
    /// Everything else. A `BTreeMap` rather than a `serde_json::Value` so the
    /// key order is the type's, not the caller's: the hash covers this text,
    /// and two orderings of the same facts must not produce two hashes.
    pub detail: BTreeMap<String, String>,
}

impl Entry {
    pub fn new(project_id: impl Into<String>, actor: Actor, action: Action) -> Entry {
        Entry {
            project_id: project_id.into(),
            actor,
            action,
            object_id: None,
            detail: BTreeMap::new(),
        }
    }

    pub fn about(mut self, object_id: impl Into<String>) -> Entry {
        self.object_id = Some(object_id.into());
        self
    }

    pub fn with(mut self, key: &str, value: impl Into<String>) -> Entry {
        self.detail.insert(key.to_string(), value.into());
        self
    }
}

/// An entry as it was written, with what the write decided.
#[derive(Clone, Debug, Serialize)]
pub struct Recorded {
    pub project_id: String,
    pub seq: i64,
    pub action: String,
    pub actor: String,
    pub object_id: Option<String>,
    pub detail: BTreeMap<String, String>,
    pub created_at: i64,
    /// Hex, because everything that reads this is JSON by the time it is read.
    pub hash: String,
    pub prev_hash: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The hash of an entry, over every field that makes it what it is.
///
/// Length-prefixed rather than concatenated: without it, an actor ending in a
/// digit and a sequence starting with one produce the same bytes as a different
/// pair, and two distinct histories hash alike.
fn digest(
    project_id: &str,
    seq: i64,
    prev: Option<&[u8]>,
    action: &str,
    actor: &str,
    object_id: Option<&str>,
    detail: &BTreeMap<String, String>,
) -> Vec<u8> {
    let mut h = Sha256::new();
    let mut field = |bytes: &[u8]| {
        h.update((bytes.len() as u64).to_be_bytes());
        h.update(bytes);
    };
    field(project_id.as_bytes());
    field(&seq.to_be_bytes());
    field(prev.unwrap_or(&[]));
    field(action.as_bytes());
    field(actor.as_bytes());
    field(object_id.unwrap_or("").as_bytes());
    field(&(detail.len() as u64).to_be_bytes());
    for (key, value) in detail {
        field(key.as_bytes());
        field(value.as_bytes());
    }
    h.finalize().to_vec()
}

/// Writes one entry and returns it as it was written.
///
/// The read of the previous head and the insert share a transaction, so two
/// writers cannot both claim the same sequence: the second waits, reads the
/// first one's row, and continues the chain from it.
pub fn append(conn: &mut Connection, entry: Entry) -> Result<Recorded, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("journal transaction failed: {e}"))?;

    let head: Option<(i64, Vec<u8>)> = tx
        .query_row(
            "SELECT seq, hash FROM events WHERE project_id = ?1 ORDER BY seq DESC LIMIT 1",
            params![entry.project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("journal head read failed: {e}"))?;

    let (seq, prev) = match head {
        Some((seq, hash)) => (seq + 1, Some(hash)),
        None => (1, None),
    };
    let action = entry.action.as_str();
    let actor = entry.actor.as_str();
    let created_at = now_ms();
    let hash = digest(
        &entry.project_id,
        seq,
        prev.as_deref(),
        action,
        &actor,
        entry.object_id.as_deref(),
        &entry.detail,
    );
    let detail_json = serde_json::to_string(&entry.detail).map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO events
           (project_id, seq, hash, prev_hash, action, actor, object_id, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            entry.project_id,
            seq,
            hash,
            prev,
            action,
            actor,
            entry.object_id,
            detail_json,
            created_at
        ],
    )
    .map_err(|e| format!("journal write failed: {e}"))?;
    tx.commit()
        .map_err(|e| format!("journal commit failed: {e}"))?;

    Ok(Recorded {
        project_id: entry.project_id,
        seq,
        action: action.to_string(),
        actor,
        object_id: entry.object_id,
        detail: entry.detail,
        created_at,
        hash: hex(&hash),
        prev_hash: prev.as_deref().map(hex),
    })
}

/// A project's history, oldest first, from `after` exclusive.
pub fn read(
    conn: &Connection,
    project_id: &str,
    after: i64,
    limit: usize,
) -> Result<Vec<Recorded>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT seq, hash, prev_hash, action, actor, object_id, detail, created_at
             FROM events WHERE project_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id, after, limit as i64], |r| {
            let hash: Vec<u8> = r.get(1)?;
            let prev: Option<Vec<u8>> = r.get(2)?;
            let detail: String = r.get(6)?;
            Ok(Recorded {
                project_id: project_id.to_string(),
                seq: r.get(0)?,
                action: r.get(3)?,
                actor: r.get(4)?,
                object_id: r.get(5)?,
                detail: serde_json::from_str(&detail).unwrap_or_default(),
                created_at: r.get(7)?,
                hash: hex(&hash),
                prev_hash: prev.as_deref().map(hex),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Why a chain stopped being trustworthy.
#[derive(Debug, PartialEq, Eq)]
pub enum Broken {
    /// A sequence number is missing: an entry was deleted.
    MissingSeq { expected: i64, found: i64 },
    /// The entry does not hash to what it stores: it was edited.
    Rewritten { seq: i64 },
    /// The entry does not follow the one before it: something was spliced.
    Unlinked { seq: i64 },
}

/// Walks a project's chain and reports the first break, or `None`.
///
/// Nothing calls this on a hot path. It exists so "has this been tampered
/// with" is a question with an answer, which is the only thing that makes the
/// chain worth having.
pub fn verify(conn: &Connection, project_id: &str) -> Result<Option<Broken>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT seq, hash, prev_hash, action, actor, object_id, detail
             FROM events WHERE project_id = ?1 ORDER BY seq ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, Option<Vec<u8>>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut expected_prev: Option<Vec<u8>> = None;
    for (expected_seq, row) in (1i64..).zip(rows) {
        let (seq, hash, prev, action, actor, object_id, detail) = row.map_err(|e| e.to_string())?;
        if seq != expected_seq {
            return Ok(Some(Broken::MissingSeq {
                expected: expected_seq,
                found: seq,
            }));
        }
        if prev != expected_prev {
            return Ok(Some(Broken::Unlinked { seq }));
        }
        let detail: BTreeMap<String, String> =
            serde_json::from_str(&detail).map_err(|e| e.to_string())?;
        let recomputed = digest(
            project_id,
            seq,
            prev.as_deref(),
            &action,
            &actor,
            object_id.as_deref(),
            &detail,
        );
        if recomputed != hash {
            return Ok(Some(Broken::Rewritten { seq }));
        }
        expected_prev = Some(hash);
    }
    Ok(None)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for m in crate::migrations::server() {
            conn.execute_batch(m.sql).unwrap();
        }
        conn
    }

    fn claim(project: &str, thread: &str, todo: &str) -> Entry {
        Entry::new(project, Actor::Thread(thread.into()), Action::TodoClaimed)
            .about(todo)
            .with("note", "done")
    }

    #[test]
    fn the_sequence_is_per_project_and_starts_at_one() {
        let mut conn = db();
        let a = append(&mut conn, claim("p1", "t1", "todo-1")).unwrap();
        let b = append(&mut conn, claim("p1", "t2", "todo-2")).unwrap();
        let c = append(&mut conn, claim("p2", "t1", "todo-3")).unwrap();
        assert_eq!((a.seq, b.seq, c.seq), (1, 2, 1));
        assert!(a.prev_hash.is_none(), "genesis has nothing before it");
        assert_eq!(b.prev_hash.as_deref(), Some(a.hash.as_str()));
        assert!(c.prev_hash.is_none(), "another project, another genesis");
    }

    /// The whole point: the row is overwritten, the history is not.
    #[test]
    fn a_todo_taken_and_taken_again_leaves_both_claims() {
        let mut conn = db();
        append(&mut conn, claim("p1", "k7f2", "todo-1")).unwrap();
        append(
            &mut conn,
            Entry::new("p1", Actor::Thread("k7f2".into()), Action::Denied)
                .about("todo-1")
                .with("reason", "released"),
        )
        .unwrap();
        append(&mut conn, claim("p1", "9ba1", "todo-1")).unwrap();

        let history = read(&conn, "p1", 0, 100).unwrap();
        let actors: Vec<&str> = history.iter().map(|e| e.actor.as_str()).collect();
        assert_eq!(actors, ["thread:k7f2", "thread:k7f2", "thread:9ba1"]);
        assert_eq!(verify(&conn, "p1").unwrap(), None);
    }

    #[test]
    fn an_edited_entry_breaks_the_chain() {
        let mut conn = db();
        append(&mut conn, claim("p1", "t1", "todo-1")).unwrap();
        append(&mut conn, claim("p1", "t1", "todo-2")).unwrap();
        append(&mut conn, claim("p1", "t1", "todo-3")).unwrap();
        assert_eq!(verify(&conn, "p1").unwrap(), None);

        conn.execute(
            "UPDATE events SET actor = 'thread:someone-else' WHERE project_id = 'p1' AND seq = 2",
            [],
        )
        .unwrap();
        assert_eq!(
            verify(&conn, "p1").unwrap(),
            Some(Broken::Rewritten { seq: 2 })
        );
    }

    #[test]
    fn a_deleted_entry_breaks_the_chain() {
        let mut conn = db();
        for n in 1..=3 {
            append(&mut conn, claim("p1", "t1", &format!("todo-{n}"))).unwrap();
        }
        conn.execute("DELETE FROM events WHERE project_id = 'p1' AND seq = 2", [])
            .unwrap();
        assert_eq!(
            verify(&conn, "p1").unwrap(),
            Some(Broken::MissingSeq {
                expected: 2,
                found: 3
            })
        );
    }

    /// Deleting the newest entry leaves a chain that is internally consistent,
    /// which is the honest limit of a hash chain with no external anchor: it
    /// catches edits and gaps, not a truncation at the head. Written down so
    /// nobody reads `verify` as more than it is.
    #[test]
    fn truncating_the_head_is_not_detected() {
        let mut conn = db();
        for n in 1..=3 {
            append(&mut conn, claim("p1", "t1", &format!("todo-{n}"))).unwrap();
        }
        conn.execute("DELETE FROM events WHERE project_id = 'p1' AND seq = 3", [])
            .unwrap();
        assert_eq!(verify(&conn, "p1").unwrap(), None);
    }

    /// The detail is hashed by key order, not by insertion order, or the same
    /// facts written in two orders would produce two different chains.
    #[test]
    fn the_detail_hashes_by_key_not_by_insertion_order() {
        let one = Entry::new("p1", Actor::Human, Action::TodoAdded)
            .with("b", "2")
            .with("a", "1");
        let two = Entry::new("p1", Actor::Human, Action::TodoAdded)
            .with("a", "1")
            .with("b", "2");
        assert_eq!(
            digest("p1", 1, None, "todo.added", "human", None, &one.detail),
            digest("p1", 1, None, "todo.added", "human", None, &two.detail)
        );
    }

    /// Two values that concatenate to the same bytes must not hash the same.
    /// Without length prefixes, `("ab", "c")` and `("a", "bc")` do.
    #[test]
    fn fields_cannot_be_confused_with_each_other() {
        let mut ab_c = BTreeMap::new();
        ab_c.insert("k".to_string(), "ab".to_string());
        let mut a_bc = BTreeMap::new();
        a_bc.insert("k".to_string(), "a".to_string());
        assert_ne!(
            digest("p", 1, None, "todo.added", "human", Some("c"), &ab_c),
            digest("p", 1, None, "todo.added", "human", Some("bc"), &a_bc)
        );
    }

    #[test]
    fn reading_is_paged_from_a_sequence() {
        let mut conn = db();
        for n in 1..=5 {
            append(&mut conn, claim("p1", "t1", &format!("todo-{n}"))).unwrap();
        }
        let page = read(&conn, "p1", 2, 2).unwrap();
        assert_eq!(page.iter().map(|e| e.seq).collect::<Vec<_>>(), [3, 4]);
    }
}
