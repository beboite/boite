//! The rows a workspace is made of: projects, threads, todos, settings.
//!
//! The last domain that was read two ways. The server had fifteen hand-written
//! RPC arms over `Store`; the desktop had eight SQL statements in
//! `src/lib/backend/tauri/db.ts`, sent straight from the webview through
//! tauri-plugin-sql. One schema, two readers, and nothing that could notice when
//! they stopped agreeing.
//!
//! They had already stopped. [`Records::ThreadCreate`] carries the difference:
//! the server refuses to take a client's word for a thread's runtime state and
//! the desktop did not, so a stale snapshot in the window could put `running`
//! back on a thread whose process had ended. The desktop knew about the shape of
//! the problem — `updateThreadTitle` exists precisely because a whole-row
//! `REPLACE` clobbers concurrent writes — and had solved it for one column.
//!
//! What is deliberately *not* here: the side effects each host wraps around
//! these. The server broadcasts an `AppEvent`, refreshes its roots and kills a
//! PTY; the desktop removes a key file. Those are things a host does about a
//! row changing, not the row changing, and a bus that owned them would need a
//! `Host` method per host quirk.

use serde_json::{json, Value};

use super::{str_param, value_of, Host, Ready, Wire};
use crate::capability::Capability;
use crate::model::{Project, Thread, Todo};
use crate::store::{ColVal, Store, ThreadCol};

/// Every method in this domain, in the order they appear below.
pub const ALL_METHODS: &[&str] = &[
    "project.list",
    "project.create",
    "project.archive",
    "project.delete",
    "thread.list",
    "thread.create",
    "thread.update",
    "thread.started",
    "thread.delete",
    "todo.list",
    "todo.save",
    "todo.delete",
    "settings.get",
    "settings.set",
    "workspace.info",
    "workspace.setInfo",
];

/// The longest a workspace name or colour is kept.
///
/// Cosmetic identity, and it travels to every connected device on every change,
/// so it is bounded on the way in rather than at each place that draws it.
const MAX_WORKSPACE_FIELD: usize = 64;

/// Whether a workspace colour is a colour.
///
/// The value lands in a CSS custom property on every connected client, so
/// anything that is not `#rgb` or `#rrggbb` is dropped rather than stored. The
/// server had this check and the desktop did not, which is the shape of every
/// other difference this domain ended.
fn is_hex_color(s: &str) -> bool {
    let Some(hex) = s.strip_prefix('#') else {
        return false;
    };
    (hex.len() == 3 || hex.len() == 6) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Which fields of a thread row a caller asked to change.
///
/// An absent field and a field set to null are different answers: the first
/// leaves the column alone, the second clears it. A struct of `Option<Option<_>>`
/// would say that in the type and read worse than the two lines it saves.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThreadPatch {
    pub label: Option<String>,
    pub title: Option<Option<String>>,
    pub icon_key: Option<Option<String>>,
    pub session_id: Option<Option<String>>,
    pub keep_awake: Option<bool>,
}

impl ThreadPatch {
    fn read(params: &Value) -> Self {
        let nullable = |key: &str| {
            params
                .get(key)
                .map(|v| v.as_str().map(|s| s.to_string()))
        };
        ThreadPatch {
            label: params.get("label").and_then(|v| v.as_str()).map(|s| s.to_string()),
            title: nullable("title"),
            icon_key: nullable("iconKey"),
            session_id: nullable("sessionId"),
            keep_awake: params.get("keepAwake").and_then(|v| v.as_bool()),
        }
    }

    /// The columns to write, in the order they were read.
    fn columns(self) -> Vec<(ThreadCol, ColVal)> {
        let text = |v: Option<String>| v.map(ColVal::Text).unwrap_or(ColVal::Null);
        let mut out = Vec::new();
        if let Some(label) = self.label {
            out.push((ThreadCol::Label, ColVal::Text(label)));
        }
        if let Some(title) = self.title {
            out.push((ThreadCol::Title, text(title)));
        }
        if let Some(icon) = self.icon_key {
            out.push((ThreadCol::IconKey, text(icon)));
        }
        if let Some(session) = self.session_id {
            out.push((ThreadCol::SessionId, text(session)));
        }
        if let Some(keep) = self.keep_awake {
            out.push((ThreadCol::KeepAwake, ColVal::Int(keep as i64)));
        }
        out
    }
}

/// No `PartialEq`: the row types it carries are what the database and the wire
/// agree on, and giving them an equality would invite a comparison that means
/// "same row" in one place and "same contents" in another.
#[derive(Debug, Clone)]
pub enum Records {
    ProjectList,
    /// Writes a project row, new or not.
    ///
    /// The name says create because that is the wire name both front doors
    /// already used, and because `INSERT OR REPLACE` is what is underneath.
    ProjectCreate {
        project: Box<Project>,
    },
    ProjectArchive {
        id: String,
        archived: bool,
    },
    ProjectDelete {
        id: String,
    },
    /// Every thread row, as persisted.
    ///
    /// Rows only. Which of them has a process behind it right now is the host's
    /// answer, not the table's, and the two lists being separate is what makes a
    /// row that says `running` about a dead process visible at all.
    ThreadList,
    /// Writes a thread row, keeping whatever the table already says about its
    /// run.
    ///
    /// This doubles as create and re-save: a session id captured after launch, a
    /// renamed label, an icon change. The caller is the window, and the window's
    /// copy of `status` and `exitCode` is a snapshot that may be older than the
    /// process. So an existing row keeps its persisted ending, and only a
    /// genuinely new one starts `idle`.
    ///
    /// `Store::thread_status` is what "persisted" means, raw: how the run ended,
    /// or the mark [`Records::ThreadStarted`] left on it. The answer is what that
    /// mark *means* (`boite_core::store::display_status`), so the window is told
    /// `stopped` about a row that still names a process.
    ThreadCreate {
        thread: Box<Thread>,
    },
    ThreadUpdate {
        id: String,
        patch: ThreadPatch,
    },
    /// A process is behind this thread now.
    ///
    /// The one status write the window is allowed, and it is not a claim about
    /// the present: `running`, `ready` and `waiting` come and go several times a
    /// turn and none of them is worth a write. What the row records is that the
    /// thread was on during this run of the app, which is the only way a later
    /// launch can tell a thread that was cut off from one that has never been
    /// started — and drawing those two the same way is what made every row on
    /// screen asleep on every boot.
    ///
    /// The exit code goes with it: it belongs to the run that ended, and a
    /// relaunched thread carrying the last one is a row that reports a failure it
    /// has already been forgiven for.
    ThreadStarted {
        id: String,
    },
    /// Removes the row and the key bound to it.
    ///
    /// The public key is looked up on the row, so the identity grants nothing
    /// once the row is gone. Removed anyway rather than left to accumulate one
    /// per thread ever opened, and because a reused id would otherwise inherit
    /// an owner it never had. The key *file* is a host's own directory and each
    /// one removes its own.
    ThreadDelete {
        id: String,
    },
    TodoList,
    TodoSave {
        todo: Box<Todo>,
    },
    TodoDelete {
        id: String,
    },
    SettingsGet,
    SettingsSet {
        settings: Value,
    },
    /// The workspace's own name and colour, so any connected device sees the
    /// same boite.
    WorkspaceInfo,
    WorkspaceSetInfo {
        /// Absent leaves it, present-and-blank clears the override.
        name: Option<Option<String>>,
        color: Option<Option<String>>,
    },
}

impl Records {
    pub(super) fn decode(method: &str, params: &Value) -> Result<Self, String> {
        let of = |key: &str| {
            params
                .get(key)
                .cloned()
                .ok_or_else(|| format!("missing param: {key}"))
        };
        let nullable = |key: &str| {
            params
                .get(key)
                .map(|v| v.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        };
        Ok(match method {
            "project.list" => Records::ProjectList,
            "project.create" => Records::ProjectCreate {
                project: Box::new(
                    serde_json::from_value(of("project")?)
                        .map_err(|e| format!("bad project: {e}"))?,
                ),
            },
            "project.archive" => Records::ProjectArchive {
                id: str_param(params, "id")?,
                archived: params
                    .get("archived")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            },
            "project.delete" => Records::ProjectDelete {
                id: str_param(params, "id")?,
            },
            "thread.list" => Records::ThreadList,
            "thread.create" => Records::ThreadCreate {
                thread: Box::new(
                    serde_json::from_value(of("thread")?).map_err(|e| format!("bad thread: {e}"))?,
                ),
            },
            "thread.update" => Records::ThreadUpdate {
                id: str_param(params, "threadId")?,
                patch: ThreadPatch::read(params),
            },
            "thread.started" => Records::ThreadStarted {
                id: str_param(params, "threadId")?,
            },
            "thread.delete" => Records::ThreadDelete {
                id: str_param(params, "threadId")?,
            },
            "todo.list" => Records::TodoList,
            "todo.save" => Records::TodoSave {
                todo: Box::new(
                    serde_json::from_value(of("todo")?).map_err(|e| format!("bad todo: {e}"))?,
                ),
            },
            "todo.delete" => Records::TodoDelete {
                id: str_param(params, "todoId")?,
            },
            "settings.get" => Records::SettingsGet,
            "settings.set" => Records::SettingsSet {
                settings: of("settings")?,
            },
            "workspace.info" => Records::WorkspaceInfo,
            "workspace.setInfo" => Records::WorkspaceSetInfo {
                name: nullable("name"),
                color: nullable("color"),
            },
            other => return Err(format!("unknown method: {other}")),
        })
    }

    pub(super) fn name(&self) -> &'static str {
        match self {
            Records::ProjectList => "project.list",
            Records::ProjectCreate { .. } => "project.create",
            Records::ProjectArchive { .. } => "project.archive",
            Records::ProjectDelete { .. } => "project.delete",
            Records::ThreadList => "thread.list",
            Records::ThreadCreate { .. } => "thread.create",
            Records::ThreadUpdate { .. } => "thread.update",
            Records::ThreadStarted { .. } => "thread.started",
            Records::ThreadDelete { .. } => "thread.delete",
            Records::TodoList => "todo.list",
            Records::TodoSave { .. } => "todo.save",
            Records::TodoDelete { .. } => "todo.delete",
            Records::SettingsGet => "settings.get",
            Records::SettingsSet { .. } => "settings.set",
            Records::WorkspaceInfo => "workspace.info",
            Records::WorkspaceSetInfo { .. } => "workspace.setInfo",
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            Records::ProjectList => Wire::Key("projects"),
            Records::ProjectCreate { .. } => Wire::Key("project"),
            Records::ThreadList => Wire::Key("threads"),
            Records::ThreadCreate { .. } => Wire::Key("thread"),
            Records::TodoList => Wire::Key("todos"),
            Records::SettingsGet => Wire::Key("settings"),
            // Both halves of the answer are already named, so wrapping it again
            // would give a remote client `{"info":{"name":...}}` where the
            // desktop reads `{"name":...}`.
            Records::WorkspaceInfo => Wire::Bare,
            Records::ProjectArchive { .. }
            | Records::ProjectDelete { .. }
            | Records::ThreadUpdate { .. }
            | Records::ThreadStarted { .. }
            | Records::ThreadDelete { .. }
            | Records::TodoSave { .. }
            | Records::TodoDelete { .. }
            | Records::SettingsSet { .. }
            | Records::WorkspaceSetInfo { .. } => Wire::Ok,
        }
    }

    /// What a caller has to hold.
    ///
    /// Four of these are `MutateAcross`, and that is the documented meaning of
    /// the word rather than caution: creating a project, deleting one, and
    /// deleting a thread are exactly the calls the capability doc names as
    /// "reaching past the project the caller is in". A credentials file issued
    /// for one project cannot decide the workspace has one fewer.
    ///
    /// `project.list` is a read and stays one. It names every project the boite
    /// has, which is what a device connecting to it needs before it can ask
    /// about any of them, and it exposes no more than the sidebar the user is
    /// already looking at.
    pub(super) fn capability(&self) -> Capability {
        match self {
            Records::ProjectList
            | Records::ThreadList
            | Records::TodoList
            | Records::SettingsGet
            | Records::WorkspaceInfo => Capability::ReadProject,

            Records::ProjectArchive { .. }
            | Records::ThreadCreate { .. }
            | Records::ThreadUpdate { .. }
            | Records::ThreadStarted { .. }
            | Records::TodoSave { .. }
            | Records::TodoDelete { .. }
            | Records::SettingsSet { .. }
            | Records::WorkspaceSetInfo { .. } => Capability::MutateProject,

            Records::ProjectCreate { .. }
            | Records::ProjectDelete { .. }
            | Records::ThreadDelete { .. } => Capability::MutateAcross,
        }
    }

    /// The store is resolved here, which is the whole reason this domain has a
    /// `Ready` arm of its own.
    ///
    /// A host with no records says so instead of answering with nothing: "there
    /// are no projects" and "this Boite keeps no rows" send whoever is reading
    /// to two different places. A test host is the honest case of the second.
    pub(super) fn prepare(self, host: &dyn Host) -> Result<Ready, String> {
        // Where a project may go is the one boundary a record command has, and
        // it is the same one `project.createFolder` answers to. Not an
        // existence check: this doubles as a re-save, and a project on a drive
        // that is unplugged today is still a project.
        if let Records::ProjectCreate { project } = &self {
            host.ensure_new_project_path(&project.cwd)?;
        }
        let store = host
            .store()
            .ok_or("this Boite keeps no records, so there is nothing to read or write")?;
        Ok(Ready::Records(self, store))
    }

    pub(super) fn run(self, store: &Store) -> Result<Value, String> {
        Ok(match self {
            Records::ProjectList => value_of(store.load_projects()?),
            Records::ProjectCreate { project } => {
                store.save_project(&project, crate::now_ms())?;
                value_of(*project)
            }
            Records::ProjectArchive { id, archived } => {
                store.set_project_archived(&id, archived)?;
                json!(null)
            }
            Records::ProjectDelete { id } => {
                store.delete_project(&id)?;
                json!(null)
            }
            Records::ThreadList => value_of(store.load_threads()?),
            Records::ThreadCreate { thread } => {
                let mut thread = *thread;
                if thread.created_at == 0 {
                    thread.created_at = crate::now_ms();
                }
                // A pty id belongs to a run, never to a row.
                thread.pty_id = None;
                match store.thread_status(&thread.id) {
                    Some((status, exit_code)) => {
                        thread.status = status;
                        thread.exit_code = exit_code;
                    }
                    None => {
                        thread.status = "idle".to_string();
                        thread.exit_code = None;
                    }
                }
                store.save_thread(&thread)?;
                // The row keeps the mark of its last run; the caller is told what
                // that mark means, which for a row still naming a process is
                // `stopped` rather than the word itself.
                thread.status = crate::store::display_status(Some(&thread.status));
                value_of(thread)
            }
            Records::ThreadUpdate { id, patch } => {
                for (col, val) in patch.columns() {
                    store.update_thread_field(&id, col, val)?;
                }
                json!(null)
            }
            Records::ThreadStarted { id } => {
                store.update_thread_field(
                    &id,
                    ThreadCol::Status,
                    ColVal::Text("running".to_string()),
                )?;
                store.update_thread_field(&id, ThreadCol::ExitCode, ColVal::Null)?;
                json!(null)
            }
            Records::ThreadDelete { id } => {
                store.delete_thread(&id)?;
                store.forget_thread_identity(&id)?;
                json!(null)
            }
            Records::TodoList => value_of(store.load_todos()?),
            Records::TodoSave { todo } => {
                store.save_todo(&todo)?;
                json!(null)
            }
            Records::TodoDelete { id } => {
                store.delete_todo(&id)?;
                json!(null)
            }
            Records::SettingsGet => store.load_settings()?,
            Records::SettingsSet { settings } => {
                store.save_settings(&settings)?;
                json!(null)
            }
            Records::WorkspaceInfo => {
                let meta = store.load_workspace_meta()?;
                json!({
                    "name": meta.get("name").and_then(|v| v.as_str()),
                    "color": meta.get("color").and_then(|v| v.as_str()),
                    // Not stored beside the cosmetic pair: it is what this
                    // binary is, not what someone named it. Every crate in the
                    // workspace carries the same version as the app, so the
                    // one compiled in here is the boite's own version, and a
                    // device can tell a server it is about to connect to from
                    // one that is behind its own build.
                    "version": env!("CARGO_PKG_VERSION"),
                })
            }
            Records::WorkspaceSetInfo { name, color } => {
                let mut meta = store.load_workspace_meta()?;
                let obj = meta.as_object_mut().ok_or("corrupt workspace meta")?;
                for (key, given) in [("name", name), ("color", color)] {
                    let Some(given) = given else { continue };
                    match given {
                        // A colour that is not one is dropped and the previous
                        // value stays, rather than being stored or clearing what
                        // was there. Refusing the whole call would fail a rename
                        // that happened to travel beside a bad colour.
                        Some(value) if key == "color" && !is_hex_color(&value) => {}
                        Some(value) => {
                            let capped: String = value.chars().take(MAX_WORKSPACE_FIELD).collect();
                            obj.insert(key.into(), json!(capped));
                        }
                        // Explicit null or blank clears the override, and the
                        // host's own name shows through again.
                        None => {
                            obj.remove(key);
                        }
                    }
                }
                store.save_workspace_meta(&meta)?;
                json!(null)
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::capability::Grant;
    use crate::command::{Command, Host};
    use crate::scope::ProjectRoots;

    /// A host that keeps rows, and nothing else.
    struct Rows {
        roots: ProjectRoots,
        store: Arc<Store>,
    }

    impl Rows {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "boite-records-{}-{name}.db",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&path);
            Rows {
                roots: ProjectRoots::default(),
                store: Arc::new(Store::open(&path).unwrap()),
            }
        }
    }

    impl Host for Rows {
        fn roots(&self) -> &ProjectRoots {
            &self.roots
        }
        fn store(&self) -> Option<Arc<Store>> {
            Some(self.store.clone())
        }
    }

    /// A host with no rows behind it, which is what the trait's default is.
    struct Nothing(ProjectRoots);
    impl Host for Nothing {
        fn roots(&self) -> &ProjectRoots {
            &self.0
        }
    }

    fn ask(host: &dyn Host, method: &str, params: Value) -> Result<Value, String> {
        Command::decode(method, &params)?
            .prepare(host, Grant::Local)?
            .run()
    }

    #[test]
    fn every_method_decodes_and_names_itself_back() {
        let params = json!({
            "project": { "id": "p", "name": "n", "cwd": ".", "icon": null },
            "thread": { "id": "t", "projectId": "p", "label": "l", "cmd": "c" },
            "todo": { "id": "d", "projectId": "p", "title": "t", "state": "open",
                      "createdAt": 0, "updatedAt": 0 },
            "id": "p", "threadId": "t", "todoId": "d", "settings": {},
        });
        for method in ALL_METHODS {
            let command = Command::decode(method, &params)
                .unwrap_or_else(|err| panic!("{method} did not decode: {err}"));
            assert_eq!(command.name(), *method);
        }
    }

    /// The divergence this domain was built to end.
    ///
    /// The window's copy of a thread is a snapshot, and a re-save built from one
    /// used to be able to put `running` back on a thread whose process had ended.
    #[test]
    fn a_resave_cannot_hand_a_finished_thread_its_run_back() {
        let host = Rows::new("resave");
        let row = |status: &str, exit: Value| {
            json!({ "thread": { "id": "t", "projectId": "p", "label": "l", "cmd": "c",
                                "args": [], "status": status, "exitCode": exit } })
        };
        // A new row starts idle whatever the caller claimed. There is no run
        // behind it yet, and the client is not the one who would know.
        let created = ask(&host, "thread.create", row("running", json!(null))).unwrap();
        assert_eq!(created["status"], json!("idle"));

        // The process ends. That is written by whatever was watching it — the
        // registry on the server, the PTY reader on the desktop — through the
        // two columns no patch exposes, which is why `ThreadPatch` does not
        // carry them.
        let store = host.store().unwrap();
        store
            .update_thread_field("t", ThreadCol::Status, ColVal::Text("exited".into()))
            .unwrap();
        store
            .update_thread_field("t", ThreadCol::ExitCode, ColVal::Int(3))
            .unwrap();

        // Now a window whose copy predates all of that re-saves the row, to
        // capture a session id or a renamed label. The ending survives.
        let resaved = ask(&host, "thread.create", row("running", json!(null))).unwrap();
        assert_eq!(resaved["status"], json!("exited"), "a stale snapshot revived a dead thread");
        assert_eq!(resaved["exitCode"], json!(3));
    }

    /// The one status the window writes, and what a re-save does to it.
    ///
    /// The mark has to survive everything the window writes about a thread while
    /// it runs, because a session id captured a second after launch is a re-save
    /// — and a re-save that stored what the row *reads as* would turn the mark
    /// into `stopped`, which the next boot would then decay to nothing. The
    /// thread would have been on and would come back drawn as one that never ran.
    #[test]
    fn a_launch_is_written_down_and_a_resave_keeps_it() {
        let host = Rows::new("started");
        let row = json!({ "thread": { "id": "t", "projectId": "p", "label": "l",
                                      "cmd": "c", "args": [] } });
        let created = ask(&host, "thread.create", row.clone()).unwrap();
        assert_eq!(created["status"], json!("idle"), "nothing has run yet");

        ask(&host, "thread.started", json!({ "threadId": "t" })).unwrap();
        let threads = ask(&host, "thread.list", json!({})).unwrap();
        assert_eq!(threads[0]["status"], json!("stopped"), "a run this host did not spawn");

        // What the table holds is the mark itself, so the re-save writes back a
        // launch rather than a sleep.
        assert_eq!(host.store.thread_status("t").unwrap().0, "running");
        ask(&host, "thread.create", row).unwrap();
        assert_eq!(host.store.thread_status("t").unwrap().0, "running");
    }

    /// An absent field leaves a column alone; an explicit null clears it. A patch
    /// that could not tell those apart would wipe a title on every keep-awake
    /// toggle.
    #[test]
    fn an_absent_field_and_an_explicit_null_are_different_answers() {
        let host = Rows::new("patch");
        ask(
            &host,
            "thread.create",
            json!({ "thread": { "id": "t", "projectId": "p", "label": "l",
                                "cmd": "c", "args": [], "title": "kept" } }),
        )
        .unwrap();

        // Touching only keepAwake leaves the title where it was.
        ask(&host, "thread.update", json!({ "threadId": "t", "keepAwake": true })).unwrap();
        let threads = ask(&host, "thread.list", json!({})).unwrap();
        assert_eq!(threads[0]["title"], json!("kept"));

        // An explicit null clears it.
        ask(&host, "thread.update", json!({ "threadId": "t", "title": null })).unwrap();
        let threads = ask(&host, "thread.list", json!({})).unwrap();
        assert_eq!(threads[0]["title"], json!(null));
    }

    /// A blank name clears the override rather than storing a blank one, and a
    /// long one is cut on the way in rather than by whoever draws it.
    #[test]
    fn a_workspace_name_is_bounded_and_a_blank_one_clears_it() {
        let host = Rows::new("workspace");
        let long = "x".repeat(MAX_WORKSPACE_FIELD * 3);
        ask(&host, "workspace.setInfo", json!({ "name": long })).unwrap();
        let info = ask(&host, "workspace.info", json!({})).unwrap();
        assert_eq!(info["name"].as_str().unwrap().chars().count(), MAX_WORKSPACE_FIELD);

        ask(&host, "workspace.setInfo", json!({ "name": "   " })).unwrap();
        let info = ask(&host, "workspace.info", json!({})).unwrap();
        assert_eq!(info["name"], json!(null));
    }

    /// The version comes from the binary, not from the meta blob, so it answers
    /// on a workspace nobody has ever named and no `setInfo` can rewrite it.
    #[test]
    fn a_workspace_reports_the_version_it_runs() {
        // Its own store name: `Rows::new` keys the temp database on it, and two
        // tests sharing one race each other's migrations under the test runner.
        let host = Rows::new("workspace-version");
        let info = ask(&host, "workspace.info", json!({})).unwrap();
        assert_eq!(info["version"], json!(env!("CARGO_PKG_VERSION")));

        ask(&host, "workspace.setInfo", json!({ "version": "9.9.9" })).unwrap();
        let info = ask(&host, "workspace.info", json!({})).unwrap();
        assert_eq!(info["version"], json!(env!("CARGO_PKG_VERSION")));
    }

    /// A host that keeps no rows says so, rather than answering an empty list
    /// that reads as "there are none".
    #[test]
    fn a_host_with_no_records_says_so_instead_of_answering_nothing() {
        let host = Nothing(ProjectRoots::default());
        for method in ALL_METHODS {
            let err = ask(&host, method, json!({
                "project": { "id": "p", "name": "n", "cwd": ".", "icon": null },
                "thread": { "id": "t", "projectId": "p", "label": "l", "cmd": "c" },
                "todo": { "id": "d", "projectId": "p", "title": "t", "state": "open",
                          "createdAt": 0, "updatedAt": 0 },
                "id": "p", "threadId": "t", "todoId": "d", "settings": {},
            }))
            .err()
            .unwrap_or_else(|| panic!("{method} answered on a host with no store"));
            assert!(err.contains("keeps no records"), "{method}: {err}");
        }
    }

    /// Deleting a thread takes its identity with it. The row is what a public key
    /// is looked up on, so a reused id would otherwise inherit an owner.
    #[test]
    fn deleting_a_thread_takes_its_key_with_it() {
        let host = Rows::new("identity");
        ask(
            &host,
            "thread.create",
            json!({ "thread": { "id": "t", "projectId": "p", "label": "l", "cmd": "c", "args": [] } }),
        )
        .unwrap();
        let store = host.store().unwrap();
        store.bind_thread_identity("t", "pubkey").unwrap();
        assert!(store.public_key_of_thread("t").is_some());

        ask(&host, "thread.delete", json!({ "threadId": "t" })).unwrap();
        assert!(store.public_key_of_thread("t").is_none());
    }
}
