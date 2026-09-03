//! The canonical events every driver reduces its native protocol to.
//!
//! One shape for ten protocols: the store, the timeline and the sidebar read
//! these and never a driver's own frames. The JSON is tagged on `kind` with the
//! dotted names the design contract uses (`session.started`, not
//! `SessionStarted`), because those names are what lands in `pilot_events.kind`
//! and what a `logs.query` filter is written against. Renaming a variant is a
//! migration, so the `#[serde(rename = ...)]` is deliberate rather than derived
//! from the identifier.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// What a pilot thread is doing right now.
///
/// For `runtime = pilot` this is the only status source there is: no pid
/// registry, no screen rows, no clock. `waiting` outranks `busy` because a turn
/// blocked on an open request is a question for the user, not work in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// A turn is in flight.
    Busy,
    /// A request is open and nothing moves until it is answered.
    Waiting,
    /// No turn, no request. The state a session opens in.
    #[default]
    Idle,
}

/// The kinds of timeline item a driver can open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    AssistantText,
    Reasoning,
    ToolCall,
    Command,
    FileChange,
    Plan,
    UserMessage,
    Error,
}

/// One entry of the projected timeline.
///
/// `body` is per-kind and stays a free object: a tool card wants the tool name
/// and its input, an assistant message wants text, and neither the store nor
/// the webview gains anything from a Rust enum over the union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub kind: ItemKind,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub body: serde_json::Value,
}

impl Item {
    /// An item with an empty body, for the `item.started` edge where only the
    /// identity is known yet.
    pub fn new(id: impl Into<String>, kind: ItemKind, turn_id: Option<String>) -> Self {
        Self { id: id.into(), turn_id, kind, body: serde_json::Value::Null }
    }

    /// The same item carrying a body.
    pub fn with_body(mut self, body: serde_json::Value) -> Self {
        self.body = body;
        self
    }
}

/// What a driver is asking the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestKind {
    /// Permission to run a tool.
    ToolApproval,
    /// A free question the agent asked.
    Question,
    /// A plan waiting for a go-ahead.
    Plan,
}

/// One answer a driver offers, exactly as it offered it.
///
/// The label is the driver's own text and the `value` is opaque: boite draws
/// the options and hands the chosen `value` back untouched, so a driver can add
/// an option without the dock learning about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequestOption {
    pub value: String,
    pub label: String,
}

/// An open question, carried by `request.opened` and mirrored into `approvals`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub id: String,
    pub kind: RequestKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The options the driver offered, in its own order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<RequestOption>,
    /// The driver's own permission suggestions, passed through opaquely so an
    /// "always allow" answer can echo them back.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub suggestions: serde_json::Value,
}

/// How a request ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestOutcome {
    Allowed,
    Denied,
    /// Withdrawn by the driver, or lost with the process.
    Cancelled,
}

/// Tokens and cost for a turn, in the units the driver reports.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
    /// How many tokens the model's window holds, when the driver says so.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

/// Why a session ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    /// `stop` was called and the child left on its own.
    Stopped,
    /// The child exited without being asked to.
    Crashed { code: Option<i32> },
    /// The child ignored the polite stop and the job object took it.
    Killed,
}

/// The canonical event set. Every driver emits these and nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum PilotEvent {
    #[serde(rename = "session.started")]
    SessionStarted {
        #[serde(skip_serializing_if = "Option::is_none")]
        native_session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        slash_commands: Vec<String>,
        /// Whatever else the driver announced at init, kept opaque so a new
        /// field does not need a variant.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        extra: BTreeMap<String, serde_json::Value>,
    },
    #[serde(rename = "session.exited")]
    SessionExited { reason: ExitReason },

    #[serde(rename = "turn.started")]
    TurnStarted { turn_id: String },
    #[serde(rename = "turn.completed")]
    TurnCompleted {
        turn_id: String,
        duration_ms: u64,
        #[serde(default)]
        usage: Usage,
    },
    #[serde(rename = "turn.aborted")]
    TurnAborted {
        turn_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },

    #[serde(rename = "item.started")]
    ItemStarted { item: Item },
    /// Never stored. A delta carries the text appended to `item_id`, not the
    /// whole item, so a 200-item turn costs one string per item and not one row
    /// per token.
    #[serde(rename = "item.delta")]
    ItemDelta { item_id: String, text: String },
    #[serde(rename = "item.completed")]
    ItemCompleted { item: Item },

    #[serde(rename = "request.opened")]
    RequestOpened { request: Request },
    #[serde(rename = "request.resolved")]
    RequestResolved { request_id: String, outcome: RequestOutcome },

    #[serde(rename = "status.changed")]
    StatusChanged { status: Status },

    #[serde(rename = "model.changed")]
    ModelChanged { model: String },
    #[serde(rename = "usage.updated")]
    UsageUpdated { usage: Usage },

    #[serde(rename = "error")]
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
}

impl PilotEvent {
    /// The wire name, the same string `pilot_events.kind` stores.
    ///
    /// Kept as a match rather than derived from the serialization so a rename
    /// breaks the build here instead of writing a new value into an old column.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::SessionStarted { .. } => "session.started",
            Self::SessionExited { .. } => "session.exited",
            Self::TurnStarted { .. } => "turn.started",
            Self::TurnCompleted { .. } => "turn.completed",
            Self::TurnAborted { .. } => "turn.aborted",
            Self::ItemStarted { .. } => "item.started",
            Self::ItemDelta { .. } => "item.delta",
            Self::ItemCompleted { .. } => "item.completed",
            Self::RequestOpened { .. } => "request.opened",
            Self::RequestResolved { .. } => "request.resolved",
            Self::StatusChanged { .. } => "status.changed",
            Self::ModelChanged { .. } => "model.changed",
            Self::UsageUpdated { .. } => "usage.updated",
            Self::Error { .. } => "error",
        }
    }

    /// Whether the journal keeps this event. A text delta is live only: writing
    /// one row per token is the cost the design forbids outright.
    pub fn is_journaled(&self) -> bool {
        !matches!(self, Self::ItemDelta { .. } | Self::StatusChanged { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_round_trips_through_its_dotted_name() {
        let cases = vec![
            PilotEvent::SessionStarted {
                native_session_id: Some("s1".into()),
                model: Some("m".into()),
                slash_commands: vec!["init".into()],
                extra: BTreeMap::new(),
            },
            PilotEvent::SessionExited { reason: ExitReason::Stopped },
            PilotEvent::TurnStarted { turn_id: "t1".into() },
            PilotEvent::TurnCompleted {
                turn_id: "t1".into(),
                duration_ms: 12,
                usage: Usage::default(),
            },
            PilotEvent::TurnAborted { turn_id: "t1".into(), reason: None },
            PilotEvent::ItemStarted { item: Item::new("i1", ItemKind::AssistantText, None) },
            PilotEvent::ItemDelta { item_id: "i1".into(), text: "ok".into() },
            PilotEvent::ItemCompleted { item: Item::new("i1", ItemKind::AssistantText, None) },
            PilotEvent::RequestOpened {
                request: Request {
                    id: "r1".into(),
                    kind: RequestKind::ToolApproval,
                    tool_name: Some("Bash".into()),
                    tool_use_id: None,
                    input: serde_json::Value::Null,
                    title: None,
                    description: None,
                    options: vec![],
                    suggestions: serde_json::Value::Null,
                },
            },
            PilotEvent::RequestResolved {
                request_id: "r1".into(),
                outcome: RequestOutcome::Allowed,
            },
            PilotEvent::StatusChanged { status: Status::Idle },
            PilotEvent::ModelChanged { model: "m".into() },
            PilotEvent::UsageUpdated { usage: Usage::default() },
            PilotEvent::Error { message: "boom".into(), turn_id: None },
        ];
        assert_eq!(cases.len(), 14, "the canonical set changed; the store reads these names");
        for event in cases {
            let text = serde_json::to_string(&event).expect("serialize");
            let value: serde_json::Value = serde_json::from_str(&text).expect("parse");
            assert_eq!(value["kind"], event.kind(), "tag and kind() disagree");
            let back: PilotEvent = serde_json::from_str(&text).expect("deserialize");
            assert_eq!(back, event);
        }
    }

    #[test]
    fn deltas_and_status_stay_out_of_the_journal() {
        assert!(!PilotEvent::ItemDelta { item_id: "i".into(), text: "x".into() }.is_journaled());
        assert!(!PilotEvent::StatusChanged { status: Status::Busy }.is_journaled());
        assert!(PilotEvent::TurnStarted { turn_id: "t".into() }.is_journaled());
    }
}
