//! The contract every protocol adapter implements.
//!
//! A `Driver` opens sessions; a `Session` is one live conversation with one
//! child process. Everything above this file (the bus, the store, the chat
//! pane) knows only these types, which is what lets codex and ACP land later
//! without touching a host.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::event::{PilotEvent, Status};

/// Where a driver gets its credentials and its binary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Instance {
    /// A native account: the CLI on the PATH plus a config directory.
    ///
    /// `CLAUDE_CONFIG_DIR` and never `HOME`: pointing `HOME` at a per-account
    /// folder moves the shell, git and ssh configuration with it.
    Native {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        config_dir: Option<PathBuf>,
    },
    /// A fastpick route. Virtual: read from `fastpick --list --json`, never
    /// stored on the thread row.
    Fastpick { provider: String, model: String },
}

impl Default for Instance {
    fn default() -> Self {
        Self::Native { config_dir: None }
    }
}

/// How boite asks the agent to treat tool permissions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecMode {
    /// Every escalation becomes a request.
    #[default]
    Ask,
    /// File edits go through, everything else still asks.
    EditAlone,
    /// Nothing asks.
    Yolo,
}

/// Reasoning effort, passed through to the drivers that take one.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Options {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default)]
    pub mode: ExecMode,
}

/// One MCP server to hand the agent at launch. `boite-mcp` is always first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// Everything a driver needs to open or resume a session.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OpenSpec {
    /// The boite thread id, a uuid. claude gets it verbatim as `--session-id`,
    /// which is what lets "open in a terminal" resume the same conversation.
    pub thread_id: String,
    /// The worktree the child runs in.
    pub cwd: PathBuf,
    /// `"claude"`, later `"codex"`, `"acp:cursor"`, ...
    pub driver: String,
    #[serde(default)]
    pub instance: Instance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub options: Options,
    /// A native session id to resume. Set means the conversation already
    /// exists, so `--session-id` is not passed: the two flags are exclusive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<McpServer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_append: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// An explicit argv for the agent binary, first element the program.
    ///
    /// Empty means the driver decides (its own default, or the driver's env
    /// override). A `.mjs` fake is not executable on Windows, so a test passes
    /// `["node", "<script>"]` here rather than hunting for a `.cmd` shim.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bin: Vec<String>,
}

/// What `open` answers with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Opened {
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub pid: Option<u32>,
}

/// One user turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TurnInput {
    pub text: String,
    /// A model to switch to before the turn runs. The picker resolves whether
    /// that is an in-session switch or a restart before it gets here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<ModelSelection>,
    /// The turn id the caller has already minted, when it has.
    ///
    /// A driver mints its own when this is empty, which is every call that has
    /// nothing to say before the turn opens. The host names one when it has to
    /// write a row *before* the prompt goes out: the user's own message is the
    /// first card of a turn, and an item is filed under the turn it belongs to,
    /// so the id has to exist on this side of the call. Without it the message
    /// could only be written once `prompt` returned, which for a driver that
    /// answers inside `prompt` is after the whole turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

impl TurnInput {
    pub fn text(text: impl Into<String>) -> Self {
        Self { text: text.into(), selection: None, turn_id: None }
    }
}

/// A model, optionally on another instance.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelSelection {
    /// `None` resets the session to its default model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Set means another account, which no driver can do in session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<Instance>,
}

impl ModelSelection {
    pub fn model(model: impl Into<String>) -> Self {
        Self { model: Some(model.into()), instance: None }
    }
}

/// What a model switch actually did, so the picker can say so before the click.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SwitchKind {
    /// Nothing stopped.
    InSession,
    /// The caller has to stop and reopen with `resume`.
    Restart,
    /// The driver cannot change model at all.
    Unsupported,
}

/// What a driver can do, asked before the interface offers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Capabilities {
    pub model_switch: SwitchKind,
    /// Whether the driver can undo turns inside a live session.
    pub rollback: bool,
    /// The modes this driver maps to something native.
    pub modes: Vec<ExecMode>,
    /// Whether `interrupt` reaches a running turn.
    pub interrupt: bool,
}

/// The answer to an open request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "behavior", rename_all = "snake_case")]
pub enum RequestAnswer {
    Allow {
        /// The tool input the user edited, if the surface let them. `None`
        /// means the input the driver offered, untouched.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated_input: Option<serde_json::Value>,
        /// The driver's own permission suggestions, echoed back for an
        /// "always allow". Opaque here on purpose.
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        updated_permissions: serde_json::Value,
    },
    Deny {
        #[serde(default)]
        message: String,
    },
}

impl RequestAnswer {
    /// Plain approval of the input as offered.
    pub fn allow() -> Self {
        Self::Allow { updated_input: None, updated_permissions: serde_json::Value::Null }
    }

    /// Refusal with the sentence the model reads.
    pub fn deny(message: impl Into<String>) -> Self {
        Self::Deny { message: message.into() }
    }
}

/// A turn's identity, minted when the prompt is written.
pub type TurnId = String;

/// Everything that can go wrong, as strings the interface can show.
#[derive(Debug, thiserror::Error)]
pub enum PilotError {
    #[error("no pilot session for thread {0}")]
    NoSession(String),
    #[error("driver {0} is not installed")]
    UnknownDriver(String),
    #[error("the {0} session already ended")]
    SessionGone(String),
    #[error("no request {0} is open")]
    NoRequest(String),
    #[error("{0} does not support that")]
    Unsupported(String),
    #[error("could not start the agent: {0}")]
    Spawn(String),
    #[error("the agent protocol broke: {0}")]
    Protocol(String),
    #[error("the agent did not answer in time")]
    Timeout,
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for PilotError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

/// A driver's handle on the event stream of one session.
///
/// Cloneable and cheap: the reader task, the writer and the runtime all hold
/// one, and every event carries the thread id without the caller repeating it.
#[derive(Clone)]
pub struct SessionSink {
    thread_id: Arc<str>,
    sink: Arc<dyn EventSink>,
}

impl SessionSink {
    pub fn new(thread_id: impl Into<Arc<str>>, sink: Arc<dyn EventSink>) -> Self {
        Self { thread_id: thread_id.into(), sink }
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn emit(&self, event: PilotEvent) {
        tracing::debug!(thread = %self.thread_id, kind = event.kind(), "pilot.event");
        self.sink.emit(&self.thread_id, event);
    }
}

impl std::fmt::Debug for SessionSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionSink").field("thread_id", &self.thread_id).finish()
    }
}

/// Where events go. The host implements this once: the desktop pushes onto a
/// Tauri channel, the server onto its subscribers.
pub trait EventSink: Send + Sync {
    fn emit(&self, thread_id: &str, event: PilotEvent);
}

#[async_trait]
pub trait Driver: Send + Sync {
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;
    async fn open(&self, spec: OpenSpec, sink: SessionSink)
        -> Result<Box<dyn Session>, PilotError>;
}

#[async_trait]
pub trait Session: Send + Sync {
    async fn prompt(&self, input: TurnInput) -> Result<TurnId, PilotError>;
    async fn interrupt(&self) -> Result<(), PilotError>;
    async fn respond(&self, request_id: &str, answer: RequestAnswer) -> Result<(), PilotError>;
    async fn set_model(&self, selection: ModelSelection) -> Result<SwitchKind, PilotError>;
    async fn set_mode(&self, mode: ExecMode) -> Result<(), PilotError>;
    async fn stop(&self) -> Result<(), PilotError>;
    fn native_session_id(&self) -> Option<String>;
    /// Read without awaiting: the sidebar asks this once per pass and must not
    /// be able to block on a child that stopped answering.
    fn status(&self) -> Status;
    /// The pid captured at spawn. The only pid anything here may kill.
    fn pid(&self) -> Option<u32>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_serializes_as_the_driver_reads_it() {
        let allow = serde_json::to_value(RequestAnswer::allow()).expect("serialize");
        assert_eq!(allow["behavior"], "allow");
        let deny = serde_json::to_value(RequestAnswer::deny("no")).expect("serialize");
        assert_eq!(deny["behavior"], "deny");
        assert_eq!(deny["message"], "no");
    }

    #[test]
    fn an_open_spec_round_trips_with_its_defaults_absent() {
        let spec = OpenSpec {
            thread_id: "t".into(),
            cwd: PathBuf::from("."),
            driver: "claude".into(),
            ..Default::default()
        };
        let text = serde_json::to_string(&spec).expect("serialize");
        assert!(!text.contains("resume"), "an absent option must not ship a null");
        let back: OpenSpec = serde_json::from_str(&text).expect("deserialize");
        assert_eq!(back.thread_id, "t");
        assert_eq!(back.options.mode, ExecMode::Ask);
    }
}
