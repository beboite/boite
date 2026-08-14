//! How a tool call reaches the workspace, said once.
//!
//! `call::call_tool` turns a tool name into a method and a path under `/v1`,
//! and does not care what carries them: the stdio shim signs them onto a
//! loopback socket, the server's `/mcp` route hands them to its own router
//! in-process. Both are a [`Backend`], and everything above them is one code
//! path instead of two that drift.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::Value;

/// One door to the workspace routes.
pub trait Backend {
    /// Sends one request at a `/v1` path and answers its JSON body.
    ///
    /// `Err` is a sentence the agent reads, so implementations translate their
    /// transport failures into one rather than leaking a status code.
    fn send(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String>;

    /// Keeps a short id next to the full one it stands for.
    fn remember(&self, short: &str, full: &str);

    /// The full id behind whatever the agent quoted.
    fn full_id(&self, given: &str) -> String;
}

/// Short id to full id, filled by every listing.
///
/// The stdio shim lives as long as the agent does, so a claim can quote the
/// eight characters it was shown instead of a full uuid. The `/mcp` route keeps
/// one per request for the same reason in miniature: a listing and a claim can
/// land in one call's dispatch. Single-threaded use on both doors, hence
/// `RefCell`.
#[derive(Default)]
pub struct IdCache(RefCell<HashMap<String, String>>);

impl IdCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn remember(&self, short: &str, full: &str) {
        self.0.borrow_mut().insert(short.to_string(), full.to_string());
    }

    /// Resolves a short id, fetching the list once when memory has nothing.
    ///
    /// A short id the agent saw in a listing this cache indexed resolves from
    /// memory. One it saw before a restart does not, so the list is fetched
    /// and asked again: one extra round trip on a path that would otherwise
    /// fail with a refusal the agent cannot act on. Anything else goes through
    /// untouched: a full uuid out of a task prompt is already the answer.
    pub fn resolve(&self, backend: &dyn Backend, given: &str) -> String {
        if let Some(full) = self.0.borrow().get(given) {
            return full.clone();
        }
        if given.len() >= 32 {
            return given.to_string();
        }
        if let Ok(out) = backend.send("GET", "/v1/todos", None) {
            crate::render::index_todos(backend, &out);
        }
        self.0
            .borrow()
            .get(given)
            .cloned()
            .unwrap_or_else(|| given.to_string())
    }
}

/// What a non-2xx status means to the agent, said the same through both doors.
///
/// The endpoint refuses a 409 without saying which reason applied; say the
/// same here rather than inventing a diagnosis. The two routes mean different
/// things by it, and telling an agent its todo is closed when the real answer
/// is "you have no worktree" sends it looking in the wrong place entirely.
pub fn refusal_for(path: &str, status: u16) -> String {
    if status == 409 {
        if path.starts_with("/v1/worktree") {
            return "this terminal has no worktree: it runs directly in the project folder, \
                    so branches here are the user's to make"
                .into();
        }
        return "that item is not open, or does not belong to this project".to_string();
    }
    format!("boite refused the call ({status})")
}
