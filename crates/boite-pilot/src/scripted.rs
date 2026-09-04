//! A driver with no process behind it, replaying a scenario file.
//!
//! Two callers. The wire tests use it to assert that the runtime, the sink and
//! the status rules behave without a child in the way, and the e2e scenarios
//! use it to drive the chat pane at a fixed pace: an interface proof that spent
//! tokens or needed a credential would not run in CI.
//!
//! The scenario is the same JSON the fake claude binary reads, so one file can
//! be pointed at either and the two must agree.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::driver::{
    Capabilities, Driver, ExecMode, ModelSelection, OpenSpec, PilotError, RequestAnswer, Session,
    SessionSink, SwitchKind, TurnId, TurnInput,
};
use crate::event::{
    ExitReason, Item, ItemKind, PilotEvent, Request, RequestKind, RequestOption, RequestOutcome,
    Status, Usage,
};

/// The env var pointing at the scenario file, so a test picks its scenario the
/// same way it picks the fake binary.
pub const SCENARIO_ENV: &str = "BOITE_PILOT_SCENARIO";

/// One step: a prompt, and what answering it produces.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Step {
    /// The prompt this step answers. `None` matches any prompt not claimed by
    /// an earlier step, which is what makes a one-step scenario useful.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Text emitted as deltas, one entry per delta, then completed as one item.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deltas: Vec<String>,
    /// A tool approval to open before the turn can finish.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<ScenarioRequest>,
    /// What the turn reports when it ends.
    #[serde(default)]
    pub usage: Usage,
    #[serde(default)]
    pub duration_ms: u64,
    /// End the turn as an abort rather than a completion.
    #[serde(default)]
    pub abort: bool,
    /// Exit the session after this step, as a child that died mid-turn does.
    #[serde(default)]
    pub exit: bool,
}

/// A tool approval a step opens.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScenarioRequest {
    pub tool_name: String,
    #[serde(default)]
    pub input: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A whole scripted session.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Scenario {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slash_commands: Vec<String>,
    #[serde(default)]
    pub steps: Vec<Step>,
}

impl Scenario {
    pub fn read(path: &Path) -> Result<Self, PilotError> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| PilotError::Io(format!("{}: {error}", path.display())))?;
        serde_json::from_str(&text)
            .map_err(|error| PilotError::Protocol(format!("{}: {error}", path.display())))
    }

    /// The step answering `prompt`: an exact match first, then the first step
    /// with no prompt of its own.
    fn step_for(&self, prompt: &str, used: &[usize]) -> Option<(usize, &Step)> {
        self.steps
            .iter()
            .enumerate()
            .find(|(i, step)| !used.contains(i) && step.prompt.as_deref() == Some(prompt))
            .or_else(|| {
                self.steps
                    .iter()
                    .enumerate()
                    .find(|(i, step)| !used.contains(i) && step.prompt.is_none())
            })
    }
}

/// A driver that reads its scenario from `OpenSpec::bin` (a path) or from
/// `BOITE_PILOT_SCENARIO`.
pub struct ScriptedDriver {
    scenario: Option<Scenario>,
}

impl ScriptedDriver {
    /// Read the scenario when the session opens, from the spec or the env.
    pub fn from_env() -> Self {
        Self { scenario: None }
    }

    /// A driver carrying its scenario in memory, for a test with no file.
    pub fn with_scenario(scenario: Scenario) -> Self {
        Self { scenario: Some(scenario) }
    }

    fn resolve(&self, spec: &OpenSpec) -> Result<Scenario, PilotError> {
        if let Some(scenario) = self.scenario.clone() {
            return Ok(scenario);
        }
        let path = spec
            .bin
            .first()
            .map(PathBuf::from)
            .or_else(|| std::env::var(SCENARIO_ENV).ok().map(PathBuf::from))
            .ok_or_else(|| {
                PilotError::Spawn(format!("no scenario: set {SCENARIO_ENV} or OpenSpec::bin"))
            })?;
        Scenario::read(&path)
    }
}

#[async_trait]
impl Driver for ScriptedDriver {
    fn id(&self) -> &'static str {
        "scripted"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            model_switch: SwitchKind::InSession,
            rollback: false,
            modes: vec![ExecMode::Ask, ExecMode::EditAlone, ExecMode::Yolo],
            interrupt: true,
        }
    }

    async fn open(
        &self,
        spec: OpenSpec,
        sink: SessionSink,
    ) -> Result<Box<dyn Session>, PilotError> {
        let scenario = self.resolve(&spec)?;
        let native_session_id = scenario
            .native_session_id
            .clone()
            .or_else(|| spec.resume.clone())
            .or_else(|| Some(spec.thread_id.clone()));

        let session = ScriptedSession {
            state: Mutex::new(ScriptedState {
                status: Status::Idle,
                native_session_id: native_session_id.clone(),
                model: scenario.model.clone(),
                turn: None,
                used: Vec::new(),
                open_request: None,
                exited: false,
            }),
            scenario,
            sink: sink.clone(),
        };
        sink.emit(PilotEvent::SessionStarted {
            native_session_id,
            model: session.scenario.model.clone(),
            slash_commands: session.scenario.slash_commands.clone(),
            extra: Default::default(),
        });
        Ok(Box::new(session))
    }
}

struct ScriptedState {
    status: Status,
    native_session_id: Option<String>,
    model: Option<String>,
    turn: Option<String>,
    used: Vec<usize>,
    /// The open request and the step index it belongs to, so answering it
    /// resumes that step.
    open_request: Option<(String, usize)>,
    exited: bool,
}

pub struct ScriptedSession {
    scenario: Scenario,
    sink: SessionSink,
    state: Mutex<ScriptedState>,
}

impl ScriptedSession {
    fn set_status(&self, status: Status) {
        let changed = {
            let mut state = self.state.lock();
            let changed = state.status != status;
            state.status = status;
            changed
        };
        if changed {
            self.sink.emit(PilotEvent::StatusChanged { status });
        }
    }

    /// Play a step from its deltas to its end, stopping at an open request.
    fn play(&self, index: usize, turn_id: &str, from_request: bool) {
        let step = self.scenario.steps[index].clone();

        if !from_request {
            let item_id = format!("{turn_id}#0");
            self.sink.emit(PilotEvent::ItemStarted {
                item: Item::new(&item_id, ItemKind::AssistantText, Some(turn_id.to_string())),
            });
            let mut text = String::new();
            for delta in &step.deltas {
                text.push_str(delta);
                self.sink
                    .emit(PilotEvent::ItemDelta { item_id: item_id.clone(), text: delta.clone() });
            }
            self.sink.emit(PilotEvent::ItemCompleted {
                item: Item::new(&item_id, ItemKind::AssistantText, Some(turn_id.to_string()))
                    .with_body(serde_json::json!({ "text": text })),
            });

            if let Some(request) = step.request.clone() {
                let request_id = format!("req_{}", uuid::Uuid::new_v4());
                self.state.lock().open_request = Some((request_id.clone(), index));
                self.sink.emit(PilotEvent::RequestOpened {
                    request: Request {
                        id: request_id,
                        kind: RequestKind::ToolApproval,
                        tool_name: Some(request.tool_name),
                        tool_use_id: None,
                        input: request.input,
                        title: request.title,
                        description: None,
                        options: vec![
                            RequestOption { value: "allow".into(), label: "Allow".into() },
                            RequestOption { value: "deny".into(), label: "Deny".into() },
                        ],
                        suggestions: serde_json::Value::Null,
                    },
                });
                self.set_status(Status::Waiting);
                return;
            }
        }

        self.state.lock().turn = None;
        if step.abort {
            self.sink.emit(PilotEvent::TurnAborted {
                turn_id: turn_id.to_string(),
                reason: Some("scenario".to_string()),
            });
        } else {
            self.sink.emit(PilotEvent::TurnCompleted {
                turn_id: turn_id.to_string(),
                duration_ms: step.duration_ms,
                usage: step.usage.clone(),
            });
        }
        self.sink.emit(PilotEvent::UsageUpdated { usage: step.usage });
        self.set_status(Status::Idle);

        if step.exit {
            self.state.lock().exited = true;
            self.sink.emit(PilotEvent::SessionExited {
                reason: ExitReason::Crashed { code: Some(1) },
            });
        }
    }
}

#[async_trait]
impl Session for ScriptedSession {
    async fn prompt(&self, input: TurnInput) -> Result<TurnId, PilotError> {
        let turn_id = input
            .turn_id
            .clone()
            .unwrap_or_else(|| format!("turn_{}", uuid::Uuid::new_v4()));
        let index = {
            let mut state = self.state.lock();
            if state.exited {
                return Err(PilotError::SessionGone("the scenario ended".to_string()));
            }
            let Some((index, _)) = self.scenario.step_for(&input.text, &state.used) else {
                return Err(PilotError::Protocol(format!("no scenario step for {:?}", input.text)));
            };
            state.used.push(index);
            state.turn = Some(turn_id.clone());
            index
        };
        self.sink.emit(PilotEvent::TurnStarted { turn_id: turn_id.clone() });
        self.set_status(Status::Busy);
        self.play(index, &turn_id, false);
        Ok(turn_id)
    }

    async fn interrupt(&self) -> Result<(), PilotError> {
        let turn = self.state.lock().turn.take();
        if let Some(turn_id) = turn {
            self.sink
                .emit(PilotEvent::TurnAborted { turn_id, reason: Some("interrupted".to_string()) });
        }
        self.set_status(Status::Idle);
        Ok(())
    }

    async fn respond(&self, request_id: &str, answer: RequestAnswer) -> Result<(), PilotError> {
        let (index, turn_id) = {
            let mut state = self.state.lock();
            match state.open_request.take() {
                Some((id, index)) if id == request_id => {
                    (index, state.turn.clone().unwrap_or_default())
                }
                other => {
                    state.open_request = other;
                    return Err(PilotError::NoRequest(request_id.to_string()));
                }
            }
        };
        let outcome = match answer {
            RequestAnswer::Allow { .. } => RequestOutcome::Allowed,
            RequestAnswer::Deny { .. } => RequestOutcome::Denied,
        };
        self.sink
            .emit(PilotEvent::RequestResolved { request_id: request_id.to_string(), outcome });
        self.set_status(Status::Busy);
        self.play(index, &turn_id, true);
        Ok(())
    }

    async fn set_model(&self, selection: ModelSelection) -> Result<SwitchKind, PilotError> {
        if selection.instance.is_some() {
            return Ok(SwitchKind::Restart);
        }
        if let Some(model) = selection.model {
            self.state.lock().model = Some(model.clone());
            self.sink.emit(PilotEvent::ModelChanged { model });
        }
        Ok(SwitchKind::InSession)
    }

    async fn set_mode(&self, _mode: ExecMode) -> Result<(), PilotError> {
        Ok(())
    }

    async fn stop(&self) -> Result<(), PilotError> {
        let already = std::mem::replace(&mut self.state.lock().exited, true);
        if !already {
            self.sink.emit(PilotEvent::SessionExited { reason: ExitReason::Stopped });
        }
        Ok(())
    }

    fn native_session_id(&self) -> Option<String> {
        self.state.lock().native_session_id.clone()
    }

    fn status(&self) -> Status {
        self.state.lock().status
    }

    fn pid(&self) -> Option<u32> {
        None
    }
}

/// A sink that keeps every event, for a test that reads them back.
#[derive(Default)]
pub struct Recorder {
    events: Mutex<Vec<(String, PilotEvent)>>,
}

impl Recorder {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn events(&self) -> Vec<PilotEvent> {
        self.events.lock().iter().map(|(_, event)| event.clone()).collect()
    }

    pub fn kinds(&self) -> Vec<&'static str> {
        self.events.lock().iter().map(|(_, event)| event.kind()).collect()
    }
}

impl crate::driver::EventSink for Recorder {
    fn emit(&self, thread_id: &str, event: PilotEvent) {
        self.events.lock().push((thread_id.to_string(), event));
    }
}
