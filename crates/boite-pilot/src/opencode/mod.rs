//! OpenCode driver using the same local HTTP/SSE SDK boundary as T3 Code.

mod protocol;
mod reduce;
mod sse;
mod stream;
mod transport;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use parking_lot::Mutex;
use reqwest::Method;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::task::JoinHandle;

use crate::driver::{
    Capabilities, Driver, ExecMode, ModelSelection, OpenSpec, PilotError, RequestAnswer, Session,
    SessionSink, SwitchKind, TurnId, TurnInput,
};
use crate::event::{ExitReason, Item, ItemKind, PilotEvent, RequestOutcome, Status, Usage};
use crate::proc::{Child, Line};
use stream::event_loop;
use transport::Api;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct OpenCodeDriver;

#[async_trait]
impl Driver for OpenCodeDriver {
    fn id(&self) -> &'static str {
        "opencode"
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
        Ok(Box::new(OpenCodeSession::open(spec, sink).await?))
    }
}

#[derive(Debug, Clone)]
pub(super) enum PendingRequest {
    Permission,
    Question { question_ids: Vec<String> },
}

#[derive(Debug, Clone)]
pub(super) struct StreamPart {
    pub id: String,
    pub message_id: String,
    pub kind: ItemKind,
    pub text: String,
    pub completed: bool,
}

pub(super) struct State {
    status: Status,
    native_session_id: Option<String>,
    model: Option<String>,
    mode: ExecMode,
    system_prompt_append: Option<String>,
    turn: Option<String>,
    turn_started_ms: u64,
    turn_saw_busy: bool,
    interrupting: bool,
    deferred_idle: bool,
    compacting: bool,
    usage: Usage,
    related_session_ids: HashSet<String>,
    message_roles: HashMap<String, String>,
    parts: HashMap<String, StreamPart>,
    emitted_text: HashMap<String, String>,
    open_items: HashSet<String>,
    completed_items: HashSet<String>,
    open_requests: HashMap<String, PendingRequest>,
    plan_seq: u64,
    stopping: bool,
    exited: bool,
}

impl Default for State {
    fn default() -> Self {
        Self {
            status: Status::Idle,
            native_session_id: None,
            model: None,
            mode: ExecMode::Ask,
            system_prompt_append: None,
            turn: None,
            turn_started_ms: 0,
            turn_saw_busy: false,
            interrupting: false,
            deferred_idle: false,
            compacting: false,
            usage: Usage::default(),
            related_session_ids: HashSet::new(),
            message_roles: HashMap::new(),
            parts: HashMap::new(),
            emitted_text: HashMap::new(),
            open_items: HashSet::new(),
            completed_items: HashSet::new(),
            open_requests: HashMap::new(),
            plan_seq: 0,
            stopping: false,
            exited: false,
        }
    }
}

pub(super) struct Shared {
    sink: SessionSink,
    state: Mutex<State>,
}

impl Shared {
    fn set_status(&self, status: Status) {
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

    fn settle_status(&self) {
        let status = {
            let state = self.state.lock();
            if !state.open_requests.is_empty() {
                Status::Waiting
            } else if state.turn.is_some() || state.compacting {
                Status::Busy
            } else {
                Status::Idle
            }
        };
        self.set_status(status);
    }

    fn exit(&self, reason: ExitReason) {
        let (turn, requests, emit) = {
            let mut state = self.state.lock();
            if state.exited {
                return;
            }
            state.exited = true;
            state.compacting = false;
            let turn = state.turn.take();
            let requests = state
                .open_requests
                .drain()
                .map(|(id, _)| id)
                .collect::<Vec<_>>();
            (turn, requests, true)
        };
        if let Some(turn_id) = turn {
            self.sink.emit(PilotEvent::TurnAborted {
                turn_id,
                reason: Some("OpenCode session exited".into()),
            });
        }
        for request_id in requests {
            self.sink.emit(PilotEvent::RequestResolved {
                request_id,
                outcome: RequestOutcome::Cancelled,
            });
        }
        if emit {
            self.settle_status();
            self.sink.emit(PilotEvent::SessionExited { reason });
        }
    }
}

pub struct OpenCodeSession {
    shared: Arc<Shared>,
    api: Api,
    child: Option<Arc<AsyncMutex<Child>>>,
    event_task: AsyncMutex<Option<JoinHandle<()>>>,
    pid: Option<u32>,
}

impl Drop for OpenCodeSession {
    fn drop(&mut self) {
        self.shared.state.lock().stopping = true;
        if let Some(task) = self.event_task.get_mut().take() {
            task.abort();
        }
        // The output reader holds only a Weak reference, so Child::drop also
        // terminates the owned server when callers forget to stop explicitly.
    }
}

impl OpenCodeSession {
    async fn open(spec: OpenSpec, sink: SessionSink) -> Result<Self, PilotError> {
        let shared = Arc::new(Shared {
            sink,
            state: Mutex::new(State {
                model: protocol::instance_model(&spec),
                mode: spec.options.mode,
                system_prompt_append: spec.system_prompt_append.clone(),
                ..State::default()
            }),
        });

        let external_url = protocol::server_url(&spec);
        let (url, child, rx, pid) = match external_url {
            Some(url) => (url, None, None, None),
            None => {
                let port = transport::reserve_port()?;
                let argv = protocol::server_argv(&spec, port);
                tracing::info!(thread = %spec.thread_id, driver = "opencode", argv = ?argv, "pilot.opencode.open");
                let (child, mut rx) = Child::spawn(&argv, &spec.cwd, &protocol::server_env(&spec))?;
                let pid = child.pid();
                let url = transport::wait_for_ready(&mut rx).await;
                let child = Arc::new(AsyncMutex::new(child));
                match url {
                    Ok(url) => (url, Some(child), Some(rx), pid),
                    Err(error) => {
                        child.lock().await.stop().await;
                        return Err(error);
                    }
                }
            }
        };
        let password = protocol::server_password(&spec, child.is_none());
        let api = Api::new(url, &spec.cwd, password)?;
        let server_version = transport::verify_health(&api).await?;

        for server in &spec.mcp_servers {
            api.json(
                Method::POST,
                "/mcp",
                Some(protocol::mcp_body(server, &spec.cwd)),
            )
            .await?;
        }

        let provider_list = api.json(Method::GET, "/provider", None).await?;
        let available_models = protocol::available_models(&provider_list);
        if shared.state.lock().model.is_none() {
            shared.state.lock().model = protocol::default_model(&provider_list, &available_models);
        }
        if let Some(model) = shared.state.lock().model.as_deref() {
            if protocol::parse_model(model).is_none() {
                return Err(PilotError::Protocol(
                    "OpenCode models must use provider/model".into(),
                ));
            }
        }

        let session = transport::adopt_or_create(&api, &spec, spec.options.mode).await?;
        let native_session_id = session["id"]
            .as_str()
            .ok_or_else(|| {
                PilotError::Protocol("OpenCode returned a session without an id".into())
            })?
            .to_string();
        shared.state.lock().native_session_id = Some(native_session_id.clone());
        shared
            .state
            .lock()
            .related_session_ids
            .insert(native_session_id.clone());

        if let (Some(child), Some(rx)) = (&child, rx) {
            tokio::spawn(process_loop(Arc::clone(&shared), Arc::downgrade(child), rx));
        }
        let (connected_tx, connected_rx) = oneshot::channel();
        let event_task = tokio::spawn(event_loop(
            api.clone(),
            Arc::clone(&shared),
            connected_tx,
            child.as_ref().map(Arc::downgrade),
        ));
        if !matches!(
            tokio::time::timeout(CONNECT_TIMEOUT, connected_rx).await,
            Ok(Ok(()))
        ) {
            event_task.abort();
            if let Some(child) = &child {
                child.lock().await.stop().await;
            }
            return Err(PilotError::Protocol(
                "OpenCode event stream did not connect in time".into(),
            ));
        }
        let model = shared.state.lock().model.clone();
        let extra = BTreeMap::from([
            ("availableModels".into(), json!(available_models)),
            ("serverVersion".into(), json!(server_version)),
        ]);
        shared.sink.emit(PilotEvent::SessionStarted {
            native_session_id: Some(native_session_id),
            model,
            slash_commands: vec!["compact".into()],
            extra,
        });
        if let Err(error) = recover_pending_requests(&api, &shared).await {
            shared.state.lock().stopping = true;
            event_task.abort();
            if let Some(child) = &child {
                child.lock().await.stop().await;
            }
            shared.exit(ExitReason::Crashed { code: None });
            return Err(error);
        }
        Ok(Self {
            shared,
            api,
            child,
            event_task: AsyncMutex::new(Some(event_task)),
            pid,
        })
    }

    fn session_id(&self) -> Result<String, PilotError> {
        if self.shared.state.lock().exited {
            return Err(PilotError::SessionGone("opencode".into()));
        }
        self.native_session_id()
            .ok_or_else(|| PilotError::SessionGone("opencode".into()))
    }

    async fn fail_turn(&self, turn_id: &str, error: &PilotError) {
        let removed = {
            let mut state = self.shared.state.lock();
            if state.turn.as_deref() == Some(turn_id) {
                state.turn = None;
                true
            } else {
                false
            }
        };
        if removed {
            self.shared.sink.emit(PilotEvent::Error {
                message: error.to_string(),
                turn_id: Some(turn_id.to_string()),
            });
            self.shared.sink.emit(PilotEvent::TurnAborted {
                turn_id: turn_id.to_string(),
                reason: Some(error.to_string()),
            });
            self.shared.settle_status();
        }
    }
}

#[async_trait]
impl Session for OpenCodeSession {
    async fn prompt(&self, input: TurnInput) -> Result<TurnId, PilotError> {
        if let Some(selection) = input.selection.clone() {
            self.set_model(selection).await?;
        }
        let session_id = self.session_id()?;
        let model = self
            .model()
            .ok_or_else(|| PilotError::Protocol("OpenCode has no connected model".into()))?;
        let (provider_id, model_id) = protocol::parse_model(&model).ok_or_else(|| {
            PilotError::Protocol("OpenCode models must use provider/model".into())
        })?;
        let turn_id = input
            .turn_id
            .unwrap_or_else(|| format!("turn_{}", uuid::Uuid::new_v4()));
        let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        let system = self.shared.state.lock().system_prompt_append.clone();
        {
            let mut state = self.shared.state.lock();
            if state.turn.is_some() || state.compacting || !state.open_requests.is_empty() {
                return Err(PilotError::Protocol(
                    "OpenCode already has a turn in flight".into(),
                ));
            }
            state.turn = Some(turn_id.clone());
            state.turn_started_ms = now_ms();
            state.turn_saw_busy = false;
            state.deferred_idle = false;
            state.usage = Usage::default();
            state.message_roles.clear();
            state.parts.clear();
            state.emitted_text.clear();
            state.open_items.clear();
            state.completed_items.clear();
        }
        self.shared.set_status(Status::Busy);
        self.shared.sink.emit(PilotEvent::TurnStarted {
            turn_id: turn_id.clone(),
        });
        let mut body = json!({
            "messageID": message_id,
            "model": { "providerID": provider_id, "modelID": model_id },
            "parts": [{ "type": "text", "text": input.text }]
        });
        if let Some(system) = system.filter(|text| !text.trim().is_empty()) {
            body["system"] = Value::String(system);
        }
        let result = self
            .api
            .json(
                Method::POST,
                &format!("/session/{session_id}/prompt_async"),
                Some(body),
            )
            .await;
        if let Err(error) = &result {
            self.fail_turn(&turn_id, error).await;
        }
        result.map(|_| turn_id)
    }

    async fn compact(&self, input: TurnInput) -> Result<TurnId, PilotError> {
        let session_id = self.session_id()?;
        let model = self
            .model()
            .ok_or_else(|| PilotError::Protocol("OpenCode compaction needs a model".into()))?;
        let (provider_id, model_id) = protocol::parse_model(&model).ok_or_else(|| {
            PilotError::Protocol("OpenCode models must use provider/model".into())
        })?;
        let turn_id = input
            .turn_id
            .unwrap_or_else(|| format!("turn_{}", uuid::Uuid::new_v4()));
        let started = now_ms();
        {
            let mut state = self.shared.state.lock();
            if state.turn.is_some() || state.compacting || !state.open_requests.is_empty() {
                return Err(PilotError::Protocol(
                    "OpenCode is busy or waiting for an answer".into(),
                ));
            }
            state.compacting = true;
            state.turn = Some(turn_id.clone());
            state.turn_started_ms = started;
        }
        self.shared.set_status(Status::Busy);
        self.shared.sink.emit(PilotEvent::TurnStarted {
            turn_id: turn_id.clone(),
        });
        let result = self
            .api
            .json_with_timeout(
                Method::POST,
                &format!("/session/{session_id}/summarize"),
                Some(json!({ "providerID": provider_id, "modelID": model_id, "auto": false })),
                Duration::from_secs(600),
            )
            .await;
        self.shared.state.lock().compacting = false;
        let owns_turn = {
            let mut state = self.shared.state.lock();
            if state.turn.as_deref() == Some(&turn_id) {
                state.turn = None;
                true
            } else {
                false
            }
        };
        if !owns_turn {
            self.shared.settle_status();
            return result.map(|_| turn_id);
        }
        match result {
            Ok(_) => {
                let item_id = format!("opencode-compact-{}", uuid::Uuid::new_v4());
                self.shared.sink.emit(PilotEvent::ItemStarted {
                    item: Item::new(item_id.clone(), ItemKind::Notice, Some(turn_id.clone())),
                });
                self.shared.sink.emit(PilotEvent::ItemCompleted {
                    item: Item::new(item_id, ItemKind::Notice, Some(turn_id.clone())).with_body(
                        json!({ "text": "OpenCode compacted the conversation context" }),
                    ),
                });
                self.shared.sink.emit(PilotEvent::TurnCompleted {
                    turn_id: turn_id.clone(),
                    duration_ms: now_ms().saturating_sub(started),
                    usage: Usage::default(),
                });
                self.shared.settle_status();
                Ok(turn_id)
            }
            Err(error) => {
                self.shared.sink.emit(PilotEvent::TurnAborted {
                    turn_id,
                    reason: Some(error.to_string()),
                });
                self.shared.settle_status();
                Err(error)
            }
        }
    }

    async fn interrupt(&self) -> Result<(), PilotError> {
        let session_id = self.session_id()?;
        {
            let mut state = self.shared.state.lock();
            if state.interrupting {
                return Err(PilotError::Protocol(
                    "OpenCode interruption is already in progress".into(),
                ));
            }
            state.interrupting = true;
        }
        let result = self
            .api
            .json(Method::POST, &format!("/session/{session_id}/abort"), None)
            .await;
        if let Err(error) = result {
            self.shared.state.lock().interrupting = false;
            if self.shared.state.lock().deferred_idle {
                reduce::complete_turn(&self.shared);
            }
            return Err(error);
        }
        let (turn, requests) = {
            let mut state = self.shared.state.lock();
            state.interrupting = false;
            let turn = state.turn.take();
            let requests = state
                .open_requests
                .drain()
                .map(|(id, _)| id)
                .collect::<Vec<_>>();
            (turn, requests)
        };
        if let Some(turn_id) = turn {
            self.shared.sink.emit(PilotEvent::TurnAborted {
                turn_id,
                reason: Some("interrupted".into()),
            });
        }
        for request_id in requests {
            self.shared.sink.emit(PilotEvent::RequestResolved {
                request_id,
                outcome: RequestOutcome::Cancelled,
            });
        }
        self.shared.settle_status();
        Ok(())
    }

    async fn respond(&self, request_id: &str, answer: RequestAnswer) -> Result<(), PilotError> {
        let session_id = self.session_id()?;
        let pending = self
            .shared
            .state
            .lock()
            .open_requests
            .get(request_id)
            .cloned()
            .ok_or_else(|| PilotError::NoRequest(request_id.to_string()))?;
        let (path, body, outcome) = match pending {
            PendingRequest::Permission => {
                let reply = match answer {
                    RequestAnswer::Allow {
                        for_session,
                        selected,
                        ..
                    } => selected
                        .unwrap_or_else(|| if for_session { "always" } else { "once" }.to_string()),
                    RequestAnswer::Deny { .. } => "reject".into(),
                    RequestAnswer::Answers { .. } => {
                        return Err(PilotError::Protocol(
                            "OpenCode permission needs allow or deny".into(),
                        ))
                    }
                };
                let reply = match reply.as_str() {
                    "always" | "allow_always" => "always",
                    "reject" | "deny" => "reject",
                    "once" | "allow_once" => "once",
                    _ => {
                        return Err(PilotError::Protocol(
                            "Unknown OpenCode permission choice".into(),
                        ))
                    }
                };
                (
                    format!("/permission/{request_id}/reply"),
                    Some(json!({ "reply": reply })),
                    if reply == "reject" {
                        RequestOutcome::Denied
                    } else {
                        RequestOutcome::Allowed
                    },
                )
            }
            PendingRequest::Question { question_ids } => match answer {
                RequestAnswer::Deny { .. } => (
                    format!("/question/{request_id}/reject"),
                    None,
                    RequestOutcome::Denied,
                ),
                RequestAnswer::Answers { answers } => {
                    let ordered = question_ids
                        .iter()
                        .map(|id| answers.get(id).cloned().unwrap_or_default())
                        .collect::<Vec<_>>();
                    (
                        format!("/question/{request_id}/reply"),
                        Some(json!({ "answers": ordered })),
                        RequestOutcome::Allowed,
                    )
                }
                RequestAnswer::Allow { selected, .. } => (
                    format!("/question/{request_id}/reply"),
                    Some(json!({ "answers": [selected.into_iter().collect::<Vec<_>>()]})),
                    RequestOutcome::Allowed,
                ),
            },
        };
        self.api.json(Method::POST, &path, body).await?;
        if self
            .shared
            .state
            .lock()
            .open_requests
            .remove(request_id)
            .is_some()
        {
            self.shared.sink.emit(PilotEvent::RequestResolved {
                request_id: request_id.to_string(),
                outcome,
            });
        }
        self.shared.settle_status();
        let _ = session_id;
        Ok(())
    }

    async fn set_model(&self, selection: ModelSelection) -> Result<SwitchKind, PilotError> {
        if selection.instance.is_some() {
            return Ok(SwitchKind::Restart);
        }
        let Some(model) = selection.model else {
            return Ok(SwitchKind::Restart);
        };
        if protocol::parse_model(&model).is_none() {
            return Err(PilotError::Protocol(
                "OpenCode models must use provider/model".into(),
            ));
        }
        let changed = self.shared.state.lock().model.as_deref() != Some(&model);
        self.shared.state.lock().model = Some(model.clone());
        if changed {
            self.shared.sink.emit(PilotEvent::ModelChanged { model });
        }
        Ok(SwitchKind::InSession)
    }

    async fn set_mode(&self, mode: ExecMode) -> Result<(), PilotError> {
        let session_id = self.session_id()?;
        self.api
            .json(
                Method::PATCH,
                &format!("/session/{session_id}"),
                Some(json!({ "permission": protocol::permission_rules(mode) })),
            )
            .await?;
        self.shared.state.lock().mode = mode;
        Ok(())
    }

    async fn stop(&self) -> Result<(), PilotError> {
        self.shared.state.lock().stopping = true;
        let active = self.shared.state.lock().turn.is_some();
        if active {
            if let Some(session_id) = self.native_session_id() {
                let _ = self
                    .api
                    .json(Method::POST, &format!("/session/{session_id}/abort"), None)
                    .await;
            }
        }
        if let Some(task) = self.event_task.lock().await.take() {
            task.abort();
        }
        let polite = match &self.child {
            Some(child) => child.lock().await.stop().await,
            None => true,
        };
        self.shared.exit(if polite {
            ExitReason::Stopped
        } else {
            ExitReason::Killed
        });
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

async fn recover_pending_requests(api: &Api, shared: &Shared) -> Result<(), PilotError> {
    for (path, event_type) in [
        ("/permission", "permission.asked"),
        ("/question", "question.asked"),
    ] {
        let pending = api.json(Method::GET, path, None).await?;
        for request in pending.as_array().into_iter().flatten() {
            reduce::handle_event(
                shared,
                &json!({
                    "id": format!("recovered:{}", request["id"].as_str().unwrap_or("request")),
                    "type": event_type,
                    "properties": request
                }),
            );
        }
    }
    Ok(())
}

async fn process_loop(
    shared: Arc<Shared>,
    child: Weak<AsyncMutex<Child>>,
    mut rx: mpsc::UnboundedReceiver<Line>,
) {
    while let Some(line) = rx.recv().await {
        if line != Line::Eof {
            continue;
        }
        let (stopping, code) = {
            let stopping = shared.state.lock().stopping;
            let code = match child.upgrade() {
                Some(child) => child.lock().await.exit_code(),
                None => None,
            };
            (stopping, code)
        };
        shared.exit(if stopping {
            ExitReason::Stopped
        } else {
            ExitReason::Crashed { code }
        });
        break;
    }
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod state_tests;
#[cfg(test)]
mod tests;
