//! The claude driver: stream-json over stdio.
//!
//! The wire is the one the official Agent SDK consumes, pinned against the
//! installed CLI. What each frame is and where it was verified is in
//! `README.md`; this file only reduces those frames to `PilotEvent`.
//!
//! Two streams share one pipe. Conversation messages (`system`, `assistant`,
//! `user`, `stream_event`, `result`) flow downward; the control protocol
//! (`control_request`, `control_response`, `control_cancel_request`) flows both
//! ways, correlated by a `request_id` the sender mints. Both sides may open a
//! request, so a `control_request` arriving from the child is a question for
//! the user, while one we write is a command awaiting its single answer.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::driver::{
    Capabilities, Driver, ExecMode, Instance, McpServer, ModelSelection, OpenSpec, PilotError,
    RequestAnswer, Session, SessionSink, SwitchKind, TurnId, TurnInput,
};
use crate::event::{
    ExitReason, Item, ItemKind, PilotEvent, Request, RequestKind, RequestOption, RequestOutcome,
    Status, Usage,
};
use crate::proc::{argv_for_instance, resolve_bin, Child, Line};

/// The env var a test or the dev MCP points at a fake binary.
///
/// It may carry an interpreter (`node C:\...\fake-claude.mjs`), a `.mjs` file
/// not being executable on Windows. `OpenSpec::bin` outranks it.
pub const BIN_ENV: &str = "BOITE_PILOT_CLAUDE_BIN";

/// How long `open` waits for the `system`/`init` frame before giving up.
const INIT_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a control request waits for its single answer.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);

/// Boite's mode as claude's `--permission-mode` value.
///
/// `bypassPermissions` is refused unless the session also carries
/// `--allow-dangerously-skip-permissions`, which is why yolo pushes two flags.
pub fn permission_mode(mode: ExecMode) -> &'static str {
    match mode {
        ExecMode::Ask => "default",
        ExecMode::EditAlone => "acceptEdits",
        ExecMode::Yolo => "bypassPermissions",
    }
}

/// The exact argv a spec launches.
///
/// Public because the wire tests assert on it: building the command line is the
/// half of this driver that a fake cannot prove.
pub fn claude_argv(spec: &OpenSpec) -> Vec<String> {
    let mut argv = resolve_bin(&spec.bin, BIN_ENV, "claude");
    let mut push = |flag: &str| argv.push(flag.to_string());
    push("--print");
    push("--verbose");
    push("--output-format");
    push("stream-json");
    push("--input-format");
    push("stream-json");
    push("--permission-prompt-tool");
    push("stdio");
    push("--include-partial-messages");

    // Exclusive by construction: a resume names a conversation that exists, and
    // passing both makes the CLI refuse the launch.
    match spec.resume.as_deref() {
        Some(native) => argv.push(format!("--resume={native}")),
        None => argv.push(format!("--session-id={}", spec.thread_id)),
    }

    if let Some(model) = spec.model.as_deref() {
        argv.push("--model".to_string());
        argv.push(model.to_string());
    }
    argv.push("--permission-mode".to_string());
    argv.push(permission_mode(spec.options.mode).to_string());
    if spec.options.mode == ExecMode::Yolo {
        argv.push("--allow-dangerously-skip-permissions".to_string());
    }
    if !spec.mcp_servers.is_empty() {
        argv.push("--mcp-config".to_string());
        argv.push(mcp_config(&spec.mcp_servers));
    }
    if let Some(append) = spec.system_prompt_append.as_deref() {
        argv.push("--append-system-prompt".to_string());
        argv.push(append.to_string());
    }
    argv_for_instance("claude", &spec.instance, argv)
}

/// `--mcp-config` takes the JSON inline, shaped like a settings file.
fn mcp_config(servers: &[McpServer]) -> String {
    let mut map = serde_json::Map::new();
    for server in servers {
        map.insert(
            server.name.clone(),
            json!({ "command": server.command, "args": server.args, "env": server.env }),
        );
    }
    json!({ "mcpServers": Value::Object(map) }).to_string()
}

/// The environment the child gets on top of the inherited one.
fn env_for(spec: &OpenSpec) -> BTreeMap<String, String> {
    let mut env = spec.env.clone();
    // A native instance is a config directory, never a `HOME`: moving `HOME`
    // would take the shell, git and ssh configuration with the account.
    if let Instance::Native { config_dir: Some(dir) } = &spec.instance {
        env.insert("CLAUDE_CONFIG_DIR".to_string(), dir.to_string_lossy().to_string());
    }
    env
}

/// The models a native claude instance can be asked for.
///
/// A list to extend per release, not a fetch: the CLI has no endpoint that
/// answers what an account may use, and a menu that opened on a network call
/// would be empty whenever the network is.
///
/// Source, read 2026-09-04, in this order because the first two disagree with
/// what a menu needs:
///
/// - `@anthropic-ai/claude-agent-sdk` 0.3.259 carries no model id union at all.
///   `sdk.d.ts` types `model?: string` with three examples in a doc comment and
///   answers the real list at runtime through `Query.supportedModels()`, which
///   is a network call. So the SDK is the wrong source for a static list and
///   the previous one, written from memory against it, named three ids the CLI
///   no longer offers.
/// - `claude --help` on 2.1.260 documents the alias form: "Provide an alias for
///   the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name
///   (e.g. 'claude-fable-5')". That is where the aliases below come from.
/// - The CLI's own baked catalogue, inside the 2.1.260 executable, is where the
///   full ids come from: `aliases` maps opus to `claude-opus-5`, sonnet to
///   `claude-sonnet-5`, haiku to `claude-haiku-4-5` and fable to
///   `claude-fable-5-1`, and the catalogue's `{id, family, display_name}` rows
///   are the nineteen models it knows.
///
/// Four of those nineteen are left out on purpose: `claude-3-5-haiku`,
/// `claude-3-5-sonnet` and `claude-3-7-sonnet` are in the CLI's own deprecation
/// table with an end-of-life date, and the two `claude-mythos-5*` rows are a
/// preview an ordinary account cannot ask for.
pub const NATIVE_MODELS: &[&str] = &[
    // The aliases first: they are what the picker should offer by default,
    // being the only names that follow the account onto the next release.
    "fable",
    "opus",
    "sonnet",
    "haiku",
    // Then the full ids, newest family first.
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-opus-4-0",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4-0",
    "claude-haiku-4-5",
];

pub struct ClaudeDriver;

#[async_trait]
impl Driver for ClaudeDriver {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            model_switch: SwitchKind::InSession,
            // No rollback on this wire: `rewind_files` restores files, not the
            // conversation, so claiming it would promise the wrong undo.
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
        Ok(Box::new(ClaudeSession::open(spec, sink).await?))
    }
}

#[derive(Default)]
struct State {
    status: Status,
    native_session_id: Option<String>,
    model: Option<String>,
    /// The turn in flight. `None` between turns, and taking it is what makes a
    /// completion arrive exactly once.
    turn: Option<String>,
    turn_started_ms: u64,
    open_requests: HashSet<String>,
    /// Set between an accepted `interrupt` and the `result` that follows it, so
    /// the abort is emitted once and the late result is dropped.
    interrupting: bool,
    stopping: bool,
    exited: bool,
    /// The assistant message being streamed, for the id a delta belongs to.
    message_id: Option<String>,
    /// Blocks already opened by a `content_block_start`, so the completed
    /// message does not open them a second time.
    open_blocks: HashSet<String>,
}

struct Shared {
    sink: SessionSink,
    state: Mutex<State>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl Shared {
    /// Emit `status.changed` only when it actually changed: the sidebar redraws
    /// on every event it receives.
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

    /// The status the current state implies: an open request outranks a running
    /// turn, because a question asked of the user is the user's.
    fn settle_status(&self) {
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

pub struct ClaudeSession {
    shared: Arc<Shared>,
    child: AsyncMutex<Child>,
    pid: Option<u32>,
}

impl ClaudeSession {
    async fn open(spec: OpenSpec, sink: SessionSink) -> Result<Self, PilotError> {
        let argv = claude_argv(&spec);
        let env = env_for(&spec);
        tracing::info!(thread = %spec.thread_id, argv = ?argv, "pilot.claude.open");
        let (child, rx) = Child::spawn(&argv, &spec.cwd, &env)?;
        let pid = child.pid();

        let shared = Arc::new(Shared {
            sink,
            state: Mutex::new(State::default()),
            pending: Mutex::new(HashMap::new()),
        });
        let (started_tx, started_rx) = oneshot::channel();
        tokio::spawn(read_loop(Arc::clone(&shared), rx, started_tx));

        let session = Self { shared, child: AsyncMutex::new(child), pid };

        match tokio::time::timeout(INIT_TIMEOUT, started_rx).await {
            Ok(Ok(Ok(()))) => Ok(session),
            Ok(Ok(Err(message))) => Err(PilotError::Spawn(message)),
            // The reader dropped the sender without answering: the child died
            // before it said anything.
            Ok(Err(_)) => Err(PilotError::Spawn("the agent exited before init".to_string())),
            Err(_) => Err(PilotError::Timeout),
        }
    }

    /// Write one control request and wait for the answer carrying its id.
    async fn control(&self, request: Value) -> Result<Value, PilotError> {
        let request_id = format!("boite_{}", uuid::Uuid::new_v4());
        let (tx, rx) = oneshot::channel();
        self.shared.pending.lock().insert(request_id.clone(), tx);
        let frame = json!({
            "type": "control_request",
            "request_id": request_id,
            "request": request,
        });
        let written = self.child.lock().await.write_line(&frame.to_string()).await;
        if let Err(error) = written {
            self.shared.pending.lock().remove(&request_id);
            return Err(error);
        }
        match tokio::time::timeout(CONTROL_TIMEOUT, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(PilotError::Protocol(message)),
            Ok(Err(_)) => Err(PilotError::SessionGone("the agent exited".to_string())),
            Err(_) => {
                self.shared.pending.lock().remove(&request_id);
                Err(PilotError::Timeout)
            }
        }
    }
}

#[async_trait]
impl Session for ClaudeSession {
    async fn prompt(&self, input: TurnInput) -> Result<TurnId, PilotError> {
        if let Some(selection) = input.selection.clone() {
            self.set_model(selection).await?;
        }
        let turn_id = format!("turn_{}", uuid::Uuid::new_v4());
        let session_id = {
            let mut state = self.shared.state.lock();
            if state.exited {
                return Err(PilotError::SessionGone("the agent exited".to_string()));
            }
            state.turn = Some(turn_id.clone());
            state.turn_started_ms = now_ms();
            state.interrupting = false;
            state.native_session_id.clone()
        };

        // The turn is announced before the write, not after: the child can
        // answer between the two, and a `busy` emitted on top of the reader's
        // `idle` would pin the sidebar on a turn that already ended.
        self.shared.sink.emit(PilotEvent::TurnStarted { turn_id: turn_id.clone() });
        self.shared.settle_status();

        let mut message = json!({
            "type": "user",
            "message": { "role": "user", "content": input.text },
            "parent_tool_use_id": Value::Null,
        });
        if let Some(id) = session_id {
            message["session_id"] = Value::String(id);
        }
        if let Err(error) = self.child.lock().await.write_line(&message.to_string()).await {
            let turn = self.shared.state.lock().turn.take();
            if let Some(turn_id) = turn {
                self.shared
                    .sink
                    .emit(PilotEvent::TurnAborted { turn_id, reason: Some(error.to_string()) });
            }
            self.shared.settle_status();
            return Err(error);
        }
        Ok(turn_id)
    }

    async fn interrupt(&self) -> Result<(), PilotError> {
        self.shared.state.lock().interrupting = true;
        let result = self.control(json!({ "subtype": "interrupt" })).await;
        if result.is_err() {
            self.shared.state.lock().interrupting = false;
            return result.map(|_| ());
        }
        // The abort is emitted here rather than waiting for the `result` frame:
        // the CLI answers the control request once the turn is really gone, and
        // taking the turn now is what keeps the late `result` from emitting a
        // completion on top of it.
        let turn = self.shared.state.lock().turn.take();
        if let Some(turn_id) = turn {
            self.shared
                .sink
                .emit(PilotEvent::TurnAborted { turn_id, reason: Some("interrupted".into()) });
        }
        self.shared.settle_status();
        Ok(())
    }

    async fn respond(&self, request_id: &str, answer: RequestAnswer) -> Result<(), PilotError> {
        {
            let state = self.shared.state.lock();
            if !state.open_requests.contains(request_id) {
                return Err(PilotError::NoRequest(request_id.to_string()));
            }
        }
        let (payload, outcome) = match &answer {
            RequestAnswer::Allow { updated_input, updated_permissions } => {
                let mut payload = json!({ "behavior": "allow" });
                if let Some(input) = updated_input {
                    payload["updatedInput"] = input.clone();
                }
                if !updated_permissions.is_null() {
                    payload["updatedPermissions"] = updated_permissions.clone();
                }
                (payload, RequestOutcome::Allowed)
            }
            RequestAnswer::Deny { message } => (
                json!({ "behavior": "deny", "message": message }),
                RequestOutcome::Denied,
            ),
        };
        let frame = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": payload,
            },
        });
        self.child.lock().await.write_line(&frame.to_string()).await?;

        self.shared.state.lock().open_requests.remove(request_id);
        self.shared
            .sink
            .emit(PilotEvent::RequestResolved { request_id: request_id.to_string(), outcome });
        self.shared.settle_status();
        Ok(())
    }

    async fn set_model(&self, selection: ModelSelection) -> Result<SwitchKind, PilotError> {
        // Another account is another process: the credentials are read at
        // launch, so the caller has to stop and reopen with `resume`.
        if selection.instance.is_some() {
            return Ok(SwitchKind::Restart);
        }
        let model = selection.model.clone();
        self.control(json!({ "subtype": "set_model", "model": model })).await?;
        if let Some(model) = model {
            self.shared.state.lock().model = Some(model.clone());
            self.shared.sink.emit(PilotEvent::ModelChanged { model });
        }
        Ok(SwitchKind::InSession)
    }

    async fn set_mode(&self, mode: ExecMode) -> Result<(), PilotError> {
        self.control(json!({
            "subtype": "set_permission_mode",
            "mode": permission_mode(mode),
        }))
        .await?;
        Ok(())
    }

    async fn stop(&self) -> Result<(), PilotError> {
        self.shared.state.lock().stopping = true;
        self.child.lock().await.stop().await;
        Ok(())
    }

    fn native_session_id(&self) -> Option<String> {
        self.shared.state.lock().native_session_id.clone()
    }

    fn status(&self) -> Status {
        self.shared.state.lock().status
    }

    fn pid(&self) -> Option<u32> {
        self.pid
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Owns the child's output for the life of the session.
async fn read_loop(
    shared: Arc<Shared>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Line>,
    started: oneshot::Sender<Result<(), String>>,
) {
    let mut started = Some(started);
    // The last few stderr lines, so a launch that fails says why instead of
    // "the agent exited before init".
    let mut stderr_tail: Vec<String> = Vec::new();

    while let Some(line) = rx.recv().await {
        match line {
            Line::Out(text) => {
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    // Not every byte on stdout is a frame: a wrapper can print
                    // a banner. Dropping it is right, failing on it is not.
                    tracing::debug!(line = %truncate(&text), "pilot.claude.unparsed");
                    continue;
                };
                if handle(&shared, &value) && started.is_some() {
                    if let Some(tx) = started.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
            }
            Line::Err(text) => {
                tracing::debug!(line = %truncate(&text), "pilot.claude.stderr");
                if stderr_tail.len() == 8 {
                    stderr_tail.remove(0);
                }
                stderr_tail.push(text);
            }
            Line::Eof => break,
        }
    }

    if let Some(tx) = started.take() {
        let message = if stderr_tail.is_empty() {
            "the agent exited before init".to_string()
        } else {
            stderr_tail.join("; ")
        };
        let _ = tx.send(Err(message));
    }
    finish(&shared);
}

/// Wake everything still waiting, then say the session is gone.
fn finish(shared: &Arc<Shared>) {
    let (turn, requests, stopping, already) = {
        let mut state = shared.state.lock();
        let already = state.exited;
        state.exited = true;
        (
            state.turn.take(),
            std::mem::take(&mut state.open_requests),
            state.stopping,
            already,
        )
    };
    if already {
        return;
    }
    for (_, tx) in shared.pending.lock().drain() {
        let _ = tx.send(Err("the agent exited".to_string()));
    }
    for request_id in requests {
        shared
            .sink
            .emit(PilotEvent::RequestResolved { request_id, outcome: RequestOutcome::Cancelled });
    }
    // A turn still open when the pipe closed never completed, whatever killed
    // the child: the abort comes first so the timeline is not left mid-turn.
    if let Some(turn_id) = turn {
        shared.sink.emit(PilotEvent::TurnAborted {
            turn_id,
            reason: Some("the agent exited".to_string()),
        });
    }
    shared.set_status(Status::Idle);
    let reason = if stopping { ExitReason::Stopped } else { ExitReason::Crashed { code: None } };
    shared.sink.emit(PilotEvent::SessionExited { reason });
}

/// Reduce one frame. Answers whether it was the init frame.
fn handle(shared: &Arc<Shared>, value: &Value) -> bool {
    match value["type"].as_str().unwrap_or_default() {
        "system" => return handle_system(shared, value),
        "stream_event" => handle_stream_event(shared, value),
        "assistant" => handle_assistant(shared, value),
        "user" => handle_user(shared, value),
        "result" => handle_result(shared, value),
        "control_request" => handle_control_request(shared, value),
        "control_response" => handle_control_response(shared, value),
        "control_cancel_request" => handle_control_cancel(shared, value),
        // A keep-alive exists to hold the pipe open and carries nothing.
        "keep_alive" => {}
        _ => {}
    }
    false
}

fn handle_system(shared: &Arc<Shared>, value: &Value) -> bool {
    if value["subtype"].as_str() != Some("init") {
        return false;
    }
    let native_session_id = value["session_id"].as_str().map(str::to_string);
    let model = value["model"].as_str().map(str::to_string);
    let slash_commands: Vec<String> = value["slash_commands"]
        .as_array()
        .map(|items| items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let mut extra = BTreeMap::new();
    for key in ["claude_code_version", "permissionMode", "tools", "capabilities", "cwd"] {
        if let Some(found) = value.get(key) {
            extra.insert(key.to_string(), found.clone());
        }
    }

    {
        let mut state = shared.state.lock();
        state.native_session_id = native_session_id.clone();
        state.model = model.clone();
    }
    shared.sink.emit(PilotEvent::SessionStarted {
        native_session_id,
        model,
        slash_commands,
        extra,
    });
    shared.settle_status();
    true
}

fn handle_stream_event(shared: &Arc<Shared>, value: &Value) {
    let event = &value["event"];
    match event["type"].as_str().unwrap_or_default() {
        "message_start" => {
            let id = event["message"]["id"].as_str().map(str::to_string);
            let mut state = shared.state.lock();
            state.message_id = id;
            state.open_blocks.clear();
        }
        "content_block_start" => {
            let Some(kind) = block_item_kind(&event["content_block"]) else { return };
            let index = event["index"].as_u64().unwrap_or(0);
            let (item_id, turn_id) = {
                let mut state = shared.state.lock();
                let id = block_id(state.message_id.as_deref(), index);
                state.open_blocks.insert(id.clone());
                (id, state.turn.clone())
            };
            shared.sink.emit(PilotEvent::ItemStarted { item: Item::new(item_id, kind, turn_id) });
        }
        "content_block_delta" => {
            let delta = &event["delta"];
            let text = match delta["type"].as_str().unwrap_or_default() {
                "text_delta" => delta["text"].as_str(),
                "thinking_delta" => delta["thinking"].as_str(),
                _ => None,
            };
            let Some(text) = text else { return };
            let index = event["index"].as_u64().unwrap_or(0);
            let item_id = {
                let state = shared.state.lock();
                block_id(state.message_id.as_deref(), index)
            };
            shared
                .sink
                .emit(PilotEvent::ItemDelta { item_id, text: text.to_string() });
        }
        _ => {}
    }
}

fn block_item_kind(block: &Value) -> Option<ItemKind> {
    match block["type"].as_str().unwrap_or_default() {
        "text" => Some(ItemKind::AssistantText),
        "thinking" | "redacted_thinking" => Some(ItemKind::Reasoning),
        "tool_use" => Some(ItemKind::ToolCall),
        _ => None,
    }
}

/// One item id per content block of one message.
///
/// A message id plus the block index, because a single assistant message can
/// carry text and several tool calls and each is its own card.
fn block_id(message_id: Option<&str>, index: u64) -> String {
    format!("{}#{index}", message_id.unwrap_or("msg"))
}

fn handle_assistant(shared: &Arc<Shared>, value: &Value) {
    let message = &value["message"];
    let message_id = message["id"].as_str().map(str::to_string);
    let turn_id = shared.state.lock().turn.clone();
    let Some(blocks) = message["content"].as_array() else { return };

    for (index, block) in blocks.iter().enumerate() {
        let index = index as u64;
        match block["type"].as_str().unwrap_or_default() {
            "text" => {
                let id = block_id(message_id.as_deref(), index);
                emit_completed(
                    shared,
                    &id,
                    ItemKind::AssistantText,
                    turn_id.clone(),
                    json!({ "text": block["text"].as_str().unwrap_or_default() }),
                );
            }
            "thinking" => {
                let id = block_id(message_id.as_deref(), index);
                emit_completed(
                    shared,
                    &id,
                    ItemKind::Reasoning,
                    turn_id.clone(),
                    json!({ "text": block["thinking"].as_str().unwrap_or_default() }),
                );
            }
            "tool_use" => {
                // A tool call is identified by its `tool_use_id` and not by the
                // block index: the `tool_result` that completes it arrives in
                // another message and names only that id.
                let Some(id) = block["id"].as_str() else { continue };
                let body = json!({
                    "name": block["name"].as_str().unwrap_or_default(),
                    "input": block["input"].clone(),
                });
                shared.sink.emit(PilotEvent::ItemStarted {
                    item: Item::new(id, ItemKind::ToolCall, turn_id.clone()).with_body(body),
                });
            }
            _ => {}
        }
    }
}

/// Emit `item.started` first when the stream never opened the block, so a
/// consumer never sees a completion for an item it does not know.
fn emit_completed(
    shared: &Arc<Shared>,
    id: &str,
    kind: ItemKind,
    turn_id: Option<String>,
    body: Value,
) {
    let opened = shared.state.lock().open_blocks.remove(id);
    if !opened {
        shared
            .sink
            .emit(PilotEvent::ItemStarted { item: Item::new(id, kind, turn_id.clone()) });
    }
    shared.sink.emit(PilotEvent::ItemCompleted {
        item: Item::new(id, kind, turn_id).with_body(body),
    });
}

fn handle_user(shared: &Arc<Shared>, value: &Value) {
    let turn_id = shared.state.lock().turn.clone();
    let Some(blocks) = value["message"]["content"].as_array() else { return };
    for block in blocks {
        if block["type"].as_str() != Some("tool_result") {
            continue;
        }
        let Some(id) = block["tool_use_id"].as_str() else { continue };
        let body = json!({
            "content": block["content"].clone(),
            "is_error": block["is_error"].as_bool().unwrap_or(false),
        });
        shared.sink.emit(PilotEvent::ItemCompleted {
            item: Item::new(id, ItemKind::ToolCall, turn_id.clone()).with_body(body),
        });
    }
}

fn handle_result(shared: &Arc<Shared>, value: &Value) {
    let usage = usage_from(value);
    let (turn, started_ms, interrupting) = {
        let mut state = shared.state.lock();
        (state.turn.take(), state.turn_started_ms, std::mem::take(&mut state.interrupting))
    };
    let Some(turn_id) = turn else {
        // The turn was already closed, by an accepted interrupt or by an exit.
        // A second completion for it would double the timeline's turn footer.
        return;
    };

    let duration_ms = value["duration_ms"]
        .as_u64()
        .unwrap_or_else(|| now_ms().saturating_sub(started_ms));
    let is_error = value["is_error"].as_bool().unwrap_or(false)
        || value["subtype"].as_str().unwrap_or("success") != "success";

    if is_error || interrupting {
        let reason = value["subtype"].as_str().map(str::to_string);
        shared.sink.emit(PilotEvent::TurnAborted { turn_id, reason });
    } else {
        shared.sink.emit(PilotEvent::TurnCompleted { turn_id, duration_ms, usage: usage.clone() });
    }
    shared.sink.emit(PilotEvent::UsageUpdated { usage });
    shared.settle_status();
}

fn usage_from(value: &Value) -> Usage {
    let usage = &value["usage"];
    let context_window = value["modelUsage"]
        .as_object()
        .and_then(|models| models.values().next().cloned())
        .and_then(|model| model["contextWindow"].as_u64());
    Usage {
        input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
        cache_read_input_tokens: usage["cache_read_input_tokens"].as_u64().unwrap_or(0),
        cache_creation_input_tokens: usage["cache_creation_input_tokens"].as_u64().unwrap_or(0),
        total_cost_usd: value["total_cost_usd"].as_f64(),
        context_window,
    }
}

fn handle_control_request(shared: &Arc<Shared>, value: &Value) {
    let Some(request_id) = value["request_id"].as_str() else { return };
    let request = &value["request"];
    if request["subtype"].as_str() != Some("can_use_tool") {
        // Every other inbound subtype (hooks, MCP calls, dialogs) is a callback
        // for a feature this driver does not declare. Answering an error is
        // right: silence would leave the CLI blocked for good.
        tracing::debug!(
            request = %request_id,
            subtype = %request["subtype"].as_str().unwrap_or("?"),
            "pilot.claude.control_request.unsupported"
        );
        return;
    }

    let suggestions = request["permission_suggestions"].clone();
    let mut options = vec![
        RequestOption { value: "allow".to_string(), label: "Allow".to_string() },
        RequestOption { value: "deny".to_string(), label: "Deny".to_string() },
    ];
    // The CLI says when a persistent allow rule would be broader than the ask,
    // and the dock must not offer one then.
    if !suggestions.is_null() && request["suppress_always_allow_rule"].as_bool() != Some(true) {
        options.insert(
            1,
            RequestOption { value: "allow_always".to_string(), label: "Always allow".to_string() },
        );
    }

    let opened = Request {
        id: request_id.to_string(),
        kind: RequestKind::ToolApproval,
        tool_name: request["tool_name"].as_str().map(str::to_string),
        tool_use_id: request["tool_use_id"].as_str().map(str::to_string),
        input: request["input"].clone(),
        title: request["title"].as_str().map(str::to_string),
        description: request["description"].as_str().map(str::to_string),
        options,
        suggestions,
    };
    shared.state.lock().open_requests.insert(request_id.to_string());
    shared.sink.emit(PilotEvent::RequestOpened { request: opened });
    shared.settle_status();
}

fn handle_control_response(shared: &Arc<Shared>, value: &Value) {
    let response = &value["response"];
    let Some(request_id) = response["request_id"].as_str() else { return };
    let Some(tx) = shared.pending.lock().remove(request_id) else { return };
    let answer = if response["subtype"].as_str() == Some("error") {
        Err(response["error"].as_str().unwrap_or("control request failed").to_string())
    } else {
        Ok(response["response"].clone())
    };
    let _ = tx.send(answer);
}

fn handle_control_cancel(shared: &Arc<Shared>, value: &Value) {
    let Some(request_id) = value["request_id"].as_str() else { return };
    let removed = shared.state.lock().open_requests.remove(request_id);
    if removed {
        shared.sink.emit(PilotEvent::RequestResolved {
            request_id: request_id.to_string(),
            outcome: RequestOutcome::Cancelled,
        });
        shared.settle_status();
    }
}

fn truncate(text: &str) -> String {
    if text.len() <= 200 {
        return text.to_string();
    }
    text.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn spec() -> OpenSpec {
        OpenSpec {
            thread_id: "11111111-2222-3333-4444-555555555555".into(),
            cwd: PathBuf::from("."),
            driver: "claude".into(),
            bin: vec!["claude".into()],
            ..Default::default()
        }
    }

    #[test]
    fn a_fresh_session_names_itself_and_a_resume_does_not() {
        let argv = claude_argv(&spec());
        assert!(argv.contains(&"--session-id=11111111-2222-3333-4444-555555555555".to_string()));
        assert!(argv.iter().all(|a| !a.starts_with("--resume")));

        let mut resumed = spec();
        resumed.resume = Some("native-1".into());
        let argv = claude_argv(&resumed);
        assert!(argv.contains(&"--resume=native-1".to_string()));
        assert!(
            argv.iter().all(|a| !a.starts_with("--session-id")),
            "the CLI refuses a launch carrying both"
        );
    }

    #[test]
    fn a_mode_becomes_the_flags_the_cli_takes() {
        let mut yolo = spec();
        yolo.options.mode = ExecMode::Yolo;
        let argv = claude_argv(&yolo);
        assert!(argv.windows(2).any(|w| w == ["--permission-mode", "bypassPermissions"]));
        assert!(
            argv.contains(&"--allow-dangerously-skip-permissions".to_string()),
            "bypassPermissions is refused without it"
        );

        let mut edits = spec();
        edits.options.mode = ExecMode::EditAlone;
        assert!(claude_argv(&edits).windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]));
    }

    #[test]
    fn mcp_servers_go_inline_as_a_settings_object() {
        let mut with_mcp = spec();
        with_mcp.mcp_servers = vec![McpServer {
            name: "boite".into(),
            command: "boite-mcp".into(),
            args: vec!["--stdio".into()],
            env: BTreeMap::new(),
        }];
        let argv = claude_argv(&with_mcp);
        let index = argv.iter().position(|a| a == "--mcp-config").expect("flag");
        let config: Value = serde_json::from_str(&argv[index + 1]).expect("inline json");
        assert_eq!(config["mcpServers"]["boite"]["command"], "boite-mcp");
    }

    #[test]
    fn a_fastpick_instance_wraps_the_whole_agent_line() {
        let mut route = spec();
        route.instance = Instance::Fastpick { provider: "grok".into(), model: "grok-4-6".into() };
        let argv = claude_argv(&route);
        assert_eq!(argv[0], "fastpick");
        let separator = argv.iter().position(|a| a == "--").expect("separator");
        assert_eq!(argv[separator + 1], "claude");
        assert!(argv[..separator].iter().all(|a| !a.starts_with("--session-id")));
    }

    /// The fixture is one real `claude 2.1.259` turn, captured and redacted.
    ///
    /// It is here so the fake cannot drift on its own: the same reduction that
    /// the fake's frames go through is run over the CLI's own bytes, and a
    /// field the vendor renames fails this test rather than a live session.
    #[test]
    fn the_captured_cli_turn_reduces_to_the_events_the_timeline_reads() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/claude-2.1.259-hello.jsonl");
        let text = std::fs::read_to_string(&path).expect("fixture");

        let recorder = crate::scripted::Recorder::new();
        let shared = Arc::new(Shared {
            sink: SessionSink::new("t1", recorder.clone()),
            state: Mutex::new(State::default()),
            pending: Mutex::new(HashMap::new()),
        });
        // A captured turn starts mid-conversation: without an open turn the
        // `result` frame has nothing to complete.
        shared.state.lock().turn = Some("turn-1".to_string());

        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let value: Value = serde_json::from_str(line).expect("fixture line");
            handle(&shared, &value);
        }

        assert_eq!(
            recorder.kinds(),
            vec![
                "session.started",
                "status.changed",
                "item.started",
                "item.delta",
                "item.completed",
                "turn.completed",
                "usage.updated",
                "status.changed",
            ]
        );
        let events = recorder.events();
        let started = events
            .iter()
            .find_map(|event| match event {
                PilotEvent::SessionStarted { native_session_id, model, slash_commands, extra } => {
                    Some((native_session_id.clone(), model.clone(), slash_commands.len(), extra.clone()))
                }
                _ => None,
            })
            .expect("session.started");
        assert_eq!(started.0.as_deref(), Some("11111111-2222-3333-4444-555555555555"));
        assert_eq!(started.1.as_deref(), Some("claude-fable-5-1"));
        assert!(started.2 > 0, "the init frame advertises the slash commands");
        assert_eq!(started.3["claude_code_version"], "2.1.259");

        let delta = events
            .iter()
            .find_map(|event| match event {
                PilotEvent::ItemDelta { text, .. } => Some(text.clone()),
                _ => None,
            })
            .expect("item.delta");
        assert_eq!(delta, "ok");

        let usage = events
            .iter()
            .find_map(|event| match event {
                PilotEvent::TurnCompleted { usage, .. } => Some(usage.clone()),
                _ => None,
            })
            .expect("turn.completed");
        assert_eq!(usage.cache_read_input_tokens, 16431);
        assert_eq!(usage.context_window, Some(1_000_000));
    }

    #[test]
    fn a_config_dir_moves_the_account_and_not_the_home() {
        let mut instance = spec();
        instance.instance = Instance::Native { config_dir: Some(PathBuf::from("C:/accounts/a")) };
        let env = env_for(&instance);
        assert!(env.contains_key("CLAUDE_CONFIG_DIR"));
        assert!(!env.contains_key("HOME"));
    }
}
