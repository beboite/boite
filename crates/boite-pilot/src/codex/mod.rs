//! Codex App Server driver.
//!
//! T3 Code runs one App Server process per provider session and reduces its
//! JSON-RPC stream before any client sees it. Boite does the same here: the
//! Rust host owns stdio and the webview receives only `PilotEvent` values.

mod inventory;
mod protocol;
mod reduce;
mod steer;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::driver::{
    Capabilities, Driver, ExecMode, ModelSelection, OpenSpec, PilotError, RequestAnswer, Session,
    SessionSink, SwitchKind, TurnId, TurnInput,
};
use crate::event::{ExitReason, PilotEvent, RequestOutcome, Status, Usage};
use crate::proc::{Child, Line};

pub use protocol::{codex_argv, BIN_ENV};

/// Offline fallback matching T3 Code's Codex model manifest at the reference
/// revision used for this port. App Server remains authoritative when a live
/// catalogue is available; this list keeps a disconnected picker useful.
pub const NATIVE_MODELS: &[&str] = &[
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-daybreak-blue-latest",
    "gpt-daybreak-red-latest",
];

const INIT_TIMEOUT: Duration = Duration::from_secs(60);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);

pub struct CodexDriver;

#[async_trait]
impl Driver for CodexDriver {
    fn id(&self) -> &'static str {
        "codex"
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
        Ok(Box::new(CodexSession::open(spec, sink).await?))
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) enum ApprovalWire {
    Command,
    FileChange,
    LegacyCommand,
    LegacyPatch,
}

#[derive(Debug, Clone)]
pub(super) enum PendingKind {
    Approval(ApprovalWire),
    UserInput { question_ids: Vec<String> },
}

#[derive(Debug, Clone)]
pub(super) struct PendingRequest {
    pub rpc_id: Value,
    pub kind: PendingKind,
}

pub(super) struct State {
    pub status: Status,
    pub native_thread_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: ExecMode,
    pub turn: Option<String>,
    pub provider_turn: Option<String>,
    pub turn_started_ms: u64,
    pub usage: Usage,
    pub open_items: HashSet<String>,
    pub open_requests: HashMap<String, PendingRequest>,
    pub interrupting: bool,
    pub stopping: bool,
    pub exited: bool,
}

impl Default for State {
    fn default() -> Self {
        Self {
            status: Status::Idle,
            native_thread_id: None,
            model: None,
            effort: None,
            mode: ExecMode::Ask,
            turn: None,
            provider_turn: None,
            turn_started_ms: 0,
            usage: Usage::default(),
            open_items: HashSet::new(),
            open_requests: HashMap::new(),
            interrupting: false,
            stopping: false,
            exited: false,
        }
    }
}

pub(super) struct Shared {
    pub sink: SessionSink,
    pub state: Mutex<State>,
    pending_calls: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl Shared {
    pub fn set_status(&self, status: Status) {
        let changed = {
            let mut state = self.state.lock();
            if state.status == status {
                false
            } else {
                state.status = status;
                true
            }
        };
        if changed {
            self.sink.emit(PilotEvent::StatusChanged { status });
        }
    }

    pub fn settle_status(&self) {
        let status = {
            let state = self.state.lock();
            if !state.open_requests.is_empty() {
                Status::Waiting
            } else if state.turn.is_some() {
                Status::Busy
            } else {
                Status::Idle
            }
        };
        self.set_status(status);
    }
}

pub struct CodexSession {
    shared: Arc<Shared>,
    child: Arc<AsyncMutex<Child>>,
    pid: Option<u32>,
}

impl CodexSession {
    async fn open(spec: OpenSpec, sink: SessionSink) -> Result<Self, PilotError> {
        let argv = protocol::codex_argv(&spec);
        let env = protocol::env_for(&spec);
        tracing::info!(thread = %spec.thread_id, argv = ?argv, "pilot.codex.open");
        let (child, rx) = Child::spawn(&argv, &spec.cwd, &env)?;
        let pid = child.pid();
        let child = Arc::new(AsyncMutex::new(child));
        let shared = Arc::new(Shared {
            sink,
            state: Mutex::new(State {
                model: spec.model.clone(),
                effort: spec.options.effort.clone(),
                mode: spec.options.mode,
                ..State::default()
            }),
            pending_calls: Mutex::new(HashMap::new()),
        });
        tokio::spawn(read_loop(Arc::clone(&shared), Arc::clone(&child), rx));

        let session = Self { shared, child, pid };
        let opened = session.initialize(&spec).await;
        if opened.is_err() {
            session.shared.state.lock().stopping = true;
            session.child.lock().await.stop().await;
        }
        opened.map(|_| session)
    }

    async fn initialize(&self, spec: &OpenSpec) -> Result<(), PilotError> {
        self.request("initialize", protocol::initialize_params(), INIT_TIMEOUT)
            .await?;
        self.notify("initialized", None).await?;

        let params = protocol::thread_params(spec);
        let result = if let Some(thread_id) = &spec.resume {
            let mut resume = params.clone();
            resume["threadId"] = Value::String(thread_id.clone());
            match self.request("thread/resume", resume, INIT_TIMEOUT).await {
                Ok(result) => result,
                Err(PilotError::Protocol(message))
                    if protocol::is_recoverable_resume_error(&message) =>
                {
                    tracing::warn!(thread = %spec.thread_id, native = %thread_id, "pilot.codex.resume.fresh");
                    self.request("thread/start", params, INIT_TIMEOUT).await?
                }
                Err(error) => return Err(error),
            }
        } else {
            self.request("thread/start", params, INIT_TIMEOUT).await?
        };

        let native_thread_id = result["thread"]["id"]
            .as_str()
            .ok_or_else(|| PilotError::Protocol("thread open response has no thread.id".into()))?
            .to_string();
        let model = result["model"]
            .as_str()
            .or_else(|| result["thread"]["model"].as_str())
            .map(str::to_string)
            .or_else(|| spec.model.clone());
        {
            let mut state = self.shared.state.lock();
            state.native_thread_id = Some(native_thread_id.clone());
            state.model = model.clone();
        }
        let mut extra = std::collections::BTreeMap::new();
        match self.available_models().await {
            Ok(models) => {
                extra.insert("availableModels".into(), json!(models));
            }
            Err(_) => {
                // Older App Servers may not expose the catalog. Never block opening
                // a valid thread, or log the provider's potentially sensitive error.
                tracing::warn!("pilot.codex.model_catalog.unavailable");
                extra.insert("availableModels".into(), json!(NATIVE_MODELS));
                extra.insert("modelCatalogFallback".into(), json!(true));
            }
        }
        for key in [
            "approvalPolicy",
            "sandbox",
            "modelProvider",
            "reasoningEffort",
        ] {
            if let Some(value) = result.get(key) {
                extra.insert(key.to_string(), value.clone());
            }
        }
        self.shared.sink.emit(PilotEvent::SessionStarted {
            native_session_id: Some(native_thread_id),
            model,
            slash_commands: Vec::new(),
            extra,
        });
        self.shared.settle_status();
        Ok(())
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, PilotError> {
        let request_id = format!("boite_{}", uuid::Uuid::new_v4());
        let pending_key = format!("s:{request_id}");
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_calls
            .lock()
            .insert(pending_key.clone(), tx);
        let frame = json!({ "id": request_id, "method": method, "params": params });
        if let Err(error) = self.child.lock().await.write_line(&frame.to_string()).await {
            self.shared.pending_calls.lock().remove(&pending_key);
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(PilotError::Protocol(message)),
            Ok(Err(_)) => Err(PilotError::SessionGone("Codex App Server exited".into())),
            Err(_) => {
                self.shared.pending_calls.lock().remove(&pending_key);
                Err(PilotError::Timeout)
            }
        }
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), PilotError> {
        let frame = match params {
            Some(params) => json!({ "method": method, "params": params }),
            None => json!({ "method": method }),
        };
        self.child.lock().await.write_line(&frame.to_string()).await
    }

    async fn send_server_response(&self, id: Value, result: Value) -> Result<(), PilotError> {
        let frame = json!({ "id": id, "result": result });
        self.child.lock().await.write_line(&frame.to_string()).await
    }
}

#[async_trait]
impl Session for CodexSession {
    async fn prompt(&self, input: TurnInput) -> Result<TurnId, PilotError> {
        if let Some(turn) = self.steer_if_active(&input).await? {
            return Ok(turn);
        }
        if let Some(selection) = input.selection.clone() {
            self.set_model(selection).await?;
        }
        let turn_id = input
            .turn_id
            .clone()
            .unwrap_or_else(|| format!("turn_{}", uuid::Uuid::new_v4()));
        let (native_thread_id, model, effort, mode) = {
            let mut state = self.shared.state.lock();
            if state.exited {
                return Err(PilotError::SessionGone("Codex App Server exited".into()));
            }
            if state.turn.is_some() || !state.open_requests.is_empty() {
                return Err(PilotError::Protocol(
                    "Codex already has a turn in flight".into(),
                ));
            }
            state.turn = Some(turn_id.clone());
            state.provider_turn = None;
            state.turn_started_ms = now_ms();
            state.interrupting = false;
            (
                state.native_thread_id.clone(),
                state.model.clone(),
                state.effort.clone(),
                state.mode,
            )
        };
        let native_thread_id = native_thread_id
            .ok_or_else(|| PilotError::Protocol("Codex thread was not initialized".into()))?;

        self.shared.sink.emit(PilotEvent::TurnStarted {
            turn_id: turn_id.clone(),
        });
        self.shared.settle_status();
        let params = protocol::turn_params(
            &native_thread_id,
            &input.text,
            model.as_deref(),
            effort.as_deref(),
            mode,
        );
        match self.request("turn/start", params, CONTROL_TIMEOUT).await {
            Ok(result) => {
                if let Some(provider_turn) = result["turn"]["id"].as_str() {
                    let mut state = self.shared.state.lock();
                    if state.turn.as_deref() == Some(&turn_id) {
                        state.provider_turn = Some(provider_turn.to_string());
                    }
                }
                Ok(turn_id)
            }
            Err(error) => {
                let turn = self.shared.state.lock().turn.take();
                if let Some(turn_id) = turn {
                    self.shared.sink.emit(PilotEvent::TurnAborted {
                        turn_id,
                        reason: Some(error.to_string()),
                    });
                }
                self.shared.settle_status();
                Err(error)
            }
        }
    }

    async fn compact(&self, input: TurnInput) -> Result<TurnId, PilotError> {
        let turn_id = input
            .turn_id
            .unwrap_or_else(|| format!("turn_{}", uuid::Uuid::new_v4()));
        let native_thread_id = {
            let mut state = self.shared.state.lock();
            if state.exited {
                return Err(PilotError::SessionGone("Codex App Server exited".into()));
            }
            if state.turn.is_some() || !state.open_requests.is_empty() {
                return Err(PilotError::Protocol(
                    "Codex cannot compact an active turn".into(),
                ));
            }
            state.turn = Some(turn_id.clone());
            state.provider_turn = None;
            state.turn_started_ms = now_ms();
            state.interrupting = false;
            state.native_thread_id.clone()
        }
        .ok_or_else(|| PilotError::Protocol("Codex thread was not initialized".into()))?;
        self.shared.sink.emit(PilotEvent::TurnStarted {
            turn_id: turn_id.clone(),
        });
        self.shared.settle_status();
        match self
            .request(
                "thread/compact/start",
                json!({ "threadId": native_thread_id }),
                CONTROL_TIMEOUT,
            )
            .await
        {
            Ok(_) => Ok(turn_id),
            Err(error) => {
                let turn = self.shared.state.lock().turn.take();
                if let Some(turn_id) = turn {
                    self.shared.sink.emit(PilotEvent::TurnAborted {
                        turn_id,
                        reason: Some(error.to_string()),
                    });
                }
                self.shared.settle_status();
                Err(error)
            }
        }
    }

    async fn interrupt(&self) -> Result<(), PilotError> {
        let (thread_id, provider_turn) = {
            let mut state = self.shared.state.lock();
            state.interrupting = true;
            (state.native_thread_id.clone(), state.provider_turn.clone())
        };
        let (Some(thread_id), Some(turn_id)) = (thread_id, provider_turn) else {
            self.shared.state.lock().interrupting = false;
            return Ok(());
        };
        if let Err(error) = self
            .request(
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
                CONTROL_TIMEOUT,
            )
            .await
        {
            self.shared.state.lock().interrupting = false;
            return Err(error);
        }
        let turn = self.shared.state.lock().turn.take();
        if let Some(turn_id) = turn {
            self.shared.sink.emit(PilotEvent::TurnAborted {
                turn_id,
                reason: Some("interrupted".into()),
            });
        }
        self.shared.settle_status();
        Ok(())
    }

    async fn respond(&self, request_id: &str, answer: RequestAnswer) -> Result<(), PilotError> {
        let pending = self
            .shared
            .state
            .lock()
            .open_requests
            .get(request_id)
            .cloned()
            .ok_or_else(|| PilotError::NoRequest(request_id.to_string()))?;
        let (allowed, for_session, selected, structured) = match answer {
            RequestAnswer::Allow {
                for_session,
                selected,
                ..
            } => (true, for_session, selected, None),
            RequestAnswer::Deny { .. } => (false, false, None, None),
            RequestAnswer::Answers { answers } => (true, false, None, Some(answers)),
        };
        let result = match pending.kind {
            PendingKind::Approval(wire) => {
                if structured.is_some() {
                    return Err(PilotError::Protocol(
                        "structured answers cannot resolve an approval".into(),
                    ));
                }
                let decision = match wire {
                    ApprovalWire::Command | ApprovalWire::FileChange => {
                        if !allowed {
                            "decline"
                        } else if for_session {
                            "acceptForSession"
                        } else {
                            "accept"
                        }
                    }
                    ApprovalWire::LegacyCommand | ApprovalWire::LegacyPatch => {
                        if !allowed {
                            "denied"
                        } else if for_session {
                            "approved_for_session"
                        } else {
                            "approved"
                        }
                    }
                };
                json!({ "decision": decision })
            }
            PendingKind::UserInput { question_ids } => {
                let answers = structured.unwrap_or_else(|| {
                    let answer = selected.unwrap_or_default();
                    question_ids
                        .into_iter()
                        .map(|id| {
                            let values = if allowed && !answer.is_empty() {
                                vec![answer.clone()]
                            } else {
                                Vec::new()
                            };
                            (id, values)
                        })
                        .collect()
                });
                let answers = answers
                    .into_iter()
                    .map(|(id, values)| (id, json!({ "answers": values })))
                    .collect::<serde_json::Map<String, Value>>();
                json!({ "answers": answers })
            }
        };
        self.send_server_response(pending.rpc_id, result).await?;
        self.shared.state.lock().open_requests.remove(request_id);
        self.shared.sink.emit(PilotEvent::RequestResolved {
            request_id: request_id.to_string(),
            outcome: if allowed {
                RequestOutcome::Allowed
            } else {
                RequestOutcome::Denied
            },
        });
        self.shared.settle_status();
        Ok(())
    }

    async fn set_model(&self, selection: ModelSelection) -> Result<SwitchKind, PilotError> {
        if selection.instance.is_some() {
            return Ok(SwitchKind::Restart);
        }
        if let Some(model) = selection.model {
            self.shared.state.lock().model = Some(model.clone());
            self.shared.sink.emit(PilotEvent::ModelChanged { model });
        }
        Ok(SwitchKind::InSession)
    }

    async fn set_mode(&self, mode: ExecMode) -> Result<(), PilotError> {
        self.shared.state.lock().mode = mode;
        Ok(())
    }

    async fn stop(&self) -> Result<(), PilotError> {
        self.shared.state.lock().stopping = true;
        self.child.lock().await.stop().await;
        Ok(())
    }

    fn native_session_id(&self) -> Option<String> {
        self.shared.state.lock().native_thread_id.clone()
    }

    fn model(&self) -> Option<String> {
        self.shared.state.lock().model.clone()
    }

    fn status(&self) -> Status {
        self.shared.state.lock().status
    }

    fn pid(&self) -> Option<u32> {
        self.pid
    }
}

async fn read_loop(
    shared: Arc<Shared>,
    child: Arc<AsyncMutex<Child>>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Line>,
) {
    let mut stderr_tail = Vec::new();
    while let Some(line) = rx.recv().await {
        match line {
            Line::Out(text) => {
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    tracing::debug!(line = %protocol::truncate(&text), "pilot.codex.unparsed");
                    continue;
                };
                if value.get("method").is_some() {
                    if let Some(response) = reduce::handle_server_message(&shared, &value) {
                        if let Err(error) =
                            child.lock().await.write_line(&response.to_string()).await
                        {
                            shared.sink.emit(PilotEvent::Error {
                                message: error.to_string(),
                                turn_id: shared.state.lock().turn.clone(),
                            });
                        }
                    }
                } else if let Some(id) = value.get("id").and_then(protocol::id_key) {
                    if let Some(tx) = shared.pending_calls.lock().remove(&id) {
                        let answer = if let Some(error) = value.get("error") {
                            Err(reduce::rpc_error(error))
                        } else {
                            Ok(value.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = tx.send(answer);
                    }
                }
            }
            Line::Err(text) => {
                tracing::debug!(line = %protocol::truncate(&text), "pilot.codex.stderr");
                if stderr_tail.len() == 8 {
                    stderr_tail.remove(0);
                }
                stderr_tail.push(text);
            }
            Line::Eof => break,
        }
    }
    finish(&shared, &mut *child.lock().await, stderr_tail);
}

fn finish(shared: &Arc<Shared>, child: &mut Child, stderr_tail: Vec<String>) {
    let (turn, requests, stopping, already, code) = {
        let mut state = shared.state.lock();
        let already = state.exited;
        state.exited = true;
        (
            state.turn.take(),
            std::mem::take(&mut state.open_requests),
            state.stopping,
            already,
            child.exit_code(),
        )
    };
    if already {
        return;
    }
    let failure = if stderr_tail.is_empty() {
        "Codex App Server exited".to_string()
    } else {
        stderr_tail.join("; ")
    };
    for (_, tx) in shared.pending_calls.lock().drain() {
        let _ = tx.send(Err(failure.clone()));
    }
    for request_id in requests.keys() {
        shared.sink.emit(PilotEvent::RequestResolved {
            request_id: request_id.clone(),
            outcome: RequestOutcome::Cancelled,
        });
    }
    if let Some(turn_id) = turn {
        shared.sink.emit(PilotEvent::TurnAborted {
            turn_id,
            reason: Some(failure),
        });
    }
    shared.set_status(Status::Idle);
    let reason = if stopping {
        ExitReason::Stopped
    } else {
        ExitReason::Crashed { code }
    };
    shared.sink.emit(PilotEvent::SessionExited { reason });
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
