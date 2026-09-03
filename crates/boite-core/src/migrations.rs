//! The database schema, declared once.
//!
//! It used to be declared twice: explicit `version` integers in the desktop's
//! `lib.rs`, and an array indexed by position in `boite-server`'s `store.rs`,
//! kept in step by comments claiming to mirror each other. They did not. The
//! two lists do not even number the same thing, because each side has entries
//! the other never ran: the server has `push_subscriptions`, the desktop has
//! the chat tables it created and dropped again. So "version 15" meant two
//! different migrations depending on which binary you asked.
//!
//! Neither history can be rewritten. Both shipped, and an applied migration
//! never runs again, so renumbering would replay `ALTER TABLE` statements
//! against columns that already exist and leave the desktop unbootable.
//!
//! One ordered list, then, with each entry saying which binaries it belongs
//! to. [`desktop`] and [`server`] are projections of it, and each reproduces
//! its own side's shipped order exactly. Adding a migration means appending
//! once, here.

/// Which binaries run a migration.
///
/// Anything new should be `Both`. The two lopsided entries are history: a
/// server-only table, and a desktop-only feature that was built and removed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Applies {
    Both,
    DesktopOnly,
    ServerOnly,
}

pub struct Migration {
    /// What it does, in the desktop's `snake_case` convention. The server has
    /// no use for it and it is worth having on both sides anyway: it is what a
    /// failure names.
    pub description: &'static str,
    pub sql: &'static str,
    pub applies: Applies,
}

const fn both(description: &'static str, sql: &'static str) -> Migration {
    Migration {
        description,
        sql,
        applies: Applies::Both,
    }
}

/// Every migration, in the order they were shipped.
///
/// **Append only, and never edit an entry that has shipped.** A machine that
/// already applied one will not apply it again, so an edit reaches new installs
/// alone and the two diverge silently.
pub const ALL: &[Migration] = &[
    both(
        "create_projects",
        "CREATE TABLE IF NOT EXISTS projects (\
                id TEXT PRIMARY KEY,\
                name TEXT NOT NULL,\
                cwd TEXT NOT NULL,\
                default_cmd TEXT NOT NULL,\
                default_args TEXT NOT NULL,\
                created_at INTEGER NOT NULL\
            );",
    ),
    both(
        "add_project_icon",
        "ALTER TABLE projects ADD COLUMN icon TEXT;",
    ),
    both(
        "create_settings",
        "CREATE TABLE IF NOT EXISTS settings (\
                key TEXT PRIMARY KEY,\
                value TEXT NOT NULL\
            );",
    ),
    both(
        "create_threads",
        "CREATE TABLE IF NOT EXISTS threads (\
                id TEXT PRIMARY KEY,\
                project_id TEXT NOT NULL,\
                label TEXT NOT NULL,\
                title TEXT,\
                cmd TEXT NOT NULL,\
                args TEXT NOT NULL,\
                exit_code INTEGER,\
                created_at INTEGER NOT NULL\
            );",
    ),
    both(
        "add_thread_session_and_icon",
        "ALTER TABLE threads ADD COLUMN session_id TEXT;\
                  ALTER TABLE threads ADD COLUMN icon_key TEXT;",
    ),
    both(
        "add_project_archived",
        "ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;",
    ),
    both(
        "add_thread_status_and_autoslept",
        "ALTER TABLE threads ADD COLUMN status TEXT;\
                  ALTER TABLE threads ADD COLUMN auto_slept INTEGER NOT NULL DEFAULT 0;",
    ),
    both(
        "add_thread_keep_awake",
        "ALTER TABLE threads ADD COLUMN keep_awake INTEGER NOT NULL DEFAULT 0;",
    ),
    // Server only, and it has to stay at this position: it is the ninth entry
    // the server applied, so moving it renumbers every migration after it on
    // every deployed boite. The desktop has no push subscriptions to store; a
    // browser is what holds one.
    Migration {
        description: "create_push_subscriptions",
        sql: "CREATE TABLE IF NOT EXISTS push_subscriptions (
            endpoint TEXT PRIMARY KEY,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );",
        applies: Applies::ServerOnly,
    },
    both(
        "add_project_git_root",
        "ALTER TABLE projects ADD COLUMN git_root TEXT;",
    ),
    both(
        "add_thread_icon_color",
        "ALTER TABLE threads ADD COLUMN icon_color TEXT;",
    ),
    // A table rather than a key in the settings blob: an agent writes here
    // through the MCP endpoint while the app is running, and a whole-blob
    // rewrite from either side would drop the other's edits.
    both(
        "create_todos",
        "CREATE TABLE IF NOT EXISTS todos (\
                id TEXT PRIMARY KEY,\
                project_id TEXT NOT NULL,\
                text TEXT NOT NULL,\
                state TEXT NOT NULL,\
                note TEXT,\
                position INTEGER NOT NULL,\
                created_at INTEGER NOT NULL,\
                updated_at INTEGER NOT NULL\
            );\
            CREATE INDEX IF NOT EXISTS idx_todos_project ON todos (project_id);",
    ),
    // The sha an agent reports with its claim. A column rather than a line in
    // the note: it is read back against the repository, and something parsed
    // out of prose is wrong the first time an agent phrases it differently.
    both(
        "add_todo_commit",
        "ALTER TABLE todos ADD COLUMN commit_sha TEXT;",
    ),
    // Which agent claimed it, as the icon key the rest of the app already draws
    // by. Filled in only when Boite launched the terminal: that is where the
    // thread id comes from, and an agent Boite did not start is one it cannot
    // name.
    both(
        "add_todo_claimed_by",
        "ALTER TABLE todos ADD COLUMN claimed_by TEXT;",
    ),
    // The directory the thread runs in, when it is not the project's. Null for
    // every thread that lives in the project folder itself, which is every
    // thread that exists before this column does.
    both(
        "add_thread_worktree_path",
        "ALTER TABLE threads ADD COLUMN worktree_path TEXT;",
    ),
    // The body of the card. `text` was carrying both the label and whatever
    // detail came with it, so an agent writing a paragraph got a row that
    // truncated at the panel's width and lost the rest to a tooltip nobody
    // could read. The title stays one line; everything else lives here.
    both(
        "add_todo_description",
        "ALTER TABLE todos ADD COLUMN description TEXT;",
    ),
    // Dead as of the next entry, which drops both tables. Kept because it
    // shipped, and an edited migration never re-runs on a machine that already
    // applied it: the undo has to be its own version. Neither ever reached a
    // server.
    Migration {
        description: "create_chats",
        sql: "CREATE TABLE IF NOT EXISTS chats (\
                id TEXT PRIMARY KEY,\
                title TEXT,\
                agent_key TEXT,\
                cmd TEXT NOT NULL,\
                args TEXT NOT NULL,\
                cwd TEXT NOT NULL,\
                project_id TEXT,\
                session_id TEXT,\
                created_at INTEGER NOT NULL,\
                updated_at INTEGER NOT NULL\
            );\
            CREATE TABLE IF NOT EXISTS chat_messages (\
                id TEXT PRIMARY KEY,\
                chat_id TEXT NOT NULL,\
                role TEXT NOT NULL,\
                text TEXT NOT NULL,\
                raw TEXT,\
                state TEXT NOT NULL,\
                created_at INTEGER NOT NULL\
            );\
            CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages (chat_id);",
        applies: Applies::DesktopOnly,
    },
    Migration {
        description: "drop_chats",
        sql: "DROP INDEX IF EXISTS idx_chat_messages_chat;\
            DROP TABLE IF EXISTS chat_messages;\
            DROP TABLE IF EXISTS chats;",
        applies: Applies::DesktopOnly,
    },
    // Whether this project's threads get their own worktree. Nullable on
    // purpose: null means "whatever the app is set to", which is what every
    // project that predates the column has always done. Only a project the user
    // has had an opinion about carries a 0 or a 1, so changing the global
    // default still moves the ones nobody has touched.
    both(
        "add_project_worktrees",
        "ALTER TABLE projects ADD COLUMN worktrees INTEGER;",
    ),
    // The event log. Rows keep being the state; this is how the state got
    // there, one monotonic sequence per project with each entry carrying the
    // hash of the one before it. See `crate::journal` for why an entry cannot
    // be deserialised and what the hash covers.
    both(
        "create_events",
        "CREATE TABLE IF NOT EXISTS events (
            project_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            hash BLOB NOT NULL,
            prev_hash BLOB,
            action TEXT NOT NULL,
            actor TEXT NOT NULL,
            object_id TEXT,
            detail TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (project_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_events_project_time
            ON events (project_id, created_at);",
    ),
    // The public half of the keypair minted when a thread was spawned. Absent
    // for every thread that predates it, which is what makes those threads
    // unable to prove anything: there is no migration path from "presented an
    // id" to "holds a key", and inventing one would be issuing an identity to
    // whoever happens to ask first.
    //
    // Its own table rather than a column on `threads`, and that is not tidiness.
    // The desktop puts a thread in its store and persists the row behind the
    // caller, in the same breath as mounting the terminal, so at the moment a
    // key is minted the row may not be there yet. A column could not be written;
    // a row here can, and the two meet when the request arrives.
    both(
        "create_thread_keys",
        "CREATE TABLE IF NOT EXISTS thread_keys (
            thread_id TEXT PRIMARY KEY,
            public_key TEXT NOT NULL
        );",
    ),
    // What an agent asked for and the user has not answered yet. The whole
    // dispatch is kept verbatim in `request`, so allowing one replays exactly
    // what was asked rather than a reconstruction of it.
    both(
        "create_approvals",
        "CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            action TEXT NOT NULL,
            detail TEXT NOT NULL,
            request TEXT NOT NULL,
            verdict TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            decided_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_approvals_open
            ON approvals (verdict, created_at);",
    ),
    // Where a thread sits once the sidebar holds more of them than a screen. All
    // three nullable, and all three null is an ordinary live thread, which is
    // what every row predating them already is. `pin_order` is a position in one
    // workspace-wide order rather than a boolean, so the order itself reaches
    // every device instead of only the one that pinned; `settled_at` and
    // `snoozed_until` say *when* rather than whether, so "put away in March" and
    // "back on Monday" are answerable without a second column each.
    both(
        "add_thread_ageing",
        "ALTER TABLE threads ADD COLUMN pin_order INTEGER;\
                  ALTER TABLE threads ADD COLUMN settled_at INTEGER;\
                  ALTER TABLE threads ADD COLUMN snoozed_until INTEGER;",
    ),
    // One row per paired device, and the one-time tokens that produce them.
    //
    // Server only, for the same reason `push_subscriptions` is: the thing being
    // paired is a browser or a phone reaching a headless boite over a socket,
    // and a desktop window is one of those devices rather than a host for them.
    // Appended last, so the desktop's list does not move a single position and
    // no sqlx digest is disturbed.
    //
    // Neither table holds a secret. `secret_hash` is a SHA-256 of what was
    // issued, so a dump of this file opens nothing; see `crate::pairing`.
    // `scopes` is the granted set as text rather than bits, because a column a
    // person can read in a sqlite shell is worth more than four bytes, and a
    // bit that shifts meaning between versions is a grant that silently
    // changes.
    Migration {
        description: "create_pairings",
        sql: "CREATE TABLE IF NOT EXISTS pairings (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            kind TEXT NOT NULL,
            scopes TEXT NOT NULL,
            secret_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER,
            revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS pairing_tokens (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            kind TEXT NOT NULL,
            scopes TEXT NOT NULL,
            secret_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            used_at INTEGER
        );",
        applies: Applies::ServerOnly,
    },
    // Parent-child thread hierarchy for delegation tracking. Threads spawned as
    // delegations carry their parent's id, a mode flag distinguishing them in
    // the UI, and an optional status tracking the delegation lifecycle.
    both(
        "add_thread_delegation",
        "ALTER TABLE threads ADD COLUMN parent_thread_id TEXT;\
                  ALTER TABLE threads ADD COLUMN delegation_mode TEXT DEFAULT 'normal';\
                  ALTER TABLE threads ADD COLUMN delegation_status TEXT;",
    ),
    // The orchestrator columns. `role` is stamped by Boite at creation and is
    // deliberately not reachable through `thread.update`: it is what selects
    // the orchestrator MCP tool tier, so an agent that could write it would be
    // an agent that could promote itself. `accept_dispatch` defaults on; the
    // user mutes a thread, an agent never re-arms one.
    both(
        "add_thread_orchestration",
        "ALTER TABLE threads ADD COLUMN role TEXT;\
                  ALTER TABLE threads ADD COLUMN orchestrator_scope TEXT;\
                  ALTER TABLE threads ADD COLUMN accept_dispatch INTEGER NOT NULL DEFAULT 1;",
    ),
    // The workspace pulse: one monotonic sequence of what happened, pruned to a
    // ring so an orchestrator asleep for a week wakes to a truncation flag
    // rather than to a table that grew all week. `Applies::Both`, like every
    // orchestrator table below: the `chats`/`chat_messages` pair was
    // DesktopOnly, never reached a server, and had to be dropped again.
    both(
        "create_moments",
        "CREATE TABLE IF NOT EXISTS moments (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            project_id TEXT,
            object_id TEXT,
            detail TEXT NOT NULL,
            source TEXT NOT NULL,
            at INTEGER NOT NULL
        );",
    ),
    // The durable half of the orchestrator conversation. The harness session is
    // disposable; these rows are what a restarted session is briefed from.
    both(
        "create_orchestrator_messages",
        "CREATE TABLE IF NOT EXISTS orchestrator_messages (
            id TEXT PRIMARY KEY,
            scope TEXT,
            role TEXT NOT NULL,
            text TEXT NOT NULL,
            aloud TEXT,
            urgency TEXT,
            at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_orchestrator_messages_scope
            ON orchestrator_messages (scope, at);",
    ),
    // A dispatch is a row, never a byte: the orchestrator queues a line here
    // and the device that owns the target PTY is the only thing that types it.
    both(
        "create_dispatches",
        "CREATE TABLE IF NOT EXISTS dispatches (
            id TEXT PRIMARY KEY,
            from_thread_id TEXT NOT NULL,
            to_thread_id TEXT NOT NULL,
            text TEXT NOT NULL,
            mode TEXT NOT NULL,
            state TEXT NOT NULL,
            reason TEXT,
            created_at INTEGER NOT NULL,
            settled_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_dispatches_open ON dispatches (state, to_thread_id);",
    ),
    // What the orchestrator caused, one row per spawn, claimed branch, worktree
    // or todo, so the inbox can offer to undo the reversible ones. Nothing
    // committed is ever destroyed through this table.
    both(
        "create_orchestrator_actions",
        "CREATE TABLE IF NOT EXISTS orchestrator_actions (
            id TEXT PRIMARY KEY,
            orchestrator_thread_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            object_id TEXT,
            project_id TEXT,
            undoable INTEGER NOT NULL DEFAULT 0,
            at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_orchestrator_actions_owner
            ON orchestrator_actions (orchestrator_thread_id, at);",
    ),
    // When an action was undone, so the inbox stops offering it. A stamp
    // rather than a delete: what the orchestrator did stays on the record.
    both(
        "add_orchestrator_actions_undone",
        "ALTER TABLE orchestrator_actions ADD COLUMN undone_at INTEGER;",
    ),
    // Null leaves the agent's global MCP configuration alone. Once a project
    // has an explicit JSON list, that list is the complete allow-list, with an
    // empty list meaning no MCP server at all.
    both(
        "add_project_mcp_servers",
        "ALTER TABLE projects ADD COLUMN mcp_server_ids TEXT;",
    ),
    // The second thread runtime. A row keeps every terminal column it had:
    // `runtime` is what says which of the two drives it, and `terminal` is the
    // default so every row that already exists reads as one.
    both(
        "add_thread_runtime",
        "ALTER TABLE threads ADD COLUMN runtime TEXT NOT NULL DEFAULT 'terminal';
         ALTER TABLE threads ADD COLUMN pilot_driver TEXT;
         ALTER TABLE threads ADD COLUMN pilot_instance TEXT;
         ALTER TABLE threads ADD COLUMN pilot_model TEXT;
         ALTER TABLE threads ADD COLUMN pilot_options TEXT;",
    ),
    // The journal and the projected timeline of a pilot thread. `pilot_events`
    // is every canonical event that is worth keeping, `pilot_items` is what the
    // chat pane reads. A text delta is in neither, by design: one row per token
    // is the cost `docs/pilot.md` forbids outright.
    both(
        "create_pilot_tables",
        "CREATE TABLE IF NOT EXISTS pilot_events (
            thread_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            ts_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL,
            PRIMARY KEY (thread_id, seq)
        );
        CREATE TABLE IF NOT EXISTS pilot_items (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            turn_id TEXT,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
            body TEXT NOT NULL,
            created_ms INTEGER NOT NULL,
            updated_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pilot_items_thread ON pilot_items(thread_id, seq);",
    ),
];

/// The desktop's list: `(version, description, sql)`, versions from 1.
///
/// The tuple rather than a `tauri_plugin_sql::Migration` because this crate
/// does not depend on Tauri and should not start.
pub fn desktop() -> Vec<(i64, &'static str, &'static str)> {
    ALL.iter()
        .filter(|m| m.applies != Applies::ServerOnly)
        .enumerate()
        .map(|(i, m)| (i as i64 + 1, m.description, m.sql))
        .collect()
}

/// The server's list, in the order `PRAGMA user_version` counts.
pub fn server() -> Vec<&'static Migration> {
    ALL.iter()
        .filter(|m| m.applies != Applies::DesktopOnly)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both projections have to reproduce what actually shipped, because a
    /// database that already ran migration N will never run it again: an entry
    /// that moves is an entry that silently never applies. These two counts are
    /// the last versions each side released, and they are allowed to grow
    /// together from the end, never in the middle.
    #[test]
    fn the_shipped_order_is_preserved_on_both_sides() {
        let desktop = desktop();
        assert_eq!(desktop.len(), 32);
        assert_eq!(desktop[0], (1, "create_projects", ALL[0].sql));
        assert_eq!(desktop[4].1, "add_thread_session_and_icon");
        assert_eq!(desktop[8].1, "add_project_git_root", "no push table here");
        assert_eq!(desktop[15].1, "create_chats");
        assert_eq!(desktop[16].1, "drop_chats");
        assert_eq!(desktop[17].1, "add_project_worktrees");
        assert_eq!(desktop[18].1, "create_events");
        assert_eq!(desktop[19].1, "create_thread_keys");
        assert_eq!(desktop[20].1, "create_approvals");
        assert_eq!(desktop[21].1, "add_thread_ageing");

        let server = server();
        assert_eq!(server.len(), 32);
        assert_eq!(server[8].description, "create_push_subscriptions");
        assert_eq!(server[9].description, "add_project_git_root");
        assert_eq!(
            server[16].description,
            "add_project_worktrees",
            "the chat pair is desktop-only and must not shift this"
        );
        assert_eq!(server[17].description, "create_events");
        assert_eq!(server[18].description, "create_thread_keys");
        assert_eq!(server[19].description, "create_approvals");
        assert_eq!(server[20].description, "add_thread_ageing");
        assert_eq!(server[21].description, "create_pairings");
        assert_eq!(desktop[23].1, "add_thread_orchestration");
        assert_eq!(server[23].description, "add_thread_orchestration");
        assert_eq!(desktop[27].1, "create_orchestrator_actions");
        assert_eq!(server[27].description, "create_orchestrator_actions");
        assert!(
            !server.iter().any(|m| m.description.contains("chat")),
            "no chat migration ever ran on a server"
        );
    }

    /// **Reformatting a shipped migration bricks the desktop app.**
    ///
    /// tauri-plugin-sql runs on sqlx, and sqlx keeps a `_sqlx_migrations` table
    /// holding a SHA-384 of the SQL of every migration it applied. On startup
    /// it compares each one against the list it was handed and refuses to open
    /// the database if any digest moved. So the text of an entry that has run
    /// somewhere is not source code any more, it is a value: reindenting it,
    /// unwrapping a line continuation, or adding a space after a comma is an
    /// app that will not start for anyone who already had it.
    ///
    /// These digests were read out of a real 1.0.2 database. A failure here is
    /// not a stale test: it means the entry named would be rejected on every
    /// machine that already ran it. Fix the SQL back, do not update the hash.
    /// A genuinely new statement is a new entry appended to `ALL`.
    #[test]
    fn no_shipped_migration_can_be_reformatted() {
        use sha2::{Digest, Sha384};

        // Read from `_sqlx_migrations` on a database that had applied all 18.
        const SHIPPED: [(&str, &str); 18] = [
            ("create_projects", "51a0c4adedefc796feb6a8b1dc7a8b0cb96abec6307947d55242a9b11ef8933cf090930c9ea13deeb642157373700505"),
            ("add_project_icon", "4cb16de3d5972b38347ad378685379adf475f25638ae99c2c2b4489d718e30dddf86e731b6ae7d129bf21d6b430f61f6"),
            ("create_settings", "0d68046cf78fd5b925ac3391f005002ddb767871c585a43e3f8cd1c16bbda4d7fb0072b485bd0c18e27fea3a1e5e0732"),
            ("create_threads", "5701ac448acf9e2ed3a493656d6c37eccf542ff3a4d5a0d13e77327eb50458c6daabc680a9a03796d441c23572412326"),
            ("add_thread_session_and_icon", "4021d34bc41e9e70eb89c818fcc1f579a93067a5dd6c6150f83b2068939e820922a1bc3ffb2780635f91ee923dc97ba9"),
            ("add_project_archived", "cfda41b5e7b3f12b4227bb8c168de1a06c6eebe0a83ad04dba27b91d14d325bc4e73cd081753f0618b1a13127bfbdd88"),
            ("add_thread_status_and_autoslept", "32721479e2ee18e94cb481079a08b32166b28a305f12cf31bbd611812fe113f4f5b1bee428b4c687c8e6b9c5a3c699d4"),
            ("add_thread_keep_awake", "5424cb0b64df0f46d8abc76fad7a8d1c0c3d58d2b82c00e336b381eac2d34a877e65da249174d1013e76c2cff5b04242"),
            ("add_project_git_root", "e434ffdf2a407681f9a769fdb2877e1a421957af6e8335bad0a5daf2e9b038b8ad37cea80b85458797e418ecc59c29df"),
            ("add_thread_icon_color", "b77f293d205fd3b59a3fd720c7b7d169cda99ba43e2fd947c6852ff0b17bc70d8750108fc088dedb8bfa7fe58679f6e0"),
            ("create_todos", "f587d14f2855b62d3eb0a8d677481016578e4dfe80daba46ea97eda36d8f2dbfd398e2173f239ff405be855e3694b769"),
            ("add_todo_commit", "d8955fc034a36ec61c4c3d9f7406030d93a7b4513d98ced4fe25d48b6233b2b4b2ee593e37a231fd2b0887ef50ccf3e3"),
            ("add_todo_claimed_by", "303846f041e8c20005daa944304e74fe01f222d23a97e3c1df10f2fe0892500da37657cf0e2c93a0ab8df461d1e01b06"),
            ("add_thread_worktree_path", "2deeb2943b2aa447fded8802dd68007f25f975ced3606e56a2e302c543221766277556d5adef7cc451723bf0c44712bd"),
            ("add_todo_description", "267d3d253f96bab7e67d211a3af6482e0b4f7903e2131da2afd725e786242c70947a5785a16ab1167cf3138a1af6abd6"),
            ("create_chats", "61cab91576713d9d2b7faabf333eceab777a2390b91e291729807dc622c089ca4fab72b51bc5ca3120ad2fe754ab7b68"),
            ("drop_chats", "cefffc74eb86281b248d3deeec8680ee3565061206f05ec44a12ee23230d230dd5c518faa8aa619d1efe9582cf474b23"),
            ("add_project_worktrees", "6a415706d7bc1902164f56e65f9ace11074ebfc4f28d7637ccbfc3111a08f908ff86636479129449c3e0a5db5d727e7d"),
        ];

        let desktop = desktop();
        for (i, (description, expected)) in SHIPPED.iter().enumerate() {
            let (version, actual_description, sql) = desktop[i];
            assert_eq!(
                actual_description, *description,
                "version {version} changed identity"
            );
            let digest: String = Sha384::digest(sql.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(
                &digest, expected,
                "version {version} ({description}) no longer hashes to what shipped. \
                 sqlx will refuse to open every database that already applied it. \
                 Restore the SQL text; do not update this hash."
            );
        }
    }

    /// Versions are dense and start at 1: tauri-plugin-sql applies them in
    /// order and a gap would leave the rest unapplied.
    #[test]
    fn desktop_versions_are_dense_from_one() {
        for (i, (version, _, _)) in desktop().iter().enumerate() {
            assert_eq!(*version, i as i64 + 1);
        }
    }

    /// Applying every migration has to produce the schema the code reads. This
    /// is the check that catches a mistyped column while moving SQL between
    /// files, which is exactly the kind of edit this module was created by.
    #[test]
    fn the_desktop_schema_is_what_the_app_expects() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for (_, description, sql) in desktop() {
            conn.execute_batch(sql)
                .unwrap_or_else(|e| panic!("{description}: {e}"));
        }
        assert_eq!(
            columns(&conn, "projects"),
            ["id", "name", "cwd", "default_cmd", "default_args", "created_at", "icon", "archived", "git_root", "worktrees", "mcp_server_ids"]
        );
        assert_eq!(
            columns(&conn, "threads"),
            ["id", "project_id", "label", "title", "cmd", "args", "exit_code", "created_at", "session_id", "icon_key", "status", "auto_slept", "keep_awake", "icon_color", "worktree_path", "pin_order", "settled_at", "snoozed_until", "parent_thread_id", "delegation_mode", "delegation_status", "role", "orchestrator_scope", "accept_dispatch", "runtime", "pilot_driver", "pilot_instance", "pilot_model", "pilot_options"]
        );
        assert_eq!(
            columns(&conn, "pilot_events"),
            ["thread_id", "seq", "ts_ms", "kind", "payload"]
        );
        assert_eq!(
            columns(&conn, "pilot_items"),
            ["id", "thread_id", "seq", "turn_id", "kind", "state", "body", "created_ms",
             "updated_ms"]
        );
        assert_eq!(
            columns(&conn, "moments"),
            ["seq", "kind", "project_id", "object_id", "detail", "source", "at"]
        );
        assert_eq!(
            columns(&conn, "orchestrator_messages"),
            ["id", "scope", "role", "text", "aloud", "urgency", "at"]
        );
        assert_eq!(
            columns(&conn, "dispatches"),
            ["id", "from_thread_id", "to_thread_id", "text", "mode", "state", "reason",
             "created_at", "settled_at"]
        );
        assert_eq!(
            columns(&conn, "orchestrator_actions"),
            ["id", "orchestrator_thread_id", "kind", "object_id", "project_id", "undoable", "at",
             "undone_at"]
        );
        assert_eq!(
            columns(&conn, "todos"),
            ["id", "project_id", "text", "state", "note", "position", "created_at", "updated_at", "commit_sha", "claimed_by", "description"]
        );
        assert_eq!(columns(&conn, "settings"), ["key", "value"]);
        assert_eq!(columns(&conn, "thread_keys"), ["thread_id", "public_key"]);
        assert_eq!(
            columns(&conn, "approvals"),
            ["id", "project_id", "thread_id", "action", "detail", "request", "verdict",
             "created_at", "decided_at"]
        );
        assert!(columns(&conn, "chats").is_empty(), "dropped again by 17");
        assert!(
            columns(&conn, "push_subscriptions").is_empty(),
            "a browser holds these, not a desktop window"
        );
        assert!(
            columns(&conn, "pairings").is_empty(),
            "a desktop window is a device, not a host that pairs them"
        );
    }

    #[test]
    fn the_server_schema_is_what_the_store_expects() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for m in server() {
            conn.execute_batch(m.sql)
                .unwrap_or_else(|e| panic!("{}: {e}", m.description));
        }
        assert_eq!(
            columns(&conn, "push_subscriptions"),
            ["endpoint", "p256dh", "auth", "created_at"]
        );
        // The columns a client reads over the wire have to exist on both sides;
        // one missing here is a claim that loses its commit against a remote
        // boite and nowhere else.
        for column in ["commit_sha", "claimed_by", "description"] {
            assert!(columns(&conn, "todos").contains(&column.to_string()), "{column}");
        }
        for column in ["pin_order", "settled_at", "snoozed_until", "role", "orchestrator_scope", "accept_dispatch", "runtime", "pilot_driver", "pilot_instance", "pilot_model", "pilot_options"] {
            assert!(columns(&conn, "threads").contains(&column.to_string()), "{column}");
        }
        for table in ["moments", "orchestrator_messages", "dispatches", "orchestrator_actions",
                      "pilot_events", "pilot_items"] {
            assert!(!columns(&conn, table).is_empty(), "{table} must exist on a server too");
        }
        assert_eq!(
            columns(&conn, "pairings"),
            ["id", "label", "kind", "scopes", "secret_hash", "created_at", "last_seen_at",
             "revoked_at"]
        );
        assert_eq!(
            columns(&conn, "pairing_tokens"),
            ["id", "label", "kind", "scopes", "secret_hash", "created_at", "expires_at",
             "used_at"]
        );
        assert!(columns(&conn, "chats").is_empty());
    }

    fn columns(conn: &rusqlite::Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        rows
    }
}
