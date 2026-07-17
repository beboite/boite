use serde::{Deserialize, Serialize};

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
}

fn default_status() -> String {
    "idle".to_string()
}
