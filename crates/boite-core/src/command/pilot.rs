//! The `pilot.*` domain: threads driven by protocol rather than by a PTY.
//!
//! Same shape as every other domain, with one difference the whole design
//! turns on: the work is async and `boite-core` takes no executor. So this file
//! does what a bus does and stops there — decode, declare what the call needs,
//! check the caller's grant and the roots of the thread's own directory, read
//! the row and build the [`boite_pilot::OpenSpec`] out of it — and hands the
//! host a [`PilotReady`]. The host owns the tokio runtime and runs it through
//! [`crate::pilot_host::execute`], which is the same shape as `pulse_waiters`
//! and `child_pid`: a capability the bus validates and a resource only a host
//! has.
//!
//! `Host::pilot()` answers `None` on a host with no runtime — a test, a headless
//! CLI — and every method here refuses with that sentence rather than pretending
//! a thread has a session.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use boite_pilot::{ExecMode, Instance, McpServer, ModelSelection, OpenSpec, Options, TurnInput};

use super::{opt_str_param, str_param, Host, Ready, Wire};
use crate::capability::Capability;
use crate::model::RUNTIME_PILOT;
use crate::store::Store;

/// Every method in this domain, in the order the contract table lists them.
pub const ALL_METHODS: &[&str] = &[
    "pilot.catalog",
    "pilot.thread.open",
    "pilot.turn.start",
    "pilot.turn.interrupt",
    "pilot.request.respond",
    "pilot.model.set",
    "pilot.mode.set",
    "pilot.session.stop",
    "pilot.items",
    "pilot.events",
    "pilot.subscribe",
    "pilot.unsubscribe",
];

/// How many rows one cursor read answers with when the caller says nothing,
/// and the ceiling whatever it asks for is clamped to. A chat pane pages; a
/// client asking for a hundred thousand items is asking for the host's memory.
const READ_LIMIT_DEFAULT: usize = 200;
const READ_LIMIT_MAX: usize = 1000;

#[derive(Debug, Clone)]
pub enum Pilot {
    /// The drivers this build ships with their capabilities, the instances the
    /// settings blob declares, and the fastpick routes merged in as virtual
    /// ones.
    Catalog { refresh: bool },
    /// Start or resume the native session of a `runtime = pilot` row.
    Open { thread_id: String },
    /// A user turn. A turn already running receives the text as steering.
    TurnStart {
        thread_id: String,
        text: String,
        model: Option<String>,
    },
    TurnInterrupt { thread_id: String },
    /// The answer to an open request, by the option the driver offered.
    Respond {
        thread_id: String,
        request_id: String,
        option: String,
    },
    ModelSet {
        thread_id: String,
        model: Option<String>,
    },
    ModeSet { thread_id: String, mode: ExecMode },
    /// Polite stop. The native session stays resumable, which is what makes
    /// auto-sleep safe for a pilot thread.
    Stop { thread_id: String },
    Items {
        thread_id: String,
        after_seq: i64,
        limit: usize,
    },
    Events {
        thread_id: String,
        after_seq: i64,
        limit: usize,
    },
    /// A device asks to be pushed this thread's events. Which socket to push at
    /// is the transport's own bookkeeping; the bus answers whether it may.
    Subscribe { thread_id: String, on: bool },
}

/// A pilot call that has been through the boundary, with everything the host
/// needs to run it.
///
/// Carries the resolved store and runtime rather than the host, for the same
/// reason [`Ready::Records`] does: `Ready` outlives the host on purpose, and a
/// borrow would tie the whole bus to the lifetime of the call that built it.
pub struct PilotReady {
    pub call: Pilot,
    pub store: Arc<Store>,
    pub runtime: Arc<boite_pilot::Runtime>,
    /// Built at `prepare` for `pilot.thread.open`, out of the thread's own row.
    /// `None` for every other method.
    pub spec: Option<Box<OpenSpec>>,
}

/// Names itself and its call, and stops there. The spec carries a working
/// directory and an environment, which is not something to print into a log by
/// accident.
impl std::fmt::Debug for PilotReady {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PilotReady")
            .field("call", &self.call.name())
            .finish()
    }
}

impl Pilot {
    pub(super) fn decode(method: &str, params: &Value) -> Result<Self, String> {
        Ok(match method {
            "pilot.catalog" => Pilot::Catalog {
                refresh: params
                    .get("refresh")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            },
            "pilot.thread.open" => Pilot::Open {
                thread_id: str_param(params, "threadId")?,
            },
            "pilot.turn.start" => Pilot::TurnStart {
                thread_id: str_param(params, "threadId")?,
                text: str_param(params, "text")?,
                model: opt_str_param(params, "model"),
            },
            "pilot.turn.interrupt" => Pilot::TurnInterrupt {
                thread_id: str_param(params, "threadId")?,
            },
            "pilot.request.respond" => Pilot::Respond {
                thread_id: str_param(params, "threadId")?,
                request_id: str_param(params, "requestId")?,
                option: str_param(params, "option")?,
            },
            "pilot.model.set" => Pilot::ModelSet {
                thread_id: str_param(params, "threadId")?,
                model: opt_str_param(params, "model"),
            },
            "pilot.mode.set" => Pilot::ModeSet {
                thread_id: str_param(params, "threadId")?,
                mode: mode_of(opt_str_param(params, "mode").as_deref())?,
            },
            "pilot.session.stop" => Pilot::Stop {
                thread_id: str_param(params, "threadId")?,
            },
            "pilot.items" => Pilot::Items {
                thread_id: str_param(params, "threadId")?,
                after_seq: cursor(params),
                limit: limit(params),
            },
            "pilot.events" => Pilot::Events {
                thread_id: str_param(params, "threadId")?,
                after_seq: cursor(params),
                limit: limit(params),
            },
            "pilot.subscribe" => Pilot::Subscribe {
                thread_id: str_param(params, "threadId")?,
                on: true,
            },
            "pilot.unsubscribe" => Pilot::Subscribe {
                thread_id: str_param(params, "threadId")?,
                on: false,
            },
            other => return Err(format!("unknown pilot method: {other}")),
        })
    }

    pub(super) fn name(&self) -> &'static str {
        match self {
            Pilot::Catalog { .. } => "pilot.catalog",
            Pilot::Open { .. } => "pilot.thread.open",
            Pilot::TurnStart { .. } => "pilot.turn.start",
            Pilot::TurnInterrupt { .. } => "pilot.turn.interrupt",
            Pilot::Respond { .. } => "pilot.request.respond",
            Pilot::ModelSet { .. } => "pilot.model.set",
            Pilot::ModeSet { .. } => "pilot.mode.set",
            Pilot::Stop { .. } => "pilot.session.stop",
            Pilot::Items { .. } => "pilot.items",
            Pilot::Events { .. } => "pilot.events",
            Pilot::Subscribe { on: true, .. } => "pilot.subscribe",
            Pilot::Subscribe { on: false, .. } => "pilot.unsubscribe",
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            Pilot::Items { .. } => Wire::Key("items"),
            Pilot::Events { .. } => Wire::Key("events"),
            Pilot::Subscribe { .. } => Wire::Ok,
            _ => Wire::Bare,
        }
    }

    /// What a caller has to hold.
    ///
    /// Reading a timeline is a read, and so is asking to be pushed what is
    /// about to be written to it. Everything else spends the machine: a turn is
    /// an agent running tools in a checkout, and answering a request is what
    /// lets one run.
    pub(super) fn capability(&self) -> Capability {
        match self {
            Pilot::Catalog { .. }
            | Pilot::Items { .. }
            | Pilot::Events { .. }
            | Pilot::Subscribe { .. } => Capability::ReadProject,
            Pilot::Open { .. }
            | Pilot::TurnStart { .. }
            | Pilot::TurnInterrupt { .. }
            | Pilot::Respond { .. }
            | Pilot::ModelSet { .. }
            | Pilot::ModeSet { .. }
            | Pilot::Stop { .. } => Capability::MutateProject,
        }
    }

    /// The thread this call is about, or `None` for the one method that is
    /// about the machine rather than a thread.
    fn thread_id(&self) -> Option<&str> {
        match self {
            Pilot::Catalog { .. } => None,
            Pilot::Open { thread_id }
            | Pilot::TurnStart { thread_id, .. }
            | Pilot::TurnInterrupt { thread_id }
            | Pilot::Respond { thread_id, .. }
            | Pilot::ModelSet { thread_id, .. }
            | Pilot::ModeSet { thread_id, .. }
            | Pilot::Stop { thread_id }
            | Pilot::Items { thread_id, .. }
            | Pilot::Events { thread_id, .. }
            | Pilot::Subscribe { thread_id, .. } => Some(thread_id),
        }
    }

    pub(super) fn prepare(self, host: &dyn Host) -> Result<Ready, String> {
        let store = host
            .store()
            .ok_or("this Boite keeps no records, so it has no pilot threads")?;
        let runtime = host
            .pilot()
            .ok_or("this Boite has no pilot runtime, so a chat thread cannot be driven here")?;

        // The roots check, on the directory the child would actually run in.
        // A read is checked the same way a write is: a timeline is the
        // conversation of an agent in that checkout.
        let mut spec = None;
        if let Some(thread_id) = self.thread_id() {
            let cwd = thread_cwd(&store, thread_id)?;
            host.roots().ensure_allowed(&cwd.to_string_lossy())?;
            if matches!(self, Pilot::Open { .. }) {
                spec = Some(Box::new(open_spec(&store, thread_id, cwd, host)?));
            }
        }

        tracing::debug!(
            method = self.name(),
            thread = self.thread_id().unwrap_or(""),
            "pilot.call"
        );
        Ok(Ready::Pilot(Box::new(PilotReady {
            call: self,
            store,
            runtime,
            spec,
        })))
    }
}

/// Where a thread's child runs: its own worktree, or the project's folder.
///
/// The same answer the terminal runtime uses, so a thread that reopens as a
/// chat lands in the checkout it was already working in.
fn thread_cwd(store: &Store, thread_id: &str) -> Result<PathBuf, String> {
    let thread = store
        .load_thread(thread_id)?
        .ok_or_else(|| format!("no thread {thread_id}"))?;
    if let Some(worktree) = thread.worktree_path.filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(worktree));
    }
    let projects = store.load_projects()?;
    projects
        .into_iter()
        .find(|project| project.id == thread.project_id)
        .map(|project| PathBuf::from(project.cwd))
        .ok_or_else(|| format!("thread {thread_id} names a project that is gone"))
}

/// Everything the driver needs, read off the thread's own row.
///
/// `resume` comes from `threads.session_id`: set means the conversation already
/// exists, and the claude driver then passes `--resume` instead of
/// `--session-id`, which are exclusive. `bin` is deliberately left empty — the
/// driver resolves its own binary, and naming one here would freeze a path into
/// a row.
fn open_spec(
    store: &Store,
    thread_id: &str,
    cwd: PathBuf,
    host: &dyn Host,
) -> Result<OpenSpec, String> {
    let thread = store
        .load_thread(thread_id)?
        .ok_or_else(|| format!("no thread {thread_id}"))?;
    if thread.runtime != RUNTIME_PILOT {
        return Err(format!(
            "thread {thread_id} is a {} thread; only a chat thread has a pilot session",
            thread.runtime
        ));
    }
    let driver = thread
        .pilot_driver
        .clone()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("thread {thread_id} names no pilot driver"))?;
    let instance: Instance = thread
        .pilot_instance
        .as_deref()
        .filter(|text| !text.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| format!("thread {thread_id} has an unreadable pilot instance: {e}"))?
        .unwrap_or_default();
    let options: Options = thread
        .pilot_options
        .as_deref()
        .filter(|text| !text.is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| format!("thread {thread_id} has unreadable pilot options: {e}"))?
        .unwrap_or_default();
    Ok(OpenSpec {
        thread_id: thread_id.to_string(),
        cwd,
        driver,
        instance,
        model: thread.pilot_model.filter(|model| !model.is_empty()),
        options,
        resume: thread.session_id.filter(|id| !id.is_empty()),
        // boite-mcp first, exactly as a terminal thread gets the sidecar. The
        // host mints the paths and the per-thread environment, because only it
        // knows where its own sidecar and key file are.
        mcp_servers: host.pilot_mcp(thread_id),
        system_prompt_append: None,
        env: Default::default(),
        bin: Vec::new(),
    })
}

/// What the catalog answers with, built where the runtime is.
///
/// Native instances come from the settings blob key `pilotInstances`, shaped
/// `{ "<name>": { "driver": "claude", "configDir": "..." } }`. A driver with no
/// entry gets one default instance with no config directory, so a fresh install
/// has something to open a thread on without a settings write first.
pub fn catalog(
    store: &Store,
    runtime: &boite_pilot::Runtime,
    refresh: bool,
) -> Result<Value, String> {
    let drivers: Vec<Value> = runtime
        .drivers()
        .into_iter()
        .map(|id| {
            let capabilities = runtime.capabilities(&id);
            json!({ "id": id, "capabilities": capabilities })
        })
        .collect();

    let settings = store.load_settings().unwrap_or_else(|_| json!({}));
    let declared = settings.get("pilotInstances").and_then(|v| v.as_object());
    let mut instances: Vec<Value> = Vec::new();
    if let Some(declared) = declared {
        for (name, body) in declared {
            let driver = body
                .get("driver")
                .and_then(|v| v.as_str())
                .unwrap_or("claude");
            let config_dir = body.get("configDir").and_then(|v| v.as_str());
            instances.push(json!({
                "name": name,
                "driver": driver,
                "instance": Instance::Native {
                    config_dir: config_dir.map(PathBuf::from),
                },
            }));
        }
    }
    for id in runtime.drivers() {
        let named = instances
            .iter()
            .any(|entry| entry["driver"].as_str() == Some(id.as_str()));
        if !named {
            instances.push(json!({
                "name": id,
                "driver": id,
                "instance": Instance::Native { config_dir: None },
            }));
        }
    }

    // A fastpick route is virtual and never stored on a row. Absence of
    // fastpick is not a failure: the menu simply offers the native instances.
    let routes = crate::fastpick::list_blocking(None, refresh).ok();
    Ok(json!({
        "drivers": drivers,
        "instances": instances,
        "fastpick": routes,
    }))
}

/// The turn input a `pilot.turn.start` carries.
pub fn turn_input(text: String, model: Option<String>) -> TurnInput {
    TurnInput {
        text,
        selection: model.map(ModelSelection::model),
    }
}

/// One MCP server entry, so a host builds the sidecar the same way on both
/// sides.
pub fn boite_mcp_server(command: String, args: Vec<String>, env: Vec<(String, String)>) -> McpServer {
    McpServer {
        name: "boite".to_string(),
        command,
        args,
        env: env.into_iter().collect(),
    }
}

fn mode_of(raw: Option<&str>) -> Result<ExecMode, String> {
    Ok(match raw.unwrap_or("ask") {
        "ask" => ExecMode::Ask,
        "editAlone" | "edit_alone" => ExecMode::EditAlone,
        "yolo" => ExecMode::Yolo,
        other => return Err(format!("unknown pilot mode: {other}")),
    })
}

fn cursor(params: &Value) -> i64 {
    params
        .get("afterSeq")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .max(0)
}

fn limit(params: &Value) -> usize {
    params
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(READ_LIMIT_DEFAULT)
        .clamp(1, READ_LIMIT_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::Grant;
    use crate::command::{Command, Host};
    use crate::model::{Project, Thread, RUNTIME_TERMINAL};
    use crate::scope::ProjectRoots;
    use boite_pilot::{EventSink, PilotEvent};

    struct Silent;
    impl EventSink for Silent {
        fn emit(&self, _thread_id: &str, _event: PilotEvent) {}
    }

    struct Rows {
        roots: ProjectRoots,
        store: Arc<Store>,
        runtime: Option<Arc<boite_pilot::Runtime>>,
    }

    impl Rows {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("boite-pilot-bus-{}-{name}.db", std::process::id()));
            let _ = std::fs::remove_file(&path);
            let store = Arc::new(Store::open(&path).unwrap());
            let cwd = std::env::temp_dir().to_string_lossy().to_string();
            store
                .save_project(
                    &Project {
                        id: "p1".into(),
                        name: "p".into(),
                        cwd: cwd.clone(),
                        icon: None,
                        archived: false,
                        git_root: None,
                        worktrees: None,
                        mcp_server_ids: None,
                    },
                    0,
                )
                .unwrap();
            let roots = ProjectRoots::default();
            roots.replace(vec![cwd]);
            Rows {
                roots,
                store,
                runtime: Some(Arc::new(boite_pilot::Runtime::new(Arc::new(Silent)))),
            }
        }

        fn thread(&self, id: &str, runtime: &str, driver: Option<&str>) {
            self.store
                .save_thread(&Thread {
                    id: id.into(),
                    project_id: "p1".into(),
                    pty_id: None,
                    label: "chat".into(),
                    title: None,
                    cmd: "claude".into(),
                    args: vec![],
                    icon_key: None,
                    icon_color: None,
                    session_id: None,
                    status: "idle".into(),
                    exit_code: None,
                    created_at: 0,
                    auto_slept: false,
                    keep_awake: false,
                    worktree_path: None,
                    settled_at: None,
                    parent_thread_id: None,
                    delegation_mode: None,
                    delegation_status: None,
                    role: None,
                    orchestrator_scope: None,
                    accept_dispatch: true,
                    runtime: runtime.into(),
                    pilot_driver: driver.map(str::to_string),
                    pilot_instance: None,
                    pilot_model: None,
                    pilot_options: None,
                })
                .unwrap();
        }
    }

    impl Host for Rows {
        fn roots(&self) -> &ProjectRoots {
            &self.roots
        }
        fn store(&self) -> Option<Arc<Store>> {
            Some(self.store.clone())
        }
        fn pilot(&self) -> Option<Arc<boite_pilot::Runtime>> {
            self.runtime.clone()
        }
    }

    fn ready(host: &Rows, method: &str, params: Value) -> Result<Ready, String> {
        Command::decode(method, &params)?.prepare(host, Grant::Local)
    }

    /// Every method decodes into this domain and back out under its own name,
    /// which is what stops one landing in another domain's envelope.
    #[test]
    fn every_method_round_trips_through_its_own_name() {
        let params = json!({ "threadId": "t1", "text": "hi", "requestId": "r1",
                             "option": "allow", "mode": "ask" });
        for method in ALL_METHODS {
            let command = Command::decode(method, &params).expect(method);
            assert_eq!(command.name(), *method);
        }
    }

    /// The reads are reads and the rest spend the machine, which is what the
    /// server's device check reads off this domain.
    #[test]
    fn what_each_method_needs_is_what_the_scope_check_reads() {
        use Capability::*;
        let params = json!({ "threadId": "t1", "text": "hi", "requestId": "r1",
                             "option": "allow" });
        for (method, expected) in [
            ("pilot.catalog", ReadProject),
            ("pilot.items", ReadProject),
            ("pilot.events", ReadProject),
            ("pilot.subscribe", ReadProject),
            ("pilot.unsubscribe", ReadProject),
            ("pilot.thread.open", MutateProject),
            ("pilot.turn.start", MutateProject),
            ("pilot.turn.interrupt", MutateProject),
            ("pilot.request.respond", MutateProject),
            ("pilot.model.set", MutateProject),
            ("pilot.mode.set", MutateProject),
            ("pilot.session.stop", MutateProject),
        ] {
            let command = Command::decode(method, &params).expect(method);
            assert_eq!(command.capability(), expected, "{method}");
        }
    }

    /// A host with no runtime says so, rather than answering as if the thread
    /// simply had no session.
    #[test]
    fn a_host_with_no_runtime_refuses_by_name() {
        let mut host = Rows::new("noruntime");
        host.thread("t1", RUNTIME_PILOT, Some("claude"));
        host.runtime = None;
        let refusal = ready(&host, "pilot.thread.open", json!({ "threadId": "t1" }))
            .expect_err("a host with no pilot cannot open one");
        assert!(refusal.contains("no pilot runtime"), "{refusal}");
    }

    #[test]
    fn opening_a_terminal_thread_is_refused() {
        let host = Rows::new("terminalrow");
        host.thread("t1", RUNTIME_TERMINAL, None);
        let refusal = ready(&host, "pilot.thread.open", json!({ "threadId": "t1" }))
            .expect_err("a terminal row has no pilot session");
        assert!(refusal.contains("terminal"), "{refusal}");
    }

    /// The spec is built from the row, not from what the caller sent: the cwd,
    /// the driver and the resume all come off the thread.
    #[test]
    fn the_open_spec_is_read_off_the_row() {
        let host = Rows::new("spec");
        host.thread("t1", RUNTIME_PILOT, Some("claude"));
        host.store
            .update_thread_field(
                "t1",
                crate::store::ThreadCol::SessionId,
                crate::store::ColVal::Text("native-7".into()),
            )
            .unwrap();
        let Ready::Pilot(ready) = ready(&host, "pilot.thread.open", json!({ "threadId": "t1" }))
            .expect("prepared")
        else {
            panic!("not a pilot ready");
        };
        let spec = ready.spec.expect("a spec");
        assert_eq!(spec.thread_id, "t1");
        assert_eq!(spec.driver, "claude");
        assert_eq!(spec.resume.as_deref(), Some("native-7"));
        assert!(spec.bin.is_empty(), "the driver resolves its own binary");
        assert_eq!(spec.cwd, std::env::temp_dir());
    }

    /// A thread outside the registered roots is refused before anything is
    /// spawned in it, the same way every path-taking command is.
    #[test]
    fn a_thread_outside_the_roots_is_refused() {
        let host = Rows::new("roots");
        host.thread("t1", RUNTIME_PILOT, Some("claude"));
        host.roots.replace(vec!["/nowhere/at/all".to_string()]);
        let refusal = ready(&host, "pilot.items", json!({ "threadId": "t1" }))
            .expect_err("outside the roots");
        assert!(!refusal.is_empty());
    }

    /// A cursor read is clamped rather than refused: a client asking for a
    /// hundred thousand items is asking for the host's memory.
    #[test]
    fn a_read_limit_is_clamped() {
        let command = Command::decode(
            "pilot.items",
            &json!({ "threadId": "t1", "limit": 1_000_000 }),
        )
        .unwrap();
        let Command::Pilot(Pilot::Items { limit, .. }) = command else {
            panic!("not an items read");
        };
        assert_eq!(limit, READ_LIMIT_MAX);
    }
}
