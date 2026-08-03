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

pub mod git;

pub use git::Git;

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
}

/// A capability, named and carrying its arguments.
///
/// One variant per method the front doors accept. Domains are separate enums so
/// this one stays a table of contents.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Git(Git),
}

impl From<Git> for Command {
    fn from(git: Git) -> Self {
        Command::Git(git)
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
            _ => Err(format!("unknown method: {method}")),
        }
    }

    /// The wire name this command answers to. Round-trips with [`Command::decode`].
    pub fn name(&self) -> &'static str {
        match self {
            Command::Git(g) => g.name(),
        }
    }

    /// How the WebSocket protocol wraps this command's answer. See [`Wire`].
    pub fn wire(&self) -> Wire {
        match self {
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
}

impl<'a> Scoped<'a> {
    pub fn new(roots: &'a ProjectRoots) -> Self {
        Self {
            roots,
            legacy_worktree_base: None,
        }
    }

    /// Declares where this host's earlier layout left worktrees behind.
    pub fn with_legacy_worktree_base(mut self, base: Option<PathBuf>) -> Self {
        self.legacy_worktree_base = base;
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
}
