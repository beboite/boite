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
    /// resolves it against the repository — which lives here — before showing
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
    /// setting, which is what every project did before the column existed.
    #[serde(default)]
    pub worktrees: Option<bool>,
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
}

fn default_status() -> String {
    "idle".to_string()
}
