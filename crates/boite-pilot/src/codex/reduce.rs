//! Reduction from Codex App Server frames to Boite's canonical events.

use serde_json::{json, Value};

use super::{now_ms, ApprovalWire, PendingKind, PendingRequest, Shared};
use crate::event::{
    Item, ItemKind, PilotEvent, Request, RequestKind, RequestOption, RequestQuestion, Status, Usage,
};

pub(super) fn rpc_error(error: &Value) -> String {
    let message = error["message"]
        .as_str()
        .unwrap_or("Codex App Server request failed");
    match error.get("data") {
        Some(data) if !data.is_null() => format!("{message}: {data}"),
        _ => message.to_string(),
    }
}

/// Handle a notification or an inbound JSON-RPC request. A returned frame is
/// an immediate error for a method Boite cannot answer; interactive requests
/// return later from `Session::respond`.
pub(super) fn handle_server_message(shared: &Shared, frame: &Value) -> Option<Value> {
    let method = frame["method"].as_str().unwrap_or_default();
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
    if let Some(id) = frame.get("id").cloned() {
        return match method {
            "item/commandExecution/requestApproval" => {
                open_approval(shared, id, ApprovalWire::Command, params);
                None
            }
            "item/fileChange/requestApproval" => {
                open_approval(shared, id, ApprovalWire::FileChange, params);
                None
            }
            "execCommandApproval" => {
                open_approval(shared, id, ApprovalWire::LegacyCommand, params);
                None
            }
            "applyPatchApproval" => {
                open_approval(shared, id, ApprovalWire::LegacyPatch, params);
                None
            }
            "item/tool/requestUserInput" => {
                open_user_input(shared, id, params);
                None
            }
            _ => Some(json!({
                "id": id,
                "error": { "code": -32601, "message": format!("unsupported App Server request {method}") },
            })),
        };
    }
    handle_notification(shared, method, &params);
    None
}

fn open_approval(shared: &Shared, rpc_id: Value, wire: ApprovalWire, params: Value) {
    let request_id = format!("codex_{}", uuid::Uuid::new_v4());
    let (tool_name, title, description) = match wire {
        ApprovalWire::Command | ApprovalWire::LegacyCommand => (
            Some("Command".to_string()),
            Some("Codex wants to run a command".to_string()),
            string_at(&params, &["reason"]).or_else(|| command_text(&params)),
        ),
        ApprovalWire::FileChange | ApprovalWire::LegacyPatch => (
            Some("File change".to_string()),
            Some("Codex wants to change files".to_string()),
            string_at(&params, &["reason"]),
        ),
    };
    let tool_use_id = string_at(&params, &["itemId", "callId"]);
    let request = Request {
        id: request_id.clone(),
        kind: RequestKind::ToolApproval,
        tool_name,
        tool_use_id,
        input: params.clone(),
        title,
        description,
        options: vec![
            RequestOption {
                value: "allow".into(),
                label: "Allow".into(),
            },
            RequestOption {
                value: "allow_always".into(),
                label: "Always allow".into(),
            },
            RequestOption {
                value: "deny".into(),
                label: "Deny".into(),
            },
        ],
        questions: vec![],
        suggestions: Value::Null,
    };
    shared.state.lock().open_requests.insert(
        request_id,
        PendingRequest {
            rpc_id,
            kind: PendingKind::Approval(wire),
        },
    );
    shared.sink.emit(PilotEvent::RequestOpened { request });
    shared.settle_status();
}

fn open_user_input(shared: &Shared, rpc_id: Value, params: Value) {
    let raw_questions = params["questions"].as_array().cloned().unwrap_or_default();
    let first = raw_questions.first().cloned().unwrap_or_else(|| json!({}));
    let questions = raw_questions
        .iter()
        .filter_map(|question| {
            let id = question["id"].as_str()?.trim();
            let header = question["header"].as_str()?.trim();
            let prompt = question["question"].as_str()?.trim();
            if id.is_empty() || header.is_empty() || prompt.is_empty() {
                return None;
            }
            let options: Vec<RequestOption> = question["options"]
                .as_array()
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            let label = option["label"].as_str()?.trim();
                            if label.is_empty() {
                                return None;
                            }
                            Some(RequestOption {
                                value: label.to_string(),
                                label: label.to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let allow_custom_answer = question["isOther"].as_bool().unwrap_or(options.is_empty());
            Some(RequestQuestion {
                id: id.to_string(),
                header: header.to_string(),
                question: prompt.to_string(),
                options,
                allow_custom_answer,
                secret: question["isSecret"].as_bool().unwrap_or(false),
                multi_select: false,
            })
        })
        .collect::<Vec<_>>();
    let question_ids = questions
        .iter()
        .map(|question| question.id.clone())
        .collect::<Vec<_>>();
    let request_id = format!("codex_{}", uuid::Uuid::new_v4());
    let options = questions
        .first()
        .map(|question| question.options.clone())
        .unwrap_or_default();
    let description = if raw_questions.len() > 1 {
        Some(
            raw_questions
                .iter()
                .filter_map(|question| question["question"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        )
    } else {
        first["question"].as_str().map(str::to_string)
    };
    let request = Request {
        id: request_id.clone(),
        kind: RequestKind::Question,
        tool_name: None,
        tool_use_id: string_at(&params, &["itemId"]),
        input: params,
        title: first["header"].as_str().map(str::to_string),
        description,
        options,
        questions,
        suggestions: Value::Null,
    };
    shared.state.lock().open_requests.insert(
        request_id,
        PendingRequest {
            rpc_id,
            kind: PendingKind::UserInput { question_ids },
        },
    );
    shared.sink.emit(PilotEvent::RequestOpened { request });
    shared.settle_status();
}

fn handle_notification(shared: &Shared, method: &str, params: &Value) {
    match method {
        "turn/started" => {
            let provider_turn = params["turn"]["id"].as_str().map(str::to_string);
            if let Some(provider_turn) = provider_turn {
                shared.state.lock().provider_turn = Some(provider_turn);
            }
            shared.set_status(Status::Busy);
        }
        "turn/completed" => complete_turn(shared, params),
        "item/started" => start_item(shared, &params["item"]),
        "item/completed" => complete_item(shared, &params["item"]),
        "item/agentMessage/delta"
        | "item/reasoning/textDelta"
        | "item/reasoning/summaryTextDelta"
        | "item/plan/delta" => delta(shared, params),
        "thread/tokenUsage/updated" => update_usage(shared, params),
        "thread/settings/updated" => {
            if let Some(model) = params["threadSettings"]["model"].as_str() {
                set_model(shared, model);
            }
        }
        "model/rerouted" => {
            if let Some(model) = params["toModel"].as_str() {
                set_model(shared, model);
            }
        }
        "error" => handle_error(shared, params),
        "thread/closed" => {
            let turn = shared.state.lock().turn.take();
            if let Some(turn_id) = turn {
                shared.sink.emit(PilotEvent::TurnAborted {
                    turn_id,
                    reason: Some("Codex thread closed".into()),
                });
            }
            shared.settle_status();
        }
        _ => {}
    }
}

fn start_item(shared: &Shared, raw: &Value) {
    let Some((id, kind, body)) = item(raw) else {
        return;
    };
    if kind == ItemKind::UserMessage {
        return;
    }
    let turn_id = shared.state.lock().turn.clone();
    shared.state.lock().open_items.insert(id.clone());
    shared.sink.emit(PilotEvent::ItemStarted {
        item: Item::new(id, kind, turn_id).with_body(body),
    });
}

fn complete_item(shared: &Shared, raw: &Value) {
    let Some((id, kind, body)) = item(raw) else {
        return;
    };
    if kind == ItemKind::UserMessage {
        return;
    }
    let turn_id = shared.state.lock().turn.clone();
    let opened = shared.state.lock().open_items.remove(&id);
    if !opened {
        shared.sink.emit(PilotEvent::ItemStarted {
            item: Item::new(id.clone(), kind, turn_id.clone()),
        });
    }
    shared.sink.emit(PilotEvent::ItemCompleted {
        item: Item::new(id, kind, turn_id).with_body(body),
    });
}

fn delta(shared: &Shared, params: &Value) {
    let Some(item_id) = params["itemId"].as_str() else {
        return;
    };
    let Some(text) = params["delta"].as_str() else {
        return;
    };
    if text.is_empty() {
        return;
    }
    shared.sink.emit(PilotEvent::ItemDelta {
        item_id: item_id.to_string(),
        text: text.to_string(),
    });
}

fn complete_turn(shared: &Shared, params: &Value) {
    let status = params["turn"]["status"].as_str().unwrap_or("completed");
    let duration = params["turn"]["durationMs"].as_u64().unwrap_or_else(|| {
        let started = shared.state.lock().turn_started_ms;
        now_ms().saturating_sub(started)
    });
    let (turn, usage, interrupting) = {
        let mut state = shared.state.lock();
        state.provider_turn = None;
        (
            state.turn.take(),
            state.usage.clone(),
            std::mem::take(&mut state.interrupting),
        )
    };
    let Some(turn_id) = turn else { return };
    if status == "completed" && !interrupting {
        shared.sink.emit(PilotEvent::TurnCompleted {
            turn_id,
            duration_ms: duration,
            usage,
        });
    } else {
        let reason = params["turn"]["error"]["message"]
            .as_str()
            .map(str::to_string)
            .or_else(|| Some(status.to_string()));
        shared
            .sink
            .emit(PilotEvent::TurnAborted { turn_id, reason });
    }
    shared.settle_status();
}

fn update_usage(shared: &Shared, params: &Value) {
    let usage = &params["tokenUsage"];
    let last = &usage["last"];
    let snapshot = Usage {
        input_tokens: last["inputTokens"].as_u64().unwrap_or(0),
        output_tokens: last["outputTokens"].as_u64().unwrap_or(0),
        cache_read_input_tokens: last["cachedInputTokens"].as_u64().unwrap_or(0),
        cache_creation_input_tokens: last["cacheWriteInputTokens"].as_u64().unwrap_or(0),
        total_cost_usd: None,
        context_window: usage["modelContextWindow"].as_u64(),
    };
    shared.state.lock().usage = snapshot.clone();
    shared
        .sink
        .emit(PilotEvent::UsageUpdated { usage: snapshot });
}

fn set_model(shared: &Shared, model: &str) {
    let changed = {
        let mut state = shared.state.lock();
        if state.model.as_deref() == Some(model) {
            false
        } else {
            state.model = Some(model.to_string());
            true
        }
    };
    if changed {
        shared.sink.emit(PilotEvent::ModelChanged {
            model: model.to_string(),
        });
    }
}

fn handle_error(shared: &Shared, params: &Value) {
    let message = params["error"]["message"]
        .as_str()
        .unwrap_or("Codex App Server error")
        .to_string();
    let will_retry = params["willRetry"].as_bool().unwrap_or(false);
    let turn_id = shared.state.lock().turn.clone();
    shared.sink.emit(PilotEvent::Error {
        message: message.clone(),
        turn_id,
    });
    if !will_retry {
        let turn = shared.state.lock().turn.take();
        if let Some(turn_id) = turn {
            shared.sink.emit(PilotEvent::TurnAborted {
                turn_id,
                reason: Some(message),
            });
        }
        shared.settle_status();
    }
}

fn item(raw: &Value) -> Option<(String, ItemKind, Value)> {
    let id = raw["id"].as_str()?.to_string();
    let native = raw["type"].as_str().unwrap_or_default();
    let (kind, body) = match native {
        "agentMessage" => (
            ItemKind::AssistantText,
            json!({ "text": raw["text"].as_str().unwrap_or_default() }),
        ),
        "reasoning" => (ItemKind::Reasoning, json!({ "text": reasoning_text(raw) })),
        "plan" => (
            ItemKind::Plan,
            json!({ "text": raw["text"].as_str().unwrap_or_default() }),
        ),
        "userMessage" => (
            ItemKind::UserMessage,
            json!({ "text": content_text(&raw["content"]) }),
        ),
        "commandExecution" => (
            ItemKind::Command,
            json!({
                "name": "Command",
                "input": raw["command"].clone(),
                "command": raw["command"].clone(),
                "output": raw["aggregatedOutput"].clone(),
                "exitCode": raw["exitCode"].clone(),
                "is_error": matches!(raw["status"].as_str(), Some("failed" | "declined")),
            }),
        ),
        "fileChange" => (
            ItemKind::FileChange,
            json!({
                "path": first_change_path(&raw["changes"]),
                "changes": raw["changes"].clone(),
                "status": raw["status"].clone(),
            }),
        ),
        "mcpToolCall" => (
            ItemKind::ToolCall,
            json!({
                "name": format!("{}.{}", raw["server"].as_str().unwrap_or("MCP"), raw["tool"].as_str().unwrap_or("tool")),
                "input": raw["arguments"].clone(),
                "output": raw.get("result").cloned().unwrap_or_else(|| raw["error"].clone()),
                "is_error": raw.get("error").is_some_and(|value| !value.is_null()),
            }),
        ),
        "dynamicToolCall" => (
            ItemKind::ToolCall,
            json!({
                "name": raw["tool"].as_str().unwrap_or("Tool"),
                "input": raw["arguments"].clone(),
                "output": raw["contentItems"].clone(),
                "is_error": raw["success"].as_bool() == Some(false),
            }),
        ),
        "collabAgentToolCall" => (
            ItemKind::ToolCall,
            json!({ "name": raw["tool"].as_str().unwrap_or("Agent"), "input": raw.clone() }),
        ),
        "webSearch" => (
            ItemKind::ToolCall,
            json!({ "name": "WebSearch", "input": raw["query"].clone(), "output": raw["results"].clone() }),
        ),
        "imageView" => (
            ItemKind::ToolCall,
            json!({ "name": "ImageView", "input": raw["path"].clone() }),
        ),
        "contextCompaction" => (
            ItemKind::Notice,
            json!({ "text": "Codex compacted the conversation context" }),
        ),
        _ => return None,
    };
    Some((id, kind, body))
}

fn command_text(params: &Value) -> Option<String> {
    match &params["command"] {
        Value::String(command) => Some(command.clone()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

fn string_at(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value[*key].as_str().map(str::to_string))
}

fn reasoning_text(raw: &Value) -> String {
    let mut parts = Vec::new();
    for key in ["summary", "content"] {
        match &raw[key] {
            Value::String(value) => parts.push(value.clone()),
            Value::Array(values) => {
                parts.extend(
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string)),
                );
            }
            _ => {}
        }
    }
    parts.join("\n")
}

fn content_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .filter_map(|value| value["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn first_change_path(changes: &Value) -> String {
    changes
        .as_array()
        .and_then(|changes| changes.first())
        .and_then(|change| {
            string_at(change, &["path", "filePath"])
                .or_else(|| change["update"]["path"].as_str().map(str::to_string))
        })
        .unwrap_or_default()
}
