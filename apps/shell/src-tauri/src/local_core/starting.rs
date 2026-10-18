//! `core.starting.json`: long work a core does before it serves, such as the
//! one compaction of its journal, so that the wait goes past the start
//! timeout and the window can say what it is waiting for.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::health::{same_core, CoreStart};

/// The longest a start doing that work is waited on. Compacting a 4 GB
/// journal took about a minute on a busy machine.
pub(crate) const STARTING_CAP: Duration = Duration::from_secs(30 * 60);
const FILE: &str = "core.starting.json";

/// What the core says it does before it serves, as the UI reads it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Starting {
    #[serde(skip_serializing)]
    pub pid: u32,
    /// `compacting` for now.
    pub phase: String,
    /// When that work started, in milliseconds since the epoch.
    pub started_at: u64,
    /// The bytes it works through.
    pub bytes: u64,
    /// `platform::process::start_key` of the core, where the OS names a run
    /// with one (Linux).
    #[serde(default, skip_serializing)]
    pub start_key: Option<String>,
}

/// The work a running core announced; None without a file, for one that
/// cannot be read, or for a file a core left when it exited, even once its
/// pid names a later process (`health::same_core`): a crash during that work
/// leaves the file, and the next start must not wait on whatever got the pid.
pub(crate) fn read_starting(directory: &Path) -> Option<Starting> {
    let text = std::fs::read_to_string(directory.join(FILE)).ok()?;
    let starting: Starting = serde_json::from_str(&text).ok()?;
    let start = CoreStart { at: Some(starting.started_at), key: starting.start_key.clone() };
    same_core(starting.pid, &start).then_some(starting)
}
