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
//!   Tauri command  ─┐                                    ┌─ prepare(host)  the boundary
//!                   ├─ Command ── Ready ── run() ── Value ┤
//!   WebSocket RPC  ─┘                                    └─ run()          the work
//! ```
//!
//! [`Command::prepare`] is the only thing that touches the [`Host`], and
//! [`Ready`] is the only thing that can be run. That is not decoration: it makes
//! "was this path checked against the trust boundary" a question with exactly
//! one answer per command, instead of a line a new command can forget to copy.
//! The test at the bottom of `command/git.rs` walks every command in the surface
//! and asserts that none of them prepares outside the registered roots.
//!
//! `Ready` is deliberately free of the host and of any lifetime, so a transport
//! can hand it to its own blocking pool. `boite-core` takes no async runtime and
//! this module does not change that: `run` blocks, and each transport wraps it
//! in whatever it already uses.

use std::path::PathBuf;

use serde_json::Value;

use crate::scope::ProjectRoots;

pub mod files;
pub mod git;

pub use files::Files;
pub use git::Git;

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

    /// Places a new project may go beyond the parents of the registered roots.
    ///
    /// The user's home on both sides; a server bound to a workspace directory
    /// adds that too.
    fn extra_project_parents(&self) -> Vec<String> {
        dirs::home_dir()
            .map(|home| vec![home.to_string_lossy().to_string()])
            .unwrap_or_default()
    }
}

/// Every method the bus serves, across every domain.
///
/// What a transport asks before handing a method over, so a front door that
/// still serves something itself cannot accidentally shadow a command — or be
/// shadowed by one. The lists are per domain and this is the only place they are
/// read together.
pub fn methods() -> impl Iterator<Item = &'static str> {
    git::ALL_METHODS.iter().chain(files::ALL_METHODS).copied()
}

/// Whether the bus answers for this method.
pub fn handles(method: &str) -> bool {
    methods().any(|m| m == method)
}

/// A capability, named and carrying its arguments.
///
/// One variant per method the front doors accept. Domains are separate enums so
/// this one stays a table of contents.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Files(Files),
    Git(Git),
}

impl From<Git> for Command {
    fn from(git: Git) -> Self {
        Command::Git(git)
    }
}

impl From<Files> for Command {
    fn from(files: Files) -> Self {
        Command::Files(files)
    }
}

impl Command {
    /// Reads a wire method name and its parameters into a command.
    ///
    /// The failure is the same sentence the WebSocket dispatcher used to
    /// produce, because it is the one the frontend already reads.
    pub fn decode(method: &str, params: &Value) -> Result<Self, String> {
        match method.split_once('.') {
            Some(("git", _)) | Some(("worktree", _)) => {
                Git::decode(method, params).map(Command::Git)
            }
            Some(("fs", _)) | Some(("file", _)) | Some(("project", _)) => {
                Files::decode(method, params).map(Command::Files)
            }
            _ => Err(format!("unknown method: {method}")),
        }
    }

    /// The wire name this command answers to. Round-trips with [`Command::decode`].
    pub fn name(&self) -> &'static str {
        match self {
            Command::Files(f) => f.name(),
            Command::Git(g) => g.name(),
        }
    }

    /// How the WebSocket protocol wraps this command's answer. See [`Wire`].
    pub fn wire(&self) -> Wire {
        match self {
            Command::Files(f) => f.wire(),
            Command::Git(g) => g.wire(),
        }
    }

    /// Checks the command against the host, and hands back something runnable.
    ///
    /// Everything the host has a say in happens here: the trust boundary, and
    /// any path the host rather than the caller decides. A command that turns
    /// out to have nothing to do comes back [`Ready::Settled`] with the answer
    /// already in it.
    pub fn prepare(self, host: &dyn Host) -> Result<Ready, String> {
        match self {
            Command::Files(f) => f.prepare(host),
            Command::Git(g) => g.prepare(host),
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
}

impl Ready {
    /// Does the work. Blocks: callers hand this to their own blocking pool.
    pub fn run(self) -> Result<Value, String> {
        match self {
            Ready::Settled(value) => Ok(value),
            Ready::Work(Command::Files(f)) => f.run(),
            Ready::Work(Command::Git(g)) => g.run(),
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
}
