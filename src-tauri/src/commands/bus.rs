//! The host every command in this crate is checked against.
//!
//! `boite_core::command::Host` is what a command is allowed to reach, and this
//! is the desktop's answer to it. One implementation, so "was this path checked
//! against the registered roots" has one answer per command rather than one per
//! Tauri command that remembered to ask.
//!
//! `Grant::Local` throughout: this door is the user's own window. An agent never
//! reaches it: it goes through the agent endpoint, which carries its own grant
//! and its own capability check.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::Manager;

use boite_core::capability::Grant;
use boite_core::command::Command;
use boite_core::pty::PtyManager;
use boite_core::scope::ProjectRoots;
use boite_core::store::Store;
use boite_core::telemetry::TelemetryRuntime;

/// The desktop's answer to what a command may reach.
///
/// Built per call, and small: the registered roots for anything that takes a
/// path, this app's own PTY manager for the one command that has to tell its
/// own live session from a neighbour's, and the directory an earlier release
/// put worktrees under. Everything else a command needs, it derives from what
/// the caller gave it.
pub(super) struct DesktopHost<'a> {
    roots: &'a ProjectRoots,
    manager: Option<&'a PtyManager>,
    legacy_worktree_base: Option<PathBuf>,
    transcripts: Option<PathBuf>,
    store: Option<Arc<Store>>,
    pulse: Option<Arc<boite_core::pulse::Waiters>>,
    telemetry: Option<Arc<TelemetryRuntime>>,
    pilot: Option<Arc<boite_pilot::Runtime>>,
    mcp: Option<boite_core::mcp_launch::McpPaths>,
}

impl<'a> DesktopHost<'a> {
    pub(super) fn new(roots: &'a ProjectRoots) -> Self {
        Self {
            roots,
            manager: None,
            legacy_worktree_base: None,
            transcripts: None,
            store: None,
            pulse: None,
            telemetry: None,
            pilot: None,
            mcp: None,
        }
    }

    /// This app's pilot runtime, attached by the pilot codec and by the conduct
    /// one, which is where a post or a dispatch becomes a turn when the thread
    /// on the other end is a chat one. Every other command answers `None` and
    /// the domain refuses by name, which is what keeps a chat call off a host
    /// that has no children to drive.
    pub(super) fn with_pilot(mut self, pilot: Arc<boite_pilot::Runtime>) -> Self {
        self.pilot = Some(pilot);
        self
    }

    /// Where this app wrote the sidecar and its generated config, so a pilot
    /// thread is launched with the same boite-mcp a terminal thread gets.
    pub(super) fn with_mcp(mut self, paths: boite_core::mcp_launch::McpPaths) -> Self {
        self.mcp = Some(paths);
        self
    }

    /// The app's wait registry, so a conduct write here wakes the agent
    /// endpoint's long-polls. Only the conduct commands attach it.
    pub(super) fn with_pulse(mut self, pulse: Arc<boite_core::pulse::Waiters>) -> Self {
        self.pulse = Some(pulse);
        self
    }

    /// Where this app writes what its terminals print. Built from the app
    /// handle rather than held, so a command that has one can answer and one
    /// that has none says so.
    pub(super) fn with_transcripts(mut self, app: &tauri::AppHandle) -> Self {
        self.transcripts = app
            .path()
            .app_config_dir()
            .ok()
            .map(|dir| dir.join("transcripts"));
        self
    }

    pub(super) fn with_pty(mut self, manager: &'a PtyManager) -> Self {
        self.manager = Some(manager);
        self
    }

    pub(super) fn with_legacy_worktree_base(mut self, base: PathBuf) -> Self {
        self.legacy_worktree_base = Some(base);
        self
    }

    /// The rows this app keeps. Attached once and held in `commands::records`,
    /// rather than opened per call the way every earlier reader on this side
    /// did.
    pub(super) fn with_store(mut self, store: Arc<Store>) -> Self {
        self.store = Some(store);
        self
    }

    pub(super) fn with_telemetry(mut self, telemetry: Arc<TelemetryRuntime>) -> Self {
        self.telemetry = Some(telemetry);
        self
    }
}

impl boite_core::command::Host for DesktopHost<'_> {
    fn roots(&self) -> &ProjectRoots {
        self.roots
    }

    fn legacy_worktree_base(&self) -> Option<PathBuf> {
        self.legacy_worktree_base.clone()
    }

    fn child_pid(&self, pty_id: &str) -> Option<u32> {
        self.manager.and_then(|m| m.child_pid(pty_id))
    }

    fn transcripts_dir(&self) -> Option<PathBuf> {
        self.transcripts.clone()
    }

    fn store(&self) -> Option<Arc<Store>> {
        self.store.clone()
    }

    fn pulse_waiters(&self) -> Option<Arc<boite_core::pulse::Waiters>> {
        self.pulse.clone()
    }

    fn telemetry(&self) -> Option<Arc<TelemetryRuntime>> {
        self.telemetry.clone()
    }

    fn pilot(&self) -> Option<Arc<boite_pilot::Runtime>> {
        self.pilot.clone()
    }

    /// boite-mcp first, with the environment this app already stamps into a
    /// PTY so the sidecar knows which thread is calling it.
    fn pilot_mcp(&self, thread_id: &str) -> Vec<boite_pilot::McpServer> {
        let Some(paths) = &self.mcp else {
            return Vec::new();
        };
        vec![boite_core::command::pilot::boite_mcp_server(
            paths.sidecar.to_string_lossy().into_owned(),
            Vec::new(),
            vec![(
                boite_identity::env::THREAD.to_string(),
                thread_id.to_string(),
            )],
        )]
    }
}

/// Puts a command through the bus and hands back its answer.
///
/// Every git, worktree, filesystem and session capability on this side is one of
/// these: the trust boundary, the work and the refusals all live in
/// `boite_core::command`, and what is left here is naming the command and
/// handing over the arguments the webview sent. The desktop reads an answer bare:
/// the envelopes in `command::Wire` are the WebSocket protocol's, and `invoke`
/// already carries the shape the frontend types.
pub(super) async fn through(host: DesktopHost<'_>, command: Command) -> Result<Value, String> {
    let method = command.name();
    // `Local`: this door is the user's own window. An agent never reaches it:
    // it goes through the agent endpoint, which carries its own grant.
    let ready = match command.prepare(&host, Grant::Local) {
        Ok(ready) => ready,
        Err(refusal) => {
            // Once, at the codec, so a refusal is on the same clock as whatever
            // the window did next. `src/lib/backend/tauri/ipc.ts` already writes
            // its own `warn` on this side of the boundary; this is the half
            // that says which command and why, in Rust's own words.
            tracing::warn!(method, reason = %refusal, "bus.refused");
            return Err(refusal);
        }
    };
    // Two verbs of the conduct domain prepare as a pilot call when the thread
    // on the other end is a chat one (`Conduct::as_pilot_turn`), and that work
    // awaits a child process rather than blocking a pool thread. The same
    // executor the pilot door uses, so one conversion has one implementation.
    let answer = match ready {
        boite_core::command::Ready::Pilot(ready) => {
            boite_core::pilot_host::execute(*ready).await
        }
        ready => tauri::async_runtime::spawn_blocking(move || ready.run())
            .await
            .map_err(|e| format!("command task failed: {e}"))?,
    };
    if let Err(failure) = &answer {
        tracing::warn!(method, reason = %failure, "bus.failed");
    }
    answer
}

/// The common form: a command that needs nothing but the roots.
pub(super) async fn on_bus(roots: &ProjectRoots, command: Command) -> Result<Value, String> {
    through(DesktopHost::new(roots), command).await
}

/// A session lookup, which needs this app's PTY manager to know which process
/// the caller's own terminal is running.
pub(super) async fn on_bus_with_pty(
    roots: &ProjectRoots,
    manager: &PtyManager,
    command: Command,
) -> Result<Value, String> {
    through(DesktopHost::new(roots).with_pty(manager), command).await
}
