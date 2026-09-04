//! Agent Client Protocol driver shared by Cursor, Grok and Antigravity.
//!
//! T3 Code keeps provider particulars at the launch/auth boundary and runs one
//! ACP process per conversation. Boite follows that split: this module owns the
//! JSON-RPC transport and canonical state, while `protocol` contains the three
//! small provider mappings.

mod protocol;
mod reduce;

use std::collections::HashMap;
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
use crate::event::{ExitReason, ItemKind, PilotEvent, RequestOutcome, Status, Usage};
use crate::proc::{Child, Line};

pub use protocol::Flavor;

const INIT_TIMEOUT: Duration = Duration::from_secs(60);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
type CallReceiver = oneshot::Receiver<Result<Value, String>>;

pub struct AcpDriver {
    flavor: Flavor,
}

impl AcpDriver {
    pub const fn cursor() -> Self {
        Self {
            flavor: Flavor::Cursor,
        }
    }

    pub const fn grok() -> Self {
        Self {
            flavor: Flavor::Grok,
        }
    }

    pub const fn antigravity() -> Self {
        Self {
            flavor: Flavor::Antigravity,
        }
    }
}

#[async_trait]
impl Driver for AcpDriver {
    fn id(&self) -> &'static str {
        self.flavor.id()
    }

    fn capabilities(&self) -> Capabilities {
        let modes = match self.flavor {
            Flavor::Cursor => vec![ExecMode::Ask, ExecMode::Yolo],
            Flavor::Grok | Flavor::Antigravity => {
                vec![ExecMode::Ask, ExecMode::EditAlone, ExecMode::Yolo]
            }
        };
        Capabilities {
            model_switch: SwitchKind::InSession,
            rollback: false,
            modes,
            interrupt: true,
        }
    }

    async fn open(
        &self,
        spec: OpenSpec,
        sink: SessionSink,
    ) -> Result<Box<dyn Session>, PilotError> {
        Ok(Box::new(AcpSession::open(self.flavor, spec, sink).await?))
    }
}

#[derive(Debug, Clone)]
pub(super) struct NativePermission {
    pub option_id: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub(super) enum PendingKind {
    Permission { options: Vec<NativePermission> },
    Elicitation,
}

#[derive(Debug, Clone)]
pub(super) struct PendingRequest {
    pub rpc_id: Value,
    pub kind: PendingKind,
}

#[derive(Debug, Clone)]
pub(super) struct StreamItem {
    pub id: String,
    pub kind: ItemKind,
    pub text: String,
}

#[derive(Debug, Clone)]
pub(super) struct ToolItem {
    pub raw: Value,
    pub kind: ItemKind,
}

pub(super) struct State {
    pub status: Status,
    pub native_session_id: Option<String>,
    pub model: Option<String>,
    pub default_model: Option<String>,
    pub model_config_id: Option<String>,
    pub system_prompt_append: Option<String>,
    pub mode: ExecMode,
    pub current_mode_id: Option<String>,
    pub available_mode_ids: Vec<String>,
    pub available_models: Vec<String>,
    pub turn: Option<String>,
    pub turn_started_ms: u64,
    pub usage: Usage,
    pub assistant: Option<StreamItem>,
    pub reasoning: Option<StreamItem>,
    pub tools: HashMap<String, ToolItem>,
    pub plan_seq: u64,
    pub slash_commands: Vec<String>,
    pub loading_replay: bool,
    pub open_requests: HashMap<String, PendingRequest>,
    pub stopping: bool,
    pub exited: bool,
}

impl Default for State {
    fn default() -> Self {
        Self {
            status: Status::Idle,
            native_session_id: None,
            model: None,
            default_model: None,
            model_config_id: None,
            system_prompt_append: None,
            mode: ExecMode::Ask,
            current_mode_id: None,
            available_mode_ids: Vec::new(),
            available_models: Vec::new(),
            turn: None,
            turn_started_ms: 0,
            usage: Usage::default(),
            assistant: None,
            reasoning: None,
            tools: HashMap::new(),
            plan_seq: 0,
            slash_commands: Vec::new(),
            loading_replay: false,
            open_requests: HashMap::new(),
            stopping: false,
            exited: false,
        }
    }
}

pub(super) struct Shared {
    pub sink: SessionSink,
    pub flavor: Flavor,
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

pub struct AcpSession {
    shared: Arc<Shared>,
    child: Arc<AsyncMutex<Child>>,
    pid: Option<u32>,
}

impl AcpSession {
    async fn open(flavor: Flavor, spec: OpenSpec, sink: SessionSink) -> Result<Self, PilotError> {
        let argv = protocol::argv(flavor, &spec);
        let env = protocol::env(flavor, &spec);
        tracing::info!(thread = %spec.thread_id, driver = flavor.id(), argv = ?argv, "pilot.acp.open");
        let (child, rx) = Child::spawn(&argv, &spec.cwd, &env)?;
        let pid = child.pid();
        let child = Arc::new(AsyncMutex::new(child));
        let shared = Arc::new(Shared {
            sink,
            flavor,
            state: Mutex::new(State {
                model: spec.model.clone(),
                default_model: None,
                system_prompt_append: spec.system_prompt_append.clone(),
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
        let initialized = self
            .request("initialize", protocol::initialize_params(), INIT_TIMEOUT)
            .await?;
        let auth_method = self.shared.flavor.auth_method(protocol::has_xai_key(spec));
        self.request(
            "authenticate",
            json!({ "methodId": auth_method }),
            INIT_TIMEOUT,
        )
        .await?;

        let mut params = protocol::session_params(spec);
        let result = if let Some(session_id) = &spec.resume {
            params["sessionId"] = Value::String(session_id.clone());
            self.shared.state.lock().loading_replay = true;
            let loaded = self
                .request(self.shared.flavor.resume_method(), params, INIT_TIMEOUT)
                .await;
            self.shared.state.lock().loading_replay = false;
            loaded?
        } else {
            self.request("session/new", params, INIT_TIMEOUT).await?
        };
        let native_session_id = spec
            .resume
            .clone()
            .or_else(|| result["sessionId"].as_str().map(str::to_string))
            .ok_or_else(|| PilotError::Protocol("ACP session response has no sessionId".into()))?;

        reduce::apply_session_setup(&self.shared, &result, &native_session_id);
        if let Some(model) = spec.model.as_deref() {
            self.set_model_native(model, spec.options.effort.as_deref(), false)
                .await?;
        }
        if self.shared.flavor == Flavor::Antigravity {
            self.set_mode_native(spec.options.mode).await?;
        }

        let (model, slash_commands, available_models) = {
            let state = self.shared.state.lock();
            (
                state.model.clone(),
                state.slash_commands.clone(),
                state.available_models.clone(),
            )
        };
        let mut extra = std::collections::BTreeMap::new();
        for key in ["agentInfo", "agentCapabilities", "protocolVersion"] {
            if let Some(value) = initialized.get(key) {
                extra.insert(key.to_string(), value.clone());
            }
        }
        extra.insert("availableModels".into(), json!(available_models));
        self.shared.sink.emit(PilotEvent::SessionStarted {
            native_session_id: Some(native_session_id),
            model,
            slash_commands,
            extra,
        });
        self.shared.settle_status();
        Ok(())
    }

    async fn dispatch(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(String, CallReceiver), PilotError> {
        let request_id = format!("boite_{}", uuid::Uuid::new_v4());
        let pending_key = format!("s:{request_id}");
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending_calls
            .lock()
            .insert(pending_key.clone(), tx);
        let frame = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.child.lock().await.write_line(&frame.to_string()).await {
            self.shared.pending_calls.lock().remove(&pending_key);
            return Err(error);
        }
        Ok((pending_key, rx))
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, PilotError> {
        let (pending_key, rx) = self.dispatch(method, params).await?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(PilotError::Protocol(message)),
            Ok(Err(_)) => Err(PilotError::SessionGone("ACP process exited".into())),
            Err(_) => {
                self.shared.pending_calls.lock().remove(&pending_key);
                Err(PilotError::Timeout)
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), PilotError> {
        let frame = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.child.lock().await.write_line(&frame.to_string()).await
    }

    async fn send_server_response(&self, id: Value, result: Value) -> Result<(), PilotError> {
        let frame = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        self.child.lock().await.write_line(&frame.to_string()).await
    }

    async fn set_model_native(
        &self,
        model: &str,
        effort: Option<&str>,
        emit: bool,
    ) -> Result<(), PilotError> {
        let session_id = self
            .native_session_id()
            .ok_or_else(|| PilotError::Protocol("ACP session was not initialized".into()))?;
        let result = if self.shared.flavor.uses_session_model() {
            let mut params = json!({ "sessionId": session_id, "modelId": model });
            if let Some(effort) = effort.filter(|value| !value.trim().is_empty()) {
                params["_meta"] = json!({ "reasoningEffort": effort });
            }
            self.request("session/set_model", params, CONTROL_TIMEOUT)
                .await?
        } else {
            let config_id = self
                .shared
                .state
                .lock()
                .model_config_id
                .clone()
                .unwrap_or_else(|| "model".into());
            self.request(
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": model }),
                CONTROL_TIMEOUT,
            )
            .await?
        };
        if emit {
            reduce::set_model(&self.shared, model);
        }
        reduce::apply_config_options(&self.shared, &result);
        self.shared.state.lock().model = Some(model.to_string());
        Ok(())
    }

    async fn set_mode_native(&self, mode: ExecMode) -> Result<(), PilotError> {
        let session_id = self
            .native_session_id()
            .ok_or_else(|| PilotError::Protocol("ACP session was not initialized".into()))?;
        let mode_id = reduce::resolve_mode_id(&self.shared, mode);
        let result = self
            .request(
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": "mode", "value": mode_id }),
                CONTROL_TIMEOUT,
            )
            .await?;
        reduce::apply_config_options(&self.shared, &result);
        let mut state = self.shared.state.lock();
        state.mode = mode;
        state.current_mode_id = Some(mode_id);
        Ok(())
    }
}

#[async_trait]
impl Session for AcpSession {
    async fn prompt(&self, input: TurnInput) -> Result<TurnId, PilotError> {
        if let Some(selection) = input.selection.clone() {
            self.set_model(selection).await?;
        }
        let turn_id = input
            .turn_id
            .unwrap_or_else(|| format!("turn_{}", uuid::Uuid::new_v4()));
        let (session_id, prompt_text) = {
            let mut state = self.shared.state.lock();
            if state.exited {
                return Err(PilotError::SessionGone("ACP process exited".into()));
            }
            if state.turn.is_some() {
                return Err(PilotError::Protocol(
                    "an ACP turn is already running".into(),
                ));
            }
            state.turn = Some(turn_id.clone());
            state.turn_started_ms = now_ms();
            state.usage = Usage {
                context_window: state.usage.context_window,
                ..Usage::default()
            };
            let text = match state.system_prompt_append.take() {
                Some(instructions) if !instructions.trim().is_empty() => {
                    format!("{instructions}\n\n{}", input.text)
                }
                _ => input.text,
            };
            (state.native_session_id.clone(), text)
        };
        let session_id = session_id
            .ok_or_else(|| PilotError::Protocol("ACP session was not initialized".into()))?;

        self.shared.sink.emit(PilotEvent::TurnStarted {
            turn_id: turn_id.clone(),
        });
        self.shared.settle_status();
        let (_, rx) = match self
            .dispatch(
                "session/prompt",
                protocol::prompt_params(&session_id, &prompt_text),
            )
            .await
        {
            Ok(rx) => rx,
            Err(error) => {
                reduce::abort_turn(&self.shared, error.to_string());
                return Err(error);
            }
        };
        let shared = Arc::clone(&self.shared);
        tokio::spawn(async move {
            match rx.await {
                Ok(Ok(result)) => reduce::complete_prompt(&shared, &result),
                Ok(Err(message)) => reduce::abort_turn(&shared, message),
                Err(_) => reduce::abort_turn(&shared, "ACP process exited".into()),
            }
        });
        Ok(turn_id)
    }

    async fn interrupt(&self) -> Result<(), PilotError> {
        let session_id = match self.native_session_id() {
            Some(session_id) => session_id,
            None => return Ok(()),
        };
        let requests = {
            let mut state = self.shared.state.lock();
            std::mem::take(&mut state.open_requests)
        };
        for (request_id, pending) in requests {
            let result = match pending.kind {
                PendingKind::Permission { .. } => {
                    json!({ "outcome": { "outcome": "cancelled" } })
                }
                PendingKind::Elicitation => json!({ "action": { "action": "cancel" } }),
            };
            self.send_server_response(pending.rpc_id, result).await?;
            self.shared.sink.emit(PilotEvent::RequestResolved {
                request_id,
                outcome: RequestOutcome::Cancelled,
            });
        }
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await?;
        reduce::abort_turn(&self.shared, "interrupted".into());
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
        let (result, outcome) = match (&pending.kind, answer) {
            (PendingKind::Permission { .. }, RequestAnswer::Answers { .. }) => {
                return Err(PilotError::Protocol(
                    "structured answers cannot resolve an ACP permission".into(),
                ));
            }
            (
                PendingKind::Permission { options },
                RequestAnswer::Allow {
                    for_session,
                    selected,
                    ..
                },
            ) => permission_answer(options, selected.as_deref(), for_session, true),
            (PendingKind::Permission { options }, RequestAnswer::Deny { .. }) => {
                permission_answer(options, None, false, false)
            }
            (PendingKind::Elicitation, RequestAnswer::Answers { answers }) => {
                let content = answers
                    .into_iter()
                    .map(|(id, values)| {
                        let value = if values.len() == 1 {
                            Value::String(values.into_iter().next().unwrap_or_default())
                        } else {
                            json!(values)
                        };
                        (id, value)
                    })
                    .collect::<serde_json::Map<_, _>>();
                (
                    json!({ "action": { "action": "accept", "content": content } }),
                    RequestOutcome::Allowed,
                )
            }
            (PendingKind::Elicitation, RequestAnswer::Allow { selected, .. }) => {
                let content = selected.map(|value| json!({ "answer": value }));
                (
                    json!({ "action": { "action": "accept", "content": content } }),
                    RequestOutcome::Allowed,
                )
            }
            (PendingKind::Elicitation, RequestAnswer::Deny { .. }) => (
                json!({ "action": { "action": "decline" } }),
                RequestOutcome::Denied,
            ),
        };
        self.send_server_response(pending.rpc_id, result).await?;
        self.shared.state.lock().open_requests.remove(request_id);
        self.shared.sink.emit(PilotEvent::RequestResolved {
            request_id: request_id.to_string(),
            outcome,
        });
        self.shared.settle_status();
        Ok(())
    }

    async fn set_model(&self, selection: ModelSelection) -> Result<SwitchKind, PilotError> {
        if selection.instance.is_some() {
            return Ok(SwitchKind::Restart);
        }
        let model = selection
            .model
            .or_else(|| self.shared.state.lock().default_model.clone());
        let Some(model) = model else {
            return Ok(SwitchKind::Unsupported);
        };
        self.set_model_native(&model, None, true).await?;
        Ok(SwitchKind::InSession)
    }

    async fn set_mode(&self, mode: ExecMode) -> Result<(), PilotError> {
        if self.shared.flavor == Flavor::Cursor && mode == ExecMode::EditAlone {
            return Err(PilotError::Unsupported("Cursor ACP edits-only mode".into()));
        }
        self.set_mode_native(mode).await
    }

    async fn stop(&self) -> Result<(), PilotError> {
        self.shared.state.lock().stopping = true;
        self.child.lock().await.stop().await;
        Ok(())
    }

    fn native_session_id(&self) -> Option<String> {
        self.shared.state.lock().native_session_id.clone()
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

fn permission_answer(
    options: &[NativePermission],
    selected: Option<&str>,
    for_session: bool,
    allow: bool,
) -> (Value, RequestOutcome) {
    let chosen = selected
        .and_then(|id| options.iter().find(|option| option.option_id == id))
        .or_else(|| {
            let wanted = if allow {
                if for_session {
                    "allow_always"
                } else {
                    "allow_once"
                }
            } else {
                "reject_once"
            };
            options.iter().find(|option| option.kind == wanted)
        })
        .or_else(|| {
            options.iter().find(|option| {
                if allow {
                    option.kind.starts_with("allow")
                } else {
                    option.kind.starts_with("reject")
                }
            })
        });
    let Some(chosen) = chosen else {
        return (
            json!({ "outcome": { "outcome": "cancelled" } }),
            RequestOutcome::Cancelled,
        );
    };
    let outcome = if chosen.kind.starts_with("allow") {
        RequestOutcome::Allowed
    } else {
        RequestOutcome::Denied
    };
    (
        json!({ "outcome": { "outcome": "selected", "optionId": chosen.option_id } }),
        outcome,
    )
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
                    tracing::debug!(line = %protocol::truncate(&text), "pilot.acp.unparsed");
                    continue;
                };
                if value.get("method").is_some() {
                    if let Some(response) = reduce::handle_agent_message(&shared, &value) {
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
                        let result = if let Some(error) = value.get("error") {
                            Err(protocol::rpc_error(error))
                        } else {
                            Ok(value.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = tx.send(result);
                    }
                }
            }
            Line::Err(text) => {
                tracing::debug!(line = %protocol::truncate(&text), "pilot.acp.stderr");
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
        "ACP process exited".to_string()
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
    shared.sink.emit(PilotEvent::SessionExited {
        reason: if stopping {
            ExitReason::Stopped
        } else {
            ExitReason::Crashed { code }
        },
    });
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
