//! One named surface for what a client may ask Boite to do.
//!
//! Boite has two front doors: Tauri commands on the desktop and a WebSocket RPC
//! on the server. Until this module existed, each one carried its own copy of
//! every capability — the same scope check, the same call into the domain, the
//! same refusal worded twice — and nothing checked that the two copies agreed.
//! Every divergence the audit found was a capability that existed on one side
//! only, or a boundary applied on one side only.
//!
//! So a capability is a value here, and the two front doors are codecs over it:
//!
//! ```text
//!   Tauri command  ─┐                                     ┌─ grant   who is asking
//!                   ├─ Command ── Ready ── run() ── Value ┼─ host    what it may reach
//!   WebSocket RPC  ─┘                                     └─ run()   the work
//! ```
//!
//! [`Command::prepare`] is the only thing that touches the [`Host`] or the
//! caller's [`Grant`], and [`Ready`] is the only thing that can be run. That is
//! not decoration: it makes "was this checked" a question with exactly one
//! answer per command, instead of a line a new command can forget to copy. The
//! test at the bottom of `command/git.rs` walks every command in the surface and
//! asserts that none of them prepares outside the registered roots; the one at
//! the bottom of this file asserts that every one of them declares what it
//! needs.
//!
//! `Ready` is deliberately free of the host and of any lifetime, so a transport
//! can hand it to its own blocking pool. `boite-core` takes no async runtime and
//! this module does not change that: `run` blocks, and each transport wraps it
//! in whatever it already uses.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

use crate::capability::{Capability, Grant};
use crate::scope::ProjectRoots;
use crate::store::Store;
use crate::telemetry::TelemetryRuntime;

pub mod checkpoint;
pub mod conduct;
pub mod files;
pub mod git;
pub mod logs;
pub mod pilot;
pub mod records;
pub mod sessions;
pub mod sync;
pub mod telemetry;

pub use checkpoint::Checkpoints;
pub use conduct::Conduct;
pub use files::Files;
pub use git::Git;
pub use logs::Logs;
pub use pilot::{Pilot, PilotReady};
pub use records::{Records, ThreadPatch};
pub use sessions::Sessions;
pub use sync::Sync;
pub use telemetry::Telemetry;

/// What a command wants to do with a path the caller handed it.
///
/// The two boundaries are not the same check: a write target may not exist yet,
/// so its parent is what has to be inside the roots, and a symlink sitting in an
/// allowed directory can point anywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Access {
    Read,
    Write,
}

impl Access {
    pub(crate) fn ensure(self, host: &dyn Host, path: &str) -> Result<(), String> {
        match self {
            Access::Read => host.roots().ensure_allowed(path),
            Access::Write => host.roots().ensure_allowed_for_write(path),
        }
    }
}

/// What a command is allowed to reach.
///
/// Small on purpose. It grows a method when a command genuinely needs something
/// only its host can answer, which so far is the filesystem trust boundary and
/// one legacy directory. A method here is a thing the two front doors must both
/// be able to answer, so adding one is a decision, not a convenience.
pub trait Host {
    /// The filesystem trust boundary. Every path-taking command goes through it.
    fn roots(&self) -> &ProjectRoots;

    /// Where an earlier layout put thread worktrees, when this host had one.
    ///
    /// `None` means there is nothing left behind to migrate out of, which is
    /// what a fresh install and a test both look like.
    fn legacy_worktree_base(&self) -> Option<PathBuf> {
        None
    }

    /// Whether a path that is not a project yet may be looked at, or made.
    ///
    /// A different boundary from [`Host::roots`]: that one is "inside a project
    /// the user has", this one is "may become one". A desktop has no outer
    /// boundary to apply — inspecting a folder is what produces the name a
    /// project is created with, and the user's own folder dialog is the gate —
    /// so its answer is yes. A server bound to a workspace directory has one.
    ///
    /// Note what this does *not* do: require the path to exist. The folder a
    /// project is about to go in does not, and asking about it is the whole
    /// point of `project.folderState`.
    fn ensure_new_project_path(&self, _path: &str) -> Result<(), String> {
        Ok(())
    }

    /// Which process a PTY is running right now, when the caller named one.
    ///
    /// A pid the caller sends could name anything on the machine; this is the
    /// host's own registry answering for an id it minted itself. The default is
    /// `None`, which is honest for a host with no process registry — a test, or
    /// a transport that never spawns anything — and costs the one command that
    /// asks a tie-break rather than an answer.
    fn child_pid(&self, _pty_id: &str) -> Option<u32> {
        None
    }

    /// Where this host keeps what its terminals printed.
    ///
    /// `None` means it keeps none, which is honest for a host with no PTYs of
    /// its own and for one whose directory could not be made. The one command
    /// that asks says so rather than answering with nothing, because "there is
    /// no transcript" and "this Boite does not keep transcripts" send whoever
    /// is reading to two different places.
    fn transcripts_dir(&self) -> Option<PathBuf> {
        None
    }

    /// Places a new project may go beyond the parents of the registered roots.
    ///
    /// The user's home on both sides; a server bound to a workspace directory
    /// adds that too.
    fn extra_project_parents(&self) -> Vec<String> {
        dirs::home_dir()
            .map(|home| vec![home.to_string_lossy().to_string()])
            .unwrap_or_default()
    }

    /// The live pulse waits of this process, when it keeps any.
    ///
    /// `None` is honest for a test and for a host that never long-polls: a
    /// `conduct.pulse` there answers immediately with `timedOut: true` rather
    /// than parking a thread nothing will ever wake.
    fn pulse_waiters(&self) -> Option<Arc<crate::pulse::Waiters>> {
        None
    }

    /// The rows this host keeps: projects, threads, todos, settings.
    ///
    /// `None` means it keeps none, and the record commands say so rather than
    /// answering an empty list — "there are no projects" and "this Boite keeps
    /// no rows" send whoever is reading to two different places.
    ///
    /// An `Arc` rather than a borrow because [`Ready`] outlives the host on
    /// purpose: a transport hands it to its own blocking pool, and a `&Store`
    /// would tie the whole bus to the lifetime of the call that built it.
    fn store(&self) -> Option<Arc<Store>> {
        None
    }

    /// The pilot runtime this host owns, when it owns one.
    ///
    /// Same shape as [`Host::pulse_waiters`] and [`Host::child_pid`]: the bus
    /// validates a `pilot.*` call and the host is what actually holds the child
    /// processes. `None` is honest for a test, for a headless CLI and for a
    /// build without the experiment, and every method in that domain refuses by
    /// name rather than pretending a thread has no session.
    fn pilot(&self) -> Option<Arc<boite_pilot::Runtime>> {
        None
    }

    /// The MCP servers a pilot thread is launched with, boite-mcp first.
    ///
    /// A host method rather than something the bus builds: the sidecar path and
    /// the per-thread environment (`BOITE_MCP_URL`, `BOITE_KEY_FILE`,
    /// `BOITE_THREAD_ID`) are what that host stamps into a terminal thread at
    /// spawn, and only it knows where its own files are. An empty list is a
    /// thread with no boite tools, which is what a host that mints none has.
    fn pilot_mcp(&self, _thread_id: &str) -> Vec<boite_pilot::McpServer> {
        Vec::new()
    }

    /// The process-wide telemetry runtime, when this host has one.
    ///
    /// `None` is honest for a test and for a host that never queued an event.
    /// The queue cannot be derived from the other answers, which is why this
    /// is its own method rather than something `prepare` rebuilds.
    fn telemetry(&self) -> Option<Arc<TelemetryRuntime>> {
        None
    }
}

/// Every method the bus serves, across every domain.
///
/// What a transport asks before handing a method over, so a front door that
/// still serves something itself cannot accidentally shadow a command — or be
/// shadowed by one. The lists are per domain and this is the only place they are
/// read together.
pub fn methods() -> impl Iterator<Item = &'static str> {
    git::ALL_METHODS
        .iter()
        .chain(files::ALL_METHODS)
        .chain(sessions::ALL_METHODS)
        .chain(records::ALL_METHODS)
        .chain(checkpoint::ALL_METHODS)
        .chain(conduct::ALL_METHODS)
        .chain(sync::ALL_METHODS)
        .chain(telemetry::ALL_METHODS)
        .chain(logs::ALL_METHODS)
        .chain(pilot::ALL_METHODS)
        .copied()
}

/// Whether the bus answers for this method.
pub fn handles(method: &str) -> bool {
    methods().any(|m| m == method)
}

/// What each method needs, by name, without decoding a real call.
///
/// A caller that has to answer "may this device ask for `git.commit`" before it
/// has parameters in hand — a scope check on a front door — cannot build a
/// [`Command`] to ask. Rather than a second hand-kept table, which is the exact
/// failure this module exists to end, the map is built once by decoding every
/// method in [`methods`] against parameters that satisfy all of them and reading
/// [`Command::capability`] off the result. It is therefore the same table the
/// pinning test asserts, and a new command joins it the moment its name is in
/// its domain's `ALL_METHODS`.
///
/// A method that will not decode maps to [`Capability::MutateAcross`], the
/// narrowest grant, so the failure direction is a call refused rather than a
/// call waved through. `every_method_declares_what_it_needs` asserts none does.
pub fn capabilities() -> &'static std::collections::BTreeMap<&'static str, Capability> {
    use std::sync::OnceLock;
    static MAP: OnceLock<std::collections::BTreeMap<&'static str, Capability>> = OnceLock::new();
    MAP.get_or_init(|| {
        let params = probe_params();
        methods()
            .map(|method| {
                let capability = Command::decode(method, &params)
                    .map(|c| c.capability())
                    .unwrap_or(Capability::MutateAcross);
                (method, capability)
            })
            .collect()
    })
}

/// What each method needs, or `None` for a method the bus does not serve.
pub fn capability_of(method: &str) -> Option<Capability> {
    capabilities().get(method).copied()
}

/// Parameters every method decodes from, used only to read a command's shape.
///
/// Nothing here is run: `decode` builds the value, and the capability is a
/// property of the variant rather than of what it was handed.
fn probe_params() -> Value {
    serde_json::json!({
        "path": ".", "repo": ".", "from": ".", "cwd": ".", "cwds": ["."],
        "threadId": "t", "name": "b", "sha": "0", "branch": "b", "message": "m",
        "file": "a", "files": [], "untracked": [], "query": "q",
        "content": "", "kind": "claude", "sessionId": "s", "cmd": "git",
        "fromCwd": ".", "toCwd": ".", "queries": [], "limit": 1, "skip": 0, "days": 1,
        "bytes": 16,
        "project": { "id": "p", "name": "n", "cwd": ".", "icon": null },
        "thread": { "id": "t", "projectId": "p", "label": "l", "cmd": "c" },
        "todo": { "id": "d", "projectId": "p", "title": "t", "state": "open",
                  "createdAt": 0, "updatedAt": 0 },
        "id": "p", "todoId": "d", "settings": {}, "q": "q",
        "edge": "start", "to": "0",
        "status": "idle", "ids": [], "settled": true,
        "text": "t",
        "toThreadId": "t", "dispatchId": "d", "state": "delivered",
        "audio": "", "actionId": "a",
        "remoteUrl": "https://example.invalid/x.git",
        "provider": "claude", "email": "you@example.com",
        "enabled": true, "modeA": true, "modeB": false, "stage": "available",
        "targetVersion": "1.0.0", "errorCode": "io", "paneKind": "editor",
        "requestId": "r", "option": "allow", "mode": "ask", "afterSeq": 0,
        "uiLanguage": "en", "theme": "dark", "threadWorktrees": true,
        "animations": "system", "mcpYolo": false, "idleAutoclose": true,
        "orchestrator": false, "voice": false,
    })
}

/// A capability, named and carrying its arguments.
///
/// One variant per method the front doors accept. Domains are separate enums so
/// this one stays a table of contents.
#[derive(Debug, Clone)]
pub enum Command {
    Checkpoints(Checkpoints),
    Conduct(Conduct),
    Files(Files),
    Git(Git),
    Logs(Logs),
    Pilot(Pilot),
    Records(Records),
    Sessions(Sessions),
    Sync(Sync),
    Telemetry(Telemetry),
}

impl From<Conduct> for Command {
    fn from(conduct: Conduct) -> Self {
        Command::Conduct(conduct)
    }
}

impl From<Checkpoints> for Command {
    fn from(checkpoints: Checkpoints) -> Self {
        Command::Checkpoints(checkpoints)
    }
}

impl From<Git> for Command {
    fn from(git: Git) -> Self {
        Command::Git(git)
    }
}

impl From<Records> for Command {
    fn from(records: Records) -> Self {
        Command::Records(records)
    }
}

impl From<Files> for Command {
    fn from(files: Files) -> Self {
        Command::Files(files)
    }
}

impl From<Sync> for Command {
    fn from(value: Sync) -> Self {
        Command::Sync(value)
    }
}

impl From<Sessions> for Command {
    fn from(sessions: Sessions) -> Self {
        Command::Sessions(sessions)
    }
}

impl From<Logs> for Command {
    fn from(logs: Logs) -> Self {
        Command::Logs(logs)
    }
}

impl From<Pilot> for Command {
    fn from(pilot: Pilot) -> Self {
        Command::Pilot(pilot)
    }
}

impl From<Telemetry> for Command {
    fn from(telemetry: Telemetry) -> Self {
        Command::Telemetry(telemetry)
    }
}

impl Command {
    /// Reads a wire method name and its parameters into a command.
    ///
    /// The failure is the same sentence the WebSocket dispatcher used to
    /// produce, because it is the one the frontend already reads.
    /// Reads a wire method name and its parameters into a command.
    ///
    /// Routed on each domain's own `ALL_METHODS` rather than on the prefix. The
    /// prefix stopped being enough the moment `project.` meant two things:
    /// `project.inspect` asks about a folder that is not a project yet and
    /// belongs to files, `project.list` reads rows. A prefix table would have
    /// had to name the exception, and the exception is what drifts.
    pub fn decode(method: &str, params: &Value) -> Result<Self, String> {
        if git::ALL_METHODS.contains(&method) {
            return Git::decode(method, params).map(Command::Git);
        }
        if files::ALL_METHODS.contains(&method) {
            return Files::decode(method, params).map(Command::Files);
        }
        if sessions::ALL_METHODS.contains(&method) {
            return Sessions::decode(method, params).map(Command::Sessions);
        }
        if records::ALL_METHODS.contains(&method) {
            return Records::decode(method, params).map(Command::Records);
        }
        if checkpoint::ALL_METHODS.contains(&method) {
            return Checkpoints::decode(method, params).map(Command::Checkpoints);
        }
        if conduct::ALL_METHODS.contains(&method) {
            return Conduct::decode(method, params).map(Command::Conduct);
        }
        if sync::ALL_METHODS.contains(&method) {
            return Sync::decode(method, params).map(Command::Sync);
        }
        if logs::ALL_METHODS.contains(&method) {
            return Logs::decode(method, params).map(Command::Logs);
        }
        if pilot::ALL_METHODS.contains(&method) {
            return Pilot::decode(method, params).map(Command::Pilot);
        }
        if telemetry::ALL_METHODS.contains(&method) {
            return Telemetry::decode(method, params).map(Command::Telemetry);
        }
        Err(format!("unknown method: {method}"))
    }

    /// The wire name this command answers to. Round-trips with [`Command::decode`].
    pub fn name(&self) -> &'static str {
        match self {
            Command::Checkpoints(c) => c.name(),
            Command::Conduct(c) => c.name(),
            Command::Files(f) => f.name(),
            Command::Git(g) => g.name(),
            Command::Logs(l) => l.name(),
            Command::Pilot(p) => p.name(),
            Command::Records(r) => r.name(),
            Command::Sessions(s) => s.name(),
            Command::Sync(s) => s.name(),
            Command::Telemetry(t) => t.name(),
        }
    }

    /// How the WebSocket protocol wraps this command's answer. See [`Wire`].
    pub fn wire(&self) -> Wire {
        match self {
            Command::Checkpoints(c) => c.wire(),
            Command::Conduct(c) => c.wire(),
            Command::Files(f) => f.wire(),
            Command::Git(g) => g.wire(),
            Command::Logs(l) => l.wire(),
            Command::Pilot(p) => p.wire(),
            Command::Records(r) => r.wire(),
            Command::Sessions(s) => s.wire(),
            Command::Sync(s) => s.wire(),
            Command::Telemetry(t) => t.wire(),
        }
    }

    /// What a caller has to hold to be allowed to ask for this.
    ///
    /// One table for the whole surface, and it is read in exactly one place:
    /// [`Command::prepare`]. A transport cannot check it early, cannot check it
    /// twice and cannot forget to check it, because there is no way to reach
    /// [`Ready`] without going through the check.
    pub fn capability(&self) -> Capability {
        match self {
            Command::Checkpoints(c) => c.capability(),
            Command::Conduct(c) => c.capability(),
            Command::Files(f) => f.capability(),
            Command::Git(g) => g.capability(),
            Command::Logs(l) => l.capability(),
            Command::Pilot(p) => p.capability(),
            Command::Records(r) => r.capability(),
            Command::Sessions(s) => s.capability(),
            Command::Sync(s) => s.capability(),
            Command::Telemetry(t) => t.capability(),
        }
    }

    /// Checks the command against the caller and the host, and hands back
    /// something runnable.
    ///
    /// Two boundaries, in the order they can be answered: what this caller is
    /// allowed to ask for at all, then whether the paths it named are inside the
    /// registered roots. Both are here rather than at the transports, which is
    /// the whole reason [`Ready`] cannot be built any other way.
    ///
    /// A command that turns out to have nothing to do comes back
    /// [`Ready::Settled`] with the answer already in it.
    pub fn prepare(self, host: &dyn Host, grant: Grant) -> Result<Ready, String> {
        grant.ensure(self.capability())?;
        match self {
            Command::Checkpoints(c) => c.prepare(host),
            Command::Conduct(c) => c.prepare(host, grant),
            Command::Files(f) => f.prepare(host),
            Command::Git(g) => g.prepare(host),
            Command::Logs(l) => l.prepare(host),
            Command::Pilot(p) => p.prepare(host),
            Command::Records(r) => r.prepare(host),
            Command::Sessions(s) => s.prepare(host),
            Command::Sync(s) => s.prepare(host),
            Command::Telemetry(t) => t.prepare(host, grant),
        }
    }
}

/// A command that has been through its host and has nothing left to check.
///
/// Constructible only by [`Command::prepare`], which is the point: a transport
/// cannot run work it did not first put through the boundary.
#[derive(Debug)]
pub enum Ready {
    /// `prepare` already knows the answer. Nothing to run.
    Settled(Value),
    /// Work to do, off whatever runtime the transport is on.
    Work(Command),
    /// A record command, and the store `prepare` resolved for it.
    ///
    /// The one domain whose work needs something only the host can hand over.
    /// `Ready` is deliberately free of the host, so the store is resolved during
    /// `prepare` and travels here rather than being fetched later — which keeps
    /// "a host that keeps no records" a refusal at the boundary instead of an
    /// error thrown from inside the work.
    Records(Records, Arc<Store>, Option<Arc<TelemetryRuntime>>),
    /// An orchestration command, with the store and the live-wait registry the
    /// host resolved for it. Same reasoning as [`Ready::Records`]; the registry
    /// is optional because a host with no long-poll answers honestly without.
    Conduct(Conduct, Arc<Store>, Option<Arc<crate::pulse::Waiters>>),
    /// A telemetry command, with the runtime `prepare` resolved for it.
    Telemetry(Telemetry, Arc<TelemetryRuntime>),
    /// A pilot command, with the store and the pilot runtime resolved for it.
    ///
    /// The one arm `run` cannot answer: the work is async, and `boite-core`
    /// owns no executor. The host awaits it through
    /// [`crate::pilot_host::execute`] on the runtime it already has.
    Pilot(Box<PilotReady>),
}

impl Ready {
    /// Does the work. Blocks: callers hand this to their own blocking pool.
    pub fn run(self) -> Result<Value, String> {
        match self {
            Ready::Settled(value) => Ok(value),
            Ready::Work(Command::Checkpoints(c)) => c.run(),
            Ready::Work(Command::Files(f)) => f.run(),
            Ready::Work(Command::Git(g)) => g.run(),
            Ready::Work(Command::Logs(l)) => l.run(),
            Ready::Work(Command::Sessions(s)) => s.run(),
            Ready::Work(Command::Sync(s)) => s.run(),
            // `prepare` turns every record command into the arm below, so this
            // is unreachable rather than a case with an answer.
            Ready::Work(Command::Records(r)) => {
                Err(format!("{} was not prepared with a store", r.name()))
            }
            Ready::Work(Command::Conduct(c)) => {
                Err(format!("{} was not prepared with a store", c.name()))
            }
            Ready::Work(Command::Telemetry(t)) => {
                Err(format!("{} was not prepared with a telemetry runtime", t.name()))
            }
            Ready::Work(Command::Pilot(p)) => {
                Err(format!("{} was not prepared with a pilot runtime", p.name()))
            }
            // Deliberately not answered here. A pilot call awaits a child
            // process, and this function blocks a thread of whatever pool the
            // transport handed it to; the host runs it on its own executor.
            Ready::Pilot(ready) => Err(format!(
                "{} runs on the host's runtime, through boite_core::pilot_host::execute",
                ready.call.name()
            )),
            Ready::Records(r, store, telemetry) => r.run(&store, telemetry.as_deref()),
            Ready::Conduct(c, store, waiters) => c.run(&store, waiters),
            Ready::Telemetry(t, runtime) => t.run(&runtime),
        }
    }
}

/// How the WebSocket protocol dresses an answer.
///
/// A wire detail rather than a domain fact, but it belongs beside the command
/// it describes: a remote client reads `{"branches": [...]}` where the desktop
/// reads the array itself, and that difference is part of what a command
/// promises. Kept in one table so the two front doors cannot drift into
/// answering the same question in two shapes by accident.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    /// The value as the domain produced it.
    Bare,
    /// Wrapped under one key.
    Key(&'static str),
    /// The command answers nothing; the protocol says so with `{"ok": true}`.
    Ok,
}

impl Wire {
    pub fn wrap(self, value: Value) -> Value {
        match self {
            Wire::Bare => value,
            Wire::Key(key) => {
                let mut object = serde_json::Map::new();
                object.insert(key.to_string(), value);
                Value::Object(object)
            }
            Wire::Ok => serde_json::json!({ "ok": true }),
        }
    }
}

/// Serialises a domain answer.
///
/// The domain types are plain structs of strings, numbers and vectors, so this
/// cannot fail for any of them; a panic here would mean a type grew a map with
/// non-string keys, which is a bug to fix rather than an error to report.
pub(crate) fn value_of<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).expect("a domain answer is always representable as JSON")
}

pub(crate) fn str_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing param: {key}"))
}

pub(crate) fn opt_str_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub(crate) fn bool_param(params: &Value, key: &str, fallback: bool) -> bool {
    params
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or(fallback)
}

pub(crate) fn u32_param(params: &Value, key: &str, fallback: u32) -> u32 {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .unwrap_or(fallback)
}

pub(crate) fn str_list(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// A host with a boundary and nothing else behind it.
///
/// What a transport builds per call when it has no legacy directory to declare.
pub struct Scoped<'a> {
    pub roots: &'a ProjectRoots,
    pub legacy_worktree_base: Option<PathBuf>,
    /// `None` keeps the trait's answer, which is the user's home.
    pub extra_project_parents: Option<Vec<String>>,
}

impl<'a> Scoped<'a> {
    pub fn new(roots: &'a ProjectRoots) -> Self {
        Self {
            roots,
            legacy_worktree_base: None,
            extra_project_parents: None,
        }
    }

    /// Declares where this host's earlier layout left worktrees behind.
    pub fn with_legacy_worktree_base(mut self, base: Option<PathBuf>) -> Self {
        self.legacy_worktree_base = base;
        self
    }

    /// Replaces the places a new project may go beyond the registered roots.
    ///
    /// A server bound to a workspace directory adds it here. A test passes an
    /// empty list, which is the only way to have a scratch folder under the
    /// user's home not count as a place a project may go.
    pub fn with_extra_project_parents(mut self, parents: Vec<String>) -> Self {
        self.extra_project_parents = Some(parents);
        self
    }
}

impl Host for Scoped<'_> {
    fn roots(&self) -> &ProjectRoots {
        self.roots
    }

    fn legacy_worktree_base(&self) -> Option<PathBuf> {
        self.legacy_worktree_base.clone()
    }

    fn extra_project_parents(&self) -> Vec<String> {
        match &self.extra_project_parents {
            Some(parents) => parents.clone(),
            None => dirs::home_dir()
                .map(|home| vec![home.to_string_lossy().to_string()])
                .unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two places a new project may go, as `files::CreateFolder` reads
    /// them: beside a project the user already has, and under their home. The
    /// first half comes from the roots and is tested in `command/files.rs`; this
    /// is the second, which every host gets unless it says otherwise.
    #[test]
    fn a_host_that_says_nothing_allows_a_project_under_the_home_folder() {
        let roots = ProjectRoots::default();
        let default = Scoped::new(&roots).extra_project_parents();
        assert_eq!(
            default,
            dirs::home_dir()
                .map(|home| vec![home.to_string_lossy().to_string()])
                .unwrap_or_default()
        );
        // And a host with nowhere else to offer says so, rather than falling
        // back to a home directory that would quietly widen it.
        assert!(Scoped::new(&roots)
            .with_extra_project_parents(Vec::new())
            .extra_project_parents()
            .is_empty());
    }

    /// What each method needs, pinned.
    ///
    /// A table rather than a rule read off the method names, because the names
    /// do not carry it: `git.commitState` asks what the repository says about a
    /// commit somebody else made, and any heuristic that reads `commit` as a
    /// write calls it one. Pinned for the same reason the wire envelopes are: a
    /// capability that quietly widens is a check that quietly passes, and this
    /// is where that shows up as a diff somebody has to agree with.
    #[test]
    fn what_each_method_needs_is_what_was_decided() {
        use Capability::*;
        const EXPECTED: &[(&str, Capability)] = &[
            ("git.repoInfo", ReadProject),
            ("git.findRepos", ReadProject),
            ("git.branches", ReadProject),
            ("git.switchBranch", MutateProject),
            ("git.status", ReadProject),
            ("git.changedPaths", ReadProject),
            ("git.log", ReadProject),
            ("git.commitState", ReadProject),
            ("git.pullRequest", ReadProject),
            ("git.stage", MutateProject),
            ("git.unstage", MutateProject),
            ("git.discard", MutateProject),
            ("git.commit", MutateProject),
            ("git.fetch", MutateProject),
            ("git.push", MutateProject),
            ("git.pull", MutateProject),
            ("git.init", MutateProject),
            ("git.fileVersions", ReadProject),
            ("worktree.open", MutateProject),
            ("worktree.warm", MutateProject),
            ("worktree.migrate", MutateProject),
            ("worktree.adopt", MutateProject),
            ("worktree.recognize", MutateProject),
            ("worktree.list", ReadProject),
            ("worktree.claim", MutateProject),
            ("worktree.reserve", MutateProject),
            ("worktree.hold", ReadProject),
            ("worktree.remove", MutateProject),
            ("worktree.sizes", ReadProject),
            ("fs.readDir", ReadProject),
            ("fs.search", ReadProject),
            ("file.read", ReadProject),
            ("file.write", MutateProject),
            ("file.readBase64", ReadProject),
            ("project.inspect", ReadProject),
            ("project.folderState", ReadProject),
            ("project.createFolder", MutateProject),
            ("session.find", ReadProject),
            ("session.liveClaude", ReadProject),
            ("session.agentTurns", ReadProject),
            ("session.usage", ReadProject),
            ("session.stopClaude", MutateProject),
            ("session.copilotResumable", ReadProject),
            ("session.migrate", MutateProject),
            ("shell.default", ReadProject),
            ("shell.available", ReadProject),
            ("shell.commandExists", ReadProject),
            ("fastpick.list", ReadProject),
            ("fastpick.version", ReadProject),
            ("codexSwitcher.list", ReadProject),
            ("codexSwitcher.save", MutateProject),
            ("codexSwitcher.activate", MutateProject),
            ("codexSwitcher.version", ReadProject),
            ("fastMcpSsh.version", ReadProject),
            ("kebaccSwitcher.list", ReadProject),
            ("kebaccSwitcher.add", MutateProject),
            ("kebaccSwitcher.switch", MutateProject),
            ("kebaccSwitcher.version", ReadProject),
            ("session.transcript", ReadProject),
            ("cli.catalog", ReadProject),
            ("cli.latest", ReadProject),
            ("cli.jobs", ReadProject),
            ("cli.dataPaths", ReadProject),
            ("cli.install", MutateAcross),
            ("cli.uninstall", MutateAcross),
            ("cli.cancel", MutateProject),
            ("cli.dismiss", MutateProject),
            ("mcp.catalog", ReadProject),
            ("project.list", ReadProject),
            ("project.create", MutateAcross),
            ("project.archive", MutateProject),
            ("project.delete", MutateAcross),
            ("thread.list", ReadProject),
            ("thread.create", MutateProject),
            ("thread.update", MutateProject),
            ("thread.started", MutateProject),
            ("thread.settle", MutateProject),
            ("thread.delete", MutateAcross),
            ("todo.list", ReadProject),
            ("todo.save", MutateProject),
            ("todo.delete", MutateProject),
            ("settings.get", ReadProject),
            ("settings.set", MutateProject),
            ("workspace.info", ReadProject),
            ("workspace.setInfo", MutateProject),
            ("search.query", ReadProject),
            ("checkpoint.capture", MutateProject),
            ("checkpoint.list", ReadProject),
            ("checkpoint.diff", ReadProject),
            ("checkpoint.fileVersions", ReadProject),
            ("checkpoint.restore", MutateProject),
            ("checkpoint.forget", MutateProject),
            ("conduct.pulse", ReadProject),
            ("conduct.record", MutateProject),
            ("orchestrator.post", MutateProject),
            ("orchestrator.say", MutateProject),
            ("orchestrator.messages", ReadProject),
            ("orchestrator.start", MutateProject),
            ("orchestrator.status", ReadProject),
            ("orchestrator.actions", ReadProject),
            ("orchestrator.undo", MutateProject),
            ("thread.dispatch", MutateProject),
            ("thread.acceptDispatch", MutateProject),
            ("dispatch.drain", MutateProject),
            ("dispatch.settle", MutateProject),
            ("voice.transcribe", ReadProject),
            ("sync.sources", ReadProject),
            ("sync.status", ReadProject),
            ("sync.probe", ReadProject),
            ("sync.pull", MutateAcross),
            ("sync.conflicts", ReadProject),
            ("sync.resolve", MutateAcross),
            ("sync.skip", MutateProject),
            ("sync.push", MutateAcross),
            ("sync.cancel", MutateProject),
            ("sync.dismiss", MutateProject),
            ("sync.repair", MutateAcross),
            ("telemetry.state", ReadProject),
            ("telemetry.setModeA", MutateProject),
            ("telemetry.setModeB", MutateProject),
            ("telemetry.completeOnboarding", MutateProject),
            ("telemetry.export", ReadProject),
            ("telemetry.retryForget", MutateProject),
            ("telemetry.trackUpdate", MutateProject),
            ("telemetry.trackPane", MutateProject),
            ("telemetry.trackSettingsSnapshot", MutateProject),
            ("logs.tail", ReadProject),
            ("logs.query", ReadProject),
            ("logs.level", MutateProject),
            ("logs.write", MutateProject),
            ("logs.subscribe", ReadProject),
            ("pilot.catalog", ReadProject),
            ("pilot.thread.open", MutateProject),
            ("pilot.turn.start", MutateProject),
            ("pilot.turn.interrupt", MutateProject),
            ("pilot.request.respond", MutateProject),
            ("pilot.model.set", MutateProject),
            ("pilot.mode.set", MutateProject),
            ("pilot.session.stop", MutateProject),
            ("pilot.items", ReadProject),
            ("pilot.events", ReadProject),
            ("pilot.subscribe", ReadProject),
            ("pilot.unsubscribe", ReadProject),
        ];
        let actual: Vec<(&str, Capability)> = every_command()
            .iter()
            .map(|c| (c.name(), c.capability()))
            .collect();
        assert_eq!(actual, EXPECTED, "a method changed what it needs, or a new one arrived");
    }

    /// A read that spawns `git fetch` is still a write to somebody's disk.
    ///
    /// The one rule the table above cannot state about itself: nothing that
    /// reaches the network or rewrites the index may be a read. Stated
    /// separately so the table stays a list of decisions rather than a list of
    /// decisions with an argument in it.
    #[test]
    fn nothing_that_changes_the_repository_is_labelled_a_read() {
        for method in [
            "git.switchBranch", "git.stage", "git.unstage", "git.discard", "git.commit",
            "git.fetch", "git.push", "git.pull", "git.init", "file.write",
            "project.createFolder", "session.stopClaude", "session.migrate",
            "project.create", "project.archive", "project.delete",
            "thread.create", "thread.update", "thread.started", "thread.settle",
            "thread.delete",
            "todo.save", "todo.delete", "settings.set", "workspace.setInfo",
            "checkpoint.capture", "checkpoint.restore", "checkpoint.forget",
            "sync.pull", "sync.push", "sync.resolve", "sync.repair",
            "sync.skip", "sync.cancel", "sync.dismiss",
        ] {
            let command = every_command()
                .into_iter()
                .find(|c| c.name() == method)
                .unwrap();
            assert_ne!(command.capability(), Capability::ReadProject, "{method}");
        }
    }

    /// The calls that reach past the project they were called in, written out so
    /// that an arrival is a diff somebody has to agree with rather than a
    /// silently widened grant.
    ///
    /// This test used to assert the number was zero, with a note saying that it
    /// failing would be the notice that the endpoint's own check is no longer
    /// the only one. That is what happened twice. First the record domain
    /// brought creating a project, deleting one and deleting a thread. Then sync
    /// brought four more, and they are the sharpest of the lot: they write into
    /// `~/.claude` and `~/.agents`, which is every agent's own configuration and
    /// the instructions every agent reads. Then the CLI manager brought two more,
    /// which do not reach past a project so much as past every project:
    /// installing a binary onto the machine, and deleting an agent's own data
    /// directory. A grant scoped to one project — the credentials file the todo
    /// panel hands to agents — must not reach them, and `Grant::Project.allows`
    /// refusing each one is asserted below.
    ///
    /// The capability check is not the whole guard for sync, and is not meant to
    /// be: `Grant::Owner` allows everything. What keeps an agent away from these
    /// is that `boite-mcp` does not offer them, which its own test asserts.
    #[test]
    fn only_the_calls_that_change_the_machine_reach_across() {
        const ACROSS: &[&str] = &[
            "project.create",
            "project.delete",
            "thread.delete",
            "sync.pull",
            "sync.push",
            "sync.resolve",
            "sync.repair",
            "cli.install",
            "cli.uninstall",
        ];
        for command in every_command() {
            let across = command.capability() == Capability::MutateAcross;
            assert_eq!(
                across,
                ACROSS.contains(&command.name()),
                "{} is {:?}",
                command.name(),
                command.capability()
            );
            assert_eq!(
                Grant::Project.allows(command.capability()),
                !across,
                "{}",
                command.name()
            );
        }
    }

    /// No method is claimed by two domains.
    ///
    /// [`Command::decode`] walks the domain lists in order and takes the first
    /// that contains the name, so a duplicate would not be an error anywhere —
    /// it would be a method that quietly decodes into the wrong domain, with a
    /// different capability and a different wire envelope. `project.` already
    /// means two things across two domains, which is how close this is.
    #[test]
    fn no_two_domains_claim_the_same_method() {
        let mut seen = std::collections::BTreeSet::new();
        for method in methods() {
            assert!(seen.insert(method), "{method} is declared by two domains");
        }
    }

    /// The name-only table a front door reads is the same one every other test
    /// on this page asserts, and it covers the whole surface.
    ///
    /// It is built by decoding, and a method that will not decode falls back to
    /// the narrowest grant rather than the widest. That fallback must never be
    /// what anything actually uses, so this asserts each entry against the
    /// decoded command it describes.
    #[test]
    fn every_method_declares_what_it_needs() {
        let table = capabilities();
        assert_eq!(table.len(), methods().count());
        for command in every_command() {
            assert_eq!(
                capability_of(command.name()),
                Some(command.capability()),
                "{} does not match the name-only table",
                command.name()
            );
        }
        assert_eq!(capability_of("thread.spawn"), None, "not a bus method");
    }

    /// One decoded command per method, with every parameter any of them reads.
    fn every_command() -> Vec<Command> {
        let params = probe_params();
        methods()
            .map(|method| {
                Command::decode(method, &params)
                    .unwrap_or_else(|err| panic!("{method} did not decode: {err}"))
            })
            .collect()
    }
}
