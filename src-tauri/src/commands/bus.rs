//! The host every command in this crate is checked against.
//!
//! `boite_core::command::Host` is what a command is allowed to reach, and this
//! is the desktop's answer to it. One implementation, so "was this path checked
//! against the registered roots" has one answer per command rather than one per
//! Tauri command that remembered to ask.
//!
//! `Grant::Local` throughout: this door is the user's own window. An agent never
//! reaches it — it goes through the agent endpoint, which carries its own grant
//! and its own capability check.

use std::path::PathBuf;


use serde_json::Value;

use boite_core::capability::Grant;
use boite_core::command::Command;
use boite_core::pty::PtyManager;
use boite_core::scope::ProjectRoots;



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
}

impl<'a> DesktopHost<'a> {
    pub(super) fn new(roots: &'a ProjectRoots) -> Self {
        Self {
            roots,
            manager: None,
            legacy_worktree_base: None,
        }
    }

    pub(super) fn with_pty(mut self, manager: &'a PtyManager) -> Self {
        self.manager = Some(manager);
        self
    }

    pub(super) fn with_legacy_worktree_base(mut self, base: PathBuf) -> Self {
        self.legacy_worktree_base = Some(base);
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
}

/// Puts a command through the bus and hands back its answer.
///
/// Every git, worktree, filesystem and session capability on this side is one of
/// these: the trust boundary, the work and the refusals all live in
/// `boite_core::command`, and what is left here is naming the command and
/// handing over the arguments the webview sent. The desktop reads an answer bare
/// — the envelopes in `command::Wire` are the WebSocket protocol's, and `invoke`
/// already carries the shape the frontend types.
pub(super) async fn through(host: DesktopHost<'_>, command: Command) -> Result<Value, String> {
    // `Local`: this door is the user's own window. An agent never reaches it —
    // it goes through the agent endpoint, which carries its own grant.
    let ready = command.prepare(&host, Grant::Local)?;
    tauri::async_runtime::spawn_blocking(move || ready.run())
        .await
        .map_err(|e| format!("command task failed: {e}"))?
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
