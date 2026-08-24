//! Opencode's sqlite store.
//!
//! One database for every project, so finding a session means asking it which
//! one was last active in a directory. Read-only and through a URI with
//! `mode=ro`: opencode may be writing to it, and a second writer on the same
//! file is how a store ends up locked against the process that owns it.
//!
//! Turn state comes from the message rows, with the same freshness rule codex
//! needs and for the same reason: a row left open by a process that died is not
//! a turn in flight.

use super::*;

/// Whether an opencode turn is in flight, read off the message it is writing.
///
/// Opencode does expose the state we want, over `GET /session/status`, but only
/// when its server is listening: started as a plain TUI it runs the server inside
/// a worker thread behind a fake origin and binds no port at all. So the database
/// is what is left, and it answers cleanly: an assistant message carries
/// `time.completed` once its turn ends, and does not have the field before that.
///
/// `waiting` has no equivalent on disk either. Pending permissions and questions
/// live in `GET /permission` and `GET /question`, in memory, and the `permission`
/// table holds saved project rules rather than pending requests.
pub(super) fn opencode_turns(queries: &[TurnQuery]) -> Vec<AgentTurn> {
    let Some(db) = opencode_db_path() else {
        return Vec::new();
    };
    if !db.is_file() {
        return Vec::new();
    }
    let Ok(conn) = open_readonly(&db) else {
        return Vec::new();
    };
    opencode_turns_in(&conn, queries)
}

/// The query half, split off its file so the resolution can be tested against a
/// database built in the test rather than whatever this machine happens to hold.
fn opencode_turns_in(conn: &Connection, queries: &[TurnQuery]) -> Vec<AgentTurn> {
    // The recent end of the session list, newest first, read once so a thread whose
    // id is not captured yet can be placed by its directory. The match cannot be
    // made in SQL: the directory is recorded natively and only `normalize` compares
    // those the way the rest of this file does, which no `LIKE` reproduces.
    // `codex_turns` reads its index the same way, for the same reason.
    //
    // `parent_id IS NULL` keeps a subagent's own session from standing in for the
    // thread, since it shares the directory and its turn ends before the parent's
    // does.
    let recent: Vec<(String, String)> = conn
        .prepare(
            "SELECT id, coalesce(directory, '') FROM session \
             WHERE parent_id IS NULL \
             ORDER BY coalesce(time_updated, time_created, 0) DESC LIMIT 200",
        )
        .and_then(|mut stmt| {
            stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();

    let mut out = Vec::new();
    for query in queries.iter().filter(|q| q.kind == "opencode") {
        let resolved = match query.id() {
            Some(id) => conn
                .query_row(
                    "SELECT id, coalesce(directory, '') FROM session WHERE id = ?1",
                    [id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .ok(),
            None if query.cwd.is_empty() => None,
            // The newest session in that directory, not the newest session there is.
            // Ranking globally and then checking the folder answered only when the
            // thread happened to be the last opencode session opened anywhere, so
            // every other thread fell through to the screen rows. There is no
            // liveness here to narrow it further the way the registry agents allow:
            // a session row outlives its process, so "exactly one in this folder"
            // would hold for a first run and never again. Recency is what is left,
            // and the message below is what actually decides the state.
            None => {
                let want = normalize(&query.cwd);
                recent
                    .iter()
                    .find(|(_, dir)| !dir.is_empty() && normalize(dir) == want)
                    .cloned()
            }
        };
        let Some((id, directory)) = resolved else {
            continue;
        };
        let newest: Option<String> = conn
            .query_row(
                "SELECT data FROM message WHERE session_id = ?1 \
                 ORDER BY time_created DESC, id DESC LIMIT 1",
                [&id],
                |row| row.get::<_, String>(0),
            )
            .ok();
        let Some(state) = newest
            .as_deref()
            .and_then(|data| opencode_message_state(data, ms_since_epoch(SystemTime::now())))
        else {
            continue;
        };
        out.push(AgentTurn {
            kind: "opencode".into(),
            session_id: id,
            cwd: directory,
            state: state.into(),
            waiting_for: None,
        });
    }
    out
}

/// How long an unfinished opencode row can go untouched before it stops counting.
///
/// Same hole codex has: nothing ever closes one from outside. An opencode killed
/// mid-reply leaves an assistant row that never gained `time.completed`, and a
/// user row whose reply was never created, and either one reads busy on every
/// poll from then on. Generous for the same reason too, since a long tool call
/// updates nothing while it runs, and past it the answer is no answer.
const OPENCODE_ROW_TTL_MS: i64 = 30 * 60 * 1000;

#[derive(Deserialize)]
struct OpencodeMessage {
    role: Option<String>,
    time: Option<OpencodeMessageTime>,
}

#[derive(Deserialize)]
struct OpencodeMessageTime {
    created: Option<i64>,
    updated: Option<i64>,
    completed: Option<i64>,
}

/// The newest message in a session, turned into a state.
///
/// An assistant row without `time.completed` is a turn being written right now. A
/// user row as the newest means the prompt has landed and the reply has not been
/// created yet, which is the very start of a turn rather than the end of one.
///
/// Both of those are bounded by how long ago the row was written; only the
/// finished one is good forever.
fn opencode_message_state(data: &str, now_ms: i64) -> Option<&'static str> {
    let message: OpencodeMessage = serde_json::from_str(data).ok()?;
    let open = |time: Option<OpencodeMessageTime>| {
        let touched = time
            .map(|t| t.updated.unwrap_or(0).max(t.created.unwrap_or(0)))
            .unwrap_or(0);
        // A row with no timestamp at all cannot be aged, and inventing one would
        // demote a working thread on nothing. It keeps counting, as before.
        match touched {
            t if t > 0 && now_ms.saturating_sub(t) >= OPENCODE_ROW_TTL_MS => None,
            _ => Some("busy"),
        }
    };
    match message.role.as_deref() {
        Some("assistant") => match message.time.as_ref().and_then(|t| t.completed) {
            Some(_) => Some("idle"),
            None => open(message.time),
        },
        Some("user") => open(message.time),
        _ => None,
    }
}

fn opencode_db_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(data_home) = env::var("XDG_DATA_HOME") {
        if !data_home.trim().is_empty() {
            candidates.push(
                PathBuf::from(data_home)
                    .join("opencode")
                    .join("opencode.db"),
            );
        }
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db"),
        );
    }

    if let Some(base) = dirs::data_dir() {
        candidates.push(base.join("opencode").join("opencode.db"));
    }

    if let Some(base) = dirs::data_local_dir() {
        candidates.push(base.join("opencode").join("opencode.db"));
    }

    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .or_else(|| candidates.into_iter().next())
}

/// Whether `table` exists and has a `time_updated` column.
///
/// OpenCode has renamed the row that carries a session's activity twice
/// (`session_entry` then `session_message`). Naming one of those in SQL
/// made `prepare` fail on every other schema, and a switch to an already
/// created session (old `time_created`, recent `time_updated`) went
/// unseen. `pragma_table_info` is empty for a missing table, so one check
/// covers both.
fn has_time_updated(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM pragma_table_info(?1) WHERE name = 'time_updated'",
        [table],
        |_| Ok(()),
    )
    .is_ok()
}

fn session_activity_sql(conn: &Connection) -> String {
    let mut parts = vec![
        "coalesce(s.time_updated, 0)".to_string(),
        "coalesce(s.time_created, 0)".to_string(),
    ];
    for table in ["message", "part", "session_message", "session_entry"] {
        if has_time_updated(conn, table) {
            parts.push(format!(
                "coalesce((SELECT max(time_updated) FROM {table} WHERE session_id = s.id), 0)"
            ));
        }
    }
    format!("max({})", parts.join(", "))
}

fn find_opencode_session_by_activity(
    conn: &Connection,
    target: &str,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
    let activity = session_activity_sql(conn);
    // `parent_id IS NULL` is the same cut `opencode_turns` makes: a subagent
    // session shares the directory and is often the row that last moved.
    let sql = format!(
        "SELECT s.id, s.directory, {activity} AS activity \
         FROM session s \
         WHERE s.parent_id IS NULL \
         ORDER BY activity DESC \
         LIMIT 100"
    );
    let mut stmt = conn.prepare(&sql).ok()?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, i64>(2)?,
            ))
        })
        .ok()?;

    for row in rows.flatten() {
        let (id, directory, activity_ms) = row;
        if activity_ms >= after_unix_ms && normalize(&directory) == target && !exclude.contains(&id)
        {
            // The query already folded every table's timestamp into one; a row
            // whose columns were all null lands on 0, which is no timestamp.
            return Some(SessionHit {
                id,
                modified_ms: (activity_ms > 0).then_some(activity_ms),
                title: None,
            });
        }
    }
    None
}

fn find_opencode_session_by_created(
    conn: &Connection,
    target: &str,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
    let mut stmt = conn
        .prepare(
            "SELECT id, directory, time_created \
             FROM session \
             WHERE time_created >= ? \
               AND parent_id IS NULL \
             ORDER BY time_created DESC \
             LIMIT 50",
        )
        .ok()?;
    let rows = stmt
        .query_map([after_unix_ms], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .ok()?;

    for row in rows.flatten() {
        let (id, directory, created_ms) = row;
        if normalize(&directory) == target && !exclude.contains(&id) {
            // Creation is the only time this fallback knows about. It is the
            // right one here: it only runs for a session no activity row
            // covers, which is one nothing has happened on since.
            return Some(SessionHit {
                id,
                modified_ms: created_ms.filter(|ms| *ms > 0),
                title: None,
            });
        }
    }
    None
}

fn find_opencode_session_in(
    conn: &Connection,
    cwd: &str,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
    let target = normalize(cwd);
    find_opencode_session_by_activity(conn, &target, after_unix_ms, exclude)
        .or_else(|| find_opencode_session_by_created(conn, &target, after_unix_ms, exclude))
        .or_else(|| find_opencode_session_by_activity(conn, &target, 0, exclude))
}

pub fn find_opencode_session_blocking(
    cwd: String,
    after_unix_ms: i64,
    exclude: &HashSet<String>,
) -> Option<SessionHit> {
    let db_path = opencode_db_path()?;
    if !db_path.is_file() {
        return None;
    }

    let conn = open_readonly(&db_path).ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(250));
    find_opencode_session_in(&conn, &cwd, after_unix_ms, exclude)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_message_rows_decide_the_turn() {
        // An assistant row gains `time.completed` when its turn ends and does not
        // have the field before that. A user row as the newest means the prompt
        // landed and the reply has not been created yet.
        let now = 10_000_000;
        assert_eq!(
            opencode_message_state(
                r#"{"role":"assistant","time":{"created":1,"completed":2}}"#,
                now
            ),
            Some("idle")
        );
        assert_eq!(
            opencode_message_state(r#"{"role":"assistant","time":{"created":9999999}}"#, now),
            Some("busy")
        );
        assert_eq!(
            opencode_message_state(r#"{"role":"user","time":{"created":9999999}}"#, now),
            Some("busy")
        );
        // Nothing recognisable is not an answer.
        assert_eq!(opencode_message_state(r#"{"role":"system"}"#, now), None);
        assert_eq!(opencode_message_state("not json", now), None);
    }

    #[test]
    fn an_open_opencode_row_stops_counting_once_it_goes_stale() {
        // Same hole codex has: opencode killed mid-reply leaves an assistant row
        // that never gains `time.completed`, and a user row whose reply is never
        // created, and the session stays the newest one in its directory. Neither
        // may read busy forever.
        let now = 10 * OPENCODE_ROW_TTL_MS;
        let stale = now - OPENCODE_ROW_TTL_MS;
        let fresh = now - OPENCODE_ROW_TTL_MS + 1;
        let row = |role: &str, created: i64| {
            format!(r#"{{"role":"{role}","time":{{"created":{created}}}}}"#)
        };
        assert_eq!(
            opencode_message_state(&row("assistant", fresh), now),
            Some("busy")
        );
        assert_eq!(opencode_message_state(&row("assistant", stale), now), None);
        assert_eq!(
            opencode_message_state(&row("user", fresh), now),
            Some("busy")
        );
        assert_eq!(opencode_message_state(&row("user", stale), now), None);

        // `time_updated` is what moves while a reply is being written, so it is
        // what keeps a long turn alive even though `created` has aged out.
        let touched =
            format!(r#"{{"role":"assistant","time":{{"created":{stale},"updated":{fresh}}}}}"#);
        assert_eq!(opencode_message_state(&touched, now), Some("busy"));

        // A finished turn is good forever; only the open side is bounded.
        let done =
            format!(r#"{{"role":"assistant","time":{{"created":{stale},"completed":{stale}}}}}"#);
        assert_eq!(opencode_message_state(&done, now), Some("idle"));

        // A row with no timestamp at all cannot be aged, and inventing one would
        // demote a working thread on nothing.
        assert_eq!(
            opencode_message_state(r#"{"role":"assistant","time":{}}"#, now),
            Some("busy")
        );
        assert_eq!(
            opencode_message_state(r#"{"role":"assistant"}"#, now),
            Some("busy")
        );
    }

    #[test]
    fn opencode_places_a_thread_by_its_own_directory() {
        // The regression this covers: the directory fallback used to rank every
        // session in the database, take the single newest, and only then check the
        // folder. That answers for one thread, the one whose agent happened to be
        // the last opencode session started anywhere, and silently answers nothing
        // for every other. Caught by running the reader against a real store, where
        // the only session it would place was not the one being asked about.
        let conn = Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, \
                                   time_created INTEGER, time_updated INTEGER);
             CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
             INSERT INTO session VALUES ('old', NULL, 'D:/Work/One', 1, 10);
             INSERT INTO session VALUES ('mine', NULL, 'D:/Work/One', 2, 20);
             INSERT INTO session VALUES ('child', 'mine', 'D:/Work/One', 3, 30);
             INSERT INTO session VALUES ('elsewhere', NULL, 'D:/Work/Two', 4, 40);
             INSERT INTO message VALUES ('m1', 'old', 1, '{\"role\":\"assistant\",\"time\":{\"completed\":9}}');
             INSERT INTO message VALUES ('m2', 'mine', 2, '{\"role\":\"assistant\",\"time\":{}}');
             INSERT INTO message VALUES ('m3', 'child', 3, '{\"role\":\"assistant\",\"time\":{\"completed\":9}}');
             INSERT INTO message VALUES ('m4', 'elsewhere', 4, '{\"role\":\"assistant\",\"time\":{\"completed\":9}}');",
        )
        .expect("fixture");

        let ask = |id: Option<&str>, cwd: &str| TurnQuery {
            kind: "opencode".into(),
            session_id: id.map(str::to_string),
            cwd: cwd.into(),
        };

        // A newer session in another folder does not stand in, and the subagent row
        // sharing the folder does not either: its turn ends before its parent's.
        // A row with no timestamp cannot be aged out, so `mine` still reads busy.
        let by_cwd = opencode_turns_in(&conn, &[ask(None, r"D:\Work\One")]);
        assert_eq!(by_cwd.len(), 1);
        assert_eq!(by_cwd[0].session_id, "mine");
        assert_eq!(by_cwd[0].state, "busy");

        // A captured id is the precise question and skips the folder entirely.
        let by_id = opencode_turns_in(&conn, &[ask(Some("old"), r"D:\Work\One")]);
        assert_eq!(by_id.len(), 1);
        assert_eq!(by_id[0].session_id, "old");
        assert_eq!(by_id[0].state, "idle");

        // Nothing to place a thread with is not an answer, and neither is a folder
        // no session claims. Both fall back to the terminal's rows.
        assert!(opencode_turns_in(&conn, &[ask(None, "")]).is_empty());
        assert!(opencode_turns_in(&conn, &[ask(None, "D:/Work/Three")]).is_empty());
        assert!(opencode_turns_in(&conn, &[ask(Some("gone"), r"D:\Work\One")]).is_empty());

        // Another agent's query is not this reader's to answer.
        let other = TurnQuery {
            kind: "claude".into(),
            session_id: None,
            cwd: "D:/Work/One".into(),
        };
        assert!(opencode_turns_in(&conn, &[other]).is_empty());
    }

    #[test]
    fn opencode_finds_a_switch_to_an_existing_session() {
        // OpenCode dropped `session_entry` (replaced by `session_message`, then
        // by the original `message`/`part` pair plus `session.time_updated`).
        // The activity query named that table unconditionally, so `prepare`
        // failed and the only remaining path was `time_created >= after`.
        // Switching to a conversation that already existed never matched:
        // its created timestamp is old, its `time_updated` is what moved.
        let conn = Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "CREATE TABLE session (
                 id TEXT PRIMARY KEY,
                 parent_id TEXT,
                 directory TEXT NOT NULL,
                 title TEXT NOT NULL,
                 time_created INTEGER NOT NULL,
                 time_updated INTEGER NOT NULL
             );
             CREATE TABLE message (
                 id TEXT PRIMARY KEY,
                 session_id TEXT NOT NULL,
                 time_created INTEGER NOT NULL,
                 time_updated INTEGER NOT NULL,
                 data TEXT NOT NULL
             );
             INSERT INTO session VALUES
                 ('bound', NULL, 'D:/Work/One', 'first', 1000, 2000),
                 ('switched', NULL, 'D:/Work/One', 'other', 1500, 9000),
                 ('child', 'switched', 'D:/Work/One', 'sub', 1600, 9500),
                 ('elsewhere', NULL, 'D:/Work/Two', 'nope', 1700, 9800);
             INSERT INTO message VALUES
                 ('m1', 'bound', 1000, 2000, '{}'),
                 ('m2', 'switched', 1500, 9000, '{}');",
        )
        .expect("fixture");

        let mut exclude = HashSet::new();
        exclude.insert("bound".into());
        let hit = find_opencode_session_in(&conn, r"D:\Work\One", 8000, &exclude)
            .expect("the session the thread switched to");
        assert_eq!(hit.id, "switched");
        assert_eq!(hit.modified_ms, Some(9000));
    }

    #[test]
    fn opencode_still_reads_session_entry_when_the_table_exists() {
        // The table OpenCode later dropped. Ignoring it on a store that still
        // has it would miss the only timestamp that moved.
        let conn = Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "CREATE TABLE session (
                 id TEXT PRIMARY KEY,
                 parent_id TEXT,
                 directory TEXT NOT NULL,
                 title TEXT NOT NULL,
                 time_created INTEGER NOT NULL,
                 time_updated INTEGER NOT NULL
             );
             CREATE TABLE session_entry (
                 id TEXT PRIMARY KEY,
                 session_id TEXT NOT NULL,
                 time_updated INTEGER NOT NULL
             );
             INSERT INTO session VALUES
                 ('bound', NULL, 'D:/Work/One', 'first', 1000, 2000),
                 ('switched', NULL, 'D:/Work/One', 'other', 1500, 2000);
             INSERT INTO session_entry VALUES ('e1', 'switched', 9000);",
        )
        .expect("fixture");

        let mut exclude = HashSet::new();
        exclude.insert("bound".into());
        let hit = find_opencode_session_in(&conn, "D:/Work/One", 8000, &exclude)
            .expect("activity on session_entry");
        assert_eq!(hit.id, "switched");
        assert_eq!(hit.modified_ms, Some(9000));
    }
}
