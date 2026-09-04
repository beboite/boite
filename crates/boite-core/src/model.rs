use serde::{Deserialize, Serialize};

/// Mirrors the frontend TodoItem. `state` is `open`, `claimed` or `done`:
/// an agent may only reach `claimed`, so the list records what a human
/// confirmed rather than what a model asserted.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub project_id: String,
    /// The one-line label. Stored in the `text` column, which is what it was
    /// called when it was the only thing on a row; `text` stays accepted on the
    /// wire so a client built before the split still saves.
    #[serde(alias = "text")]
    pub title: String,
    /// The body of the card, when the title was not the whole story. Kept apart
    /// so the label stays one line whatever an agent writes into the detail.
    #[serde(default)]
    pub description: Option<String>,
    pub state: String,
    #[serde(default)]
    pub note: Option<String>,
    /// The commit an agent reported with its claim, stored as given. The client
    /// resolves it against the repository, which lives here, before showing
    /// it, so a sha nothing backs reads as unknown rather than as done.
    #[serde(default)]
    pub commit_sha: Option<String>,
    /// The icon key of the agent that claimed it, filled in only when this
    /// server spawned the terminal. An agent it did not start is one it cannot
    /// name.
    #[serde(default)]
    pub claimed_by: Option<String>,
    #[serde(default)]
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub icon: Option<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub git_root: Option<String>,
    /// Whether new threads here open their own worktree. None follows the app
    /// setting. New projects stamp false, so a later flip of that setting
    /// does not start isolating threads nobody asked to isolate.
    #[serde(default)]
    pub worktrees: Option<bool>,
    /// MCP servers explicitly enabled for this project. None preserves the
    /// agent's own global configuration, which is how projects behaved before
    /// this setting existed. An empty list deliberately disables every server.
    #[serde(default)]
    pub mcp_server_ids: Option<Vec<String>>,
}

// Mirrors the frontend Thread type. `pty_id` and `status` reflect live server
// state and are filled from the registry on read; persisted columns are the
// rest. `auto_slept` is a client-only concept, always false over the wire.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub pty_id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub title: Option<String>,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub icon_key: Option<String>,
    #[serde(default)]
    pub icon_color: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub auto_slept: bool,
    #[serde(default)]
    pub keep_awake: bool,
    /// Directory the thread runs in when it is not the project's own.
    #[serde(default)]
    pub worktree_path: Option<String>,
    /// When this thread was put away as finished, or None while it is live.
    ///
    /// A whole-row save never carries it: the window's copy is a snapshot, and
    /// another device may have put the thread away since. `thread.create` reads
    /// the row's own answer back before it writes, the way it does for the
    /// status of the last run.
    #[serde(default)]
    pub settled_at: Option<i64>,
    /// Parent thread ID when this thread was spawned as a delegation.
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    /// Whether this is a normal thread or a delegation sub-thread.
    #[serde(default)]
    pub delegation_mode: Option<String>,
    /// Lifecycle status for delegation threads.
    #[serde(default)]
    pub delegation_status: Option<String>,
    /// `"orchestrator"` on a thread Boite spawned as one, `None` on every
    /// worker. Stamped by Boite at creation; `thread.update` cannot reach it
    /// and `thread.create` ignores what a caller claims: it is what selects
    /// the orchestrator tool tier, so it must not be claimable.
    #[serde(default)]
    pub role: Option<String>,
    /// The project an orchestrator is scoped to, or `None` for the global one.
    /// Same write rules as `role`.
    #[serde(default)]
    pub orchestrator_scope: Option<String>,
    /// Whether this thread still accepts dispatched lines. The user mutes a
    /// thread; an agent never re-arms one, which is why no agent-reachable
    /// write carries it.
    #[serde(default = "default_accept_dispatch")]
    pub accept_dispatch: bool,
    /// Which runtime drives this thread: `"terminal"` (a PTY boite watches) or
    /// `"pilot"` (an agent process it talks to over the agent's own protocol).
    ///
    /// Defaulted rather than optional: every row that existed before the pilot
    /// is a terminal, and a client that says nothing is asking for one too.
    #[serde(default = "default_runtime")]
    pub runtime: String,
    /// The pilot driver id (`"claude"`, later `"codex"`, `"acp:cursor"`).
    /// Absent on a terminal row, which is why all four are optional and skipped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pilot_driver: Option<String>,
    /// `boite_pilot::Instance` as JSON: a native config directory, or a
    /// fastpick route. Kept as a string here so `boite-core`'s row model does
    /// not have to move whenever the crate grows an instance kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pilot_instance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pilot_model: Option<String>,
    /// `boite_pilot::Options` as JSON: effort and execution mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pilot_options: Option<String>,
}

/// What a row with nothing to say about its runtime is.
pub fn default_runtime() -> String {
    RUNTIME_TERMINAL.to_string()
}

/// A thread boite watches from the outside, through a PTY.
pub const RUNTIME_TERMINAL: &str = "terminal";
/// A thread boite talks to over the agent's own machine protocol.
pub const RUNTIME_PILOT: &str = "pilot";

fn default_status() -> String {
    "idle".to_string()
}

fn default_accept_dispatch() -> bool {
    true
}
