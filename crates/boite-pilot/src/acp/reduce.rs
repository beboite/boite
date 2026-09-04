//! Reduction from ACP notifications and client requests to `PilotEvent`.

use serde_json::{json, Value};

use super::{now_ms, NativePermission, PendingKind, PendingRequest, Shared, StreamItem, ToolItem};
use crate::driver::ExecMode;
use crate::event::{
    Item, ItemKind, PilotEvent, Request, RequestKind, RequestOption, RequestQuestion, Usage,
};

pub(super) fn apply_session_setup(shared: &Shared, result: &Value, session_id: &str) {
    let model = result["models"]["currentModelId"]
        .as_str()
        .map(str::to_string)
        .or_else(|| model_from_config(result));
    let model_config_id = result["configOptions"]
        .as_array()
        .and_then(|options| options.iter().find(|option| is_model_config(option)))
        .and_then(|option| option["id"].as_str())
        .map(str::to_string);
    let current_mode_id = result["modes"]["currentModeId"]
        .as_str()
        .map(str::to_string)
        .or_else(|| config_value(result, "mode"));
    let available_mode_ids = result["modes"]["availableModes"]
        .as_array()
        .map(|modes| {
            modes
                .iter()
                .filter_map(|mode| {
                    mode["id"]
                        .as_str()
                        .or_else(|| mode["modeId"].as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    let available_models = available_models(result);
    let mut state = shared.state.lock();
    state.native_session_id = Some(session_id.to_string());
    if let Some(model) = model {
        if state.default_model.is_none() {
            state.default_model = Some(model.clone());
        }
        state.model = Some(model);
    }
    state.model_config_id = model_config_id;
    state.current_mode_id = current_mode_id;
    state.available_mode_ids = available_mode_ids;
    state.available_models = available_models;
}

pub(super) fn apply_config_options(shared: &Shared, result: &Value) {
    let Some(options) = result["configOptions"].as_array() else {
        return;
    };
    let mut state = shared.state.lock();
    if let Some(option) = options.iter().find(|option| is_model_config(option)) {
        state.model_config_id = option["id"].as_str().map(str::to_string);
        if let Some(model) = option["currentValue"].as_str() {
            state.model = Some(model.to_string());
        }
    }
    if let Some(mode) = options
        .iter()
        .find(|option| option["id"].as_str() == Some("mode"))
        .and_then(|option| option["currentValue"].as_str())
    {
        state.current_mode_id = Some(mode.to_string());
    }
}

pub(super) fn resolve_mode_id(shared: &Shared, mode: ExecMode) -> String {
    let state = shared.state.lock();
    let preferred = shared.flavor.mode_id(mode);
    if state.available_mode_ids.is_empty()
        || state
            .available_mode_ids
            .iter()
            .any(|candidate| candidate == preferred)
    {
        return preferred.to_string();
    }
    let aliases: &[&str] = match mode {
        ExecMode::Ask => &["default", "ask", "plan", "approval-required"],
        ExecMode::EditAlone => &["auto_edit", "acceptEdits", "accept_edits"],
        ExecMode::Yolo => &["yolo", "full-access", "force", "auto"],
    };
    aliases
        .iter()
        .find_map(|alias| {
            state
                .available_mode_ids
                .iter()
                .find(|candidate| candidate.eq_ignore_ascii_case(alias))
                .cloned()
        })
        .unwrap_or_else(|| preferred.to_string())
}

pub(super) fn set_model(shared: &Shared, model: &str) {
    let changed = {
        let mut state = shared.state.lock();
        let changed = state.model.as_deref() != Some(model);
        state.model = Some(model.to_string());
        changed
    };
    if changed {
        shared.sink.emit(PilotEvent::ModelChanged {
            model: model.to_string(),
        });
    }
}

pub(super) fn handle_agent_message(shared: &Shared, frame: &Value) -> Option<Value> {
    let method = frame["method"].as_str().unwrap_or_default();
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
    if let Some(id) = frame.get("id").cloned() {
        return match method {
            "session/request_permission" => {
                open_permission(shared, id, params);
                None
            }
            "session/elicitation" => {
                if params["mode"].as_str() == Some("form") {
                    open_elicitation(shared, id, params);
                    None
                } else {
                    Some(error_response(
                        id,
                        -32602,
                        "Boite cannot complete a URL elicitation in the chat pane",
                    ))
                }
            }
            _ => Some(error_response(
                id,
                -32601,
                &format!("unsupported ACP client request {method}"),
            )),
        };
    }
    match method {
        "session/update" => session_update(shared, &params),
        "session/elicitation/complete" => {}
        _ => {}
    }
    None
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

fn open_permission(shared: &Shared, rpc_id: Value, params: Value) {
    let request_id = format!("acp_{}", uuid::Uuid::new_v4());
    let native_options = params["options"]
        .as_array()
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    Some(NativePermission {
                        option_id: option["optionId"].as_str()?.to_string(),
                        kind: option["kind"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let options = params["options"]
        .as_array()
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    Some(RequestOption {
                        value: option["optionId"].as_str()?.to_string(),
                        label: option["name"]
                            .as_str()
                            .unwrap_or_else(|| option["optionId"].as_str().unwrap_or("Option"))
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let tool = &params["toolCall"];
    let title = tool["title"].as_str().map(str::to_string);
    let request = Request {
        id: request_id.clone(),
        kind: RequestKind::ToolApproval,
        tool_name: title.clone().or_else(|| Some("ACP tool".into())),
        tool_use_id: tool["toolCallId"].as_str().map(str::to_string),
        input: tool
            .get("rawInput")
            .cloned()
            .filter(|value| !value.is_null())
            .unwrap_or_else(|| tool.clone()),
        title,
        description: content_text(&tool["content"]),
        options,
        questions: vec![],
        suggestions: Value::Null,
    };
    shared.state.lock().open_requests.insert(
        request_id,
        PendingRequest {
            rpc_id,
            kind: PendingKind::Permission {
                options: native_options,
            },
        },
    );
    shared.sink.emit(PilotEvent::RequestOpened { request });
    shared.settle_status();
}

fn open_elicitation(shared: &Shared, rpc_id: Value, params: Value) {
    let request_id = format!("acp_{}", uuid::Uuid::new_v4());
    let schema = &params["requestedSchema"];
    let questions = schema["properties"]
        .as_object()
        .map(|properties| {
            properties
                .iter()
                .map(|(id, property)| question_from_property(id, property, &params))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let request = Request {
        id: request_id.clone(),
        kind: RequestKind::Question,
        tool_name: None,
        tool_use_id: None,
        input: params.clone(),
        title: schema["title"]
            .as_str()
            .map(str::to_string)
            .or_else(|| Some("ACP input".into())),
        description: params["message"].as_str().map(str::to_string),
        options: questions
            .first()
            .map(|question| question.options.clone())
            .unwrap_or_default(),
        questions,
        suggestions: Value::Null,
    };
    shared.state.lock().open_requests.insert(
        request_id,
        PendingRequest {
            rpc_id,
            kind: PendingKind::Elicitation,
        },
    );
    shared.sink.emit(PilotEvent::RequestOpened { request });
    shared.settle_status();
}

fn question_from_property(id: &str, property: &Value, params: &Value) -> RequestQuestion {
    let enum_values = property["enum"]
        .as_array()
        .or_else(|| property["items"]["enum"].as_array());
    let options: Vec<RequestOption> = enum_values
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(|value| RequestOption {
                    value: value.to_string(),
                    label: value.to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    RequestQuestion {
        id: id.to_string(),
        header: property["title"].as_str().unwrap_or(id).to_string(),
        question: property["description"]
            .as_str()
            .or_else(|| params["message"].as_str())
            .unwrap_or(id)
            .to_string(),
        allow_custom_answer: options.is_empty(),
        secret: matches!(property["format"].as_str(), Some("password" | "secret")),
        multi_select: property["type"].as_str() == Some("array"),
        options,
    }
}

fn session_update(shared: &Shared, params: &Value) {
    let expected = shared.state.lock().native_session_id.clone();
    if expected.as_deref().is_some_and(|expected| {
        params["sessionId"]
            .as_str()
            .is_some_and(|actual| actual != expected)
    }) {
        return;
    }
    let update = &params["update"];
    let kind = update["sessionUpdate"].as_str().unwrap_or_default();
    if shared.state.lock().loading_replay
        && matches!(
            kind,
            "user_message_chunk"
                | "agent_message_chunk"
                | "agent_thought_chunk"
                | "tool_call"
                | "tool_call_update"
                | "plan"
        )
    {
        return;
    }
    match kind {
        "agent_message_chunk" => stream_chunk(shared, update, false),
        "agent_thought_chunk" => stream_chunk(shared, update, true),
        "tool_call" | "tool_call_update" => tool_update(shared, update),
        "plan" => plan_update(shared, update),
        "available_commands_update" => available_commands(shared, update),
        "current_mode_update" => {
            shared.state.lock().current_mode_id =
                update["currentModeId"].as_str().map(str::to_string);
        }
        "config_option_update" => apply_config_options(shared, update),
        "usage_update" => usage_update(shared, update),
        _ => {}
    }
}

fn stream_chunk(shared: &Shared, update: &Value, reasoning: bool) {
    let Some(text) = block_text(&update["content"]) else {
        return;
    };
    if text.is_empty() {
        return;
    }
    let kind = if reasoning {
        ItemKind::Reasoning
    } else {
        ItemKind::AssistantText
    };
    let prefix = if reasoning { "thought" } else { "message" };
    let provider_id = update["messageId"].as_str();
    let (id, turn_id, completed, started) = {
        let mut state = shared.state.lock();
        let turn_id = state.turn.clone();
        let slot = if reasoning {
            &mut state.reasoning
        } else {
            &mut state.assistant
        };
        let id = provider_id
            .map(|provider_id| format!("acp_{prefix}_{provider_id}"))
            .or_else(|| slot.as_ref().map(|item| item.id.clone()))
            .unwrap_or_else(|| format!("acp_{prefix}_{}", uuid::Uuid::new_v4()));
        let completed = if slot.as_ref().is_some_and(|item| item.id != id) {
            slot.take()
        } else {
            None
        };
        let started = slot.is_none();
        if started {
            *slot = Some(StreamItem {
                id: id.clone(),
                kind,
                text: String::new(),
            });
        }
        if let Some(item) = slot.as_mut() {
            item.text.push_str(&text);
        }
        (id, turn_id, completed, started)
    };
    if let Some(item) = completed {
        emit_stream_completed(shared, item, turn_id.clone());
    }
    if started {
        shared.sink.emit(PilotEvent::ItemStarted {
            item: Item::new(id.clone(), kind, turn_id),
        });
    }
    shared
        .sink
        .emit(PilotEvent::ItemDelta { item_id: id, text });
}

fn tool_update(shared: &Shared, update: &Value) {
    close_assistant(shared);
    let Some(id) = update["toolCallId"].as_str().map(str::to_string) else {
        return;
    };
    let turn_id = shared.state.lock().turn.clone();
    let (started, finished, tool) = {
        let mut state = shared.state.lock();
        let started = !state.tools.contains_key(&id);
        let tool = state.tools.entry(id.clone()).or_insert_with(|| ToolItem {
            raw: json!({}),
            kind: item_kind(update["kind"].as_str()),
        });
        merge_non_null(&mut tool.raw, update);
        tool.kind = item_kind(tool.raw["kind"].as_str());
        let finished = matches!(tool.raw["status"].as_str(), Some("completed" | "failed"));
        (started, finished, tool.clone())
    };
    if started {
        shared.sink.emit(PilotEvent::ItemStarted {
            item: Item::new(id.clone(), tool.kind, turn_id.clone()).with_body(tool_body(&tool.raw)),
        });
    }
    if finished {
        shared.state.lock().tools.remove(&id);
        shared.sink.emit(PilotEvent::ItemCompleted {
            item: Item::new(id, tool.kind, turn_id).with_body(tool_body(&tool.raw)),
        });
    }
}

fn plan_update(shared: &Shared, update: &Value) {
    let turn_id = shared.state.lock().turn.clone();
    let id = turn_id
        .as_deref()
        .map(|turn| format!("acp_plan_{turn}"))
        .unwrap_or_else(|| {
            let mut state = shared.state.lock();
            state.plan_seq += 1;
            format!("acp_plan_{}", state.plan_seq)
        });
    let lines = update["entries"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let content = entry["content"].as_str()?;
                    let status = entry["status"].as_str().unwrap_or("pending");
                    Some(format!("[{status}] {content}"))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    shared.sink.emit(PilotEvent::ItemCompleted {
        item: Item::new(id, ItemKind::Plan, turn_id)
            .with_body(json!({ "text": lines, "entries": update["entries"] })),
    });
}

fn available_commands(shared: &Shared, update: &Value) {
    let commands = update["availableCommands"]
        .as_array()
        .map(|commands| {
            commands
                .iter()
                .filter_map(|command| command["name"].as_str())
                .map(|name| name.trim_start_matches('/').to_string())
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    shared.state.lock().slash_commands = commands;
}

fn usage_update(shared: &Shared, update: &Value) {
    let cost = update["cost"]["amount"]
        .as_f64()
        .or_else(|| update["cost"].as_f64());
    let usage = Usage {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        total_cost_usd: cost,
        context_window: update["size"].as_u64(),
    };
    shared.state.lock().usage = usage.clone();
    shared.sink.emit(PilotEvent::UsageUpdated { usage });
}

pub(super) fn complete_prompt(shared: &Shared, result: &Value) {
    close_open_items(shared);
    let usage = prompt_usage(shared, result);
    let (turn, started) = {
        let mut state = shared.state.lock();
        state.usage = usage.clone();
        (state.turn.take(), state.turn_started_ms)
    };
    let Some(turn_id) = turn else { return };
    shared.sink.emit(PilotEvent::UsageUpdated {
        usage: usage.clone(),
    });
    let stop_reason = result["stopReason"].as_str().unwrap_or("end_turn");
    if stop_reason == "cancelled" {
        shared.sink.emit(PilotEvent::TurnAborted {
            turn_id,
            reason: Some("cancelled".into()),
        });
    } else {
        shared.sink.emit(PilotEvent::TurnCompleted {
            turn_id,
            duration_ms: now_ms().saturating_sub(started),
            usage,
        });
    }
    shared.settle_status();
}

pub(super) fn abort_turn(shared: &Shared, reason: String) {
    close_open_items(shared);
    let turn = shared.state.lock().turn.take();
    if let Some(turn_id) = turn {
        shared.sink.emit(PilotEvent::TurnAborted {
            turn_id,
            reason: Some(reason),
        });
    }
    shared.settle_status();
}

fn close_open_items(shared: &Shared) {
    let (assistant, reasoning, tools, turn_id) = {
        let mut state = shared.state.lock();
        (
            state.assistant.take(),
            state.reasoning.take(),
            std::mem::take(&mut state.tools),
            state.turn.clone(),
        )
    };
    if let Some(item) = assistant {
        emit_stream_completed(shared, item, turn_id.clone());
    }
    if let Some(item) = reasoning {
        emit_stream_completed(shared, item, turn_id.clone());
    }
    for (id, tool) in tools {
        shared.sink.emit(PilotEvent::ItemCompleted {
            item: Item::new(id, tool.kind, turn_id.clone()).with_body(tool_body(&tool.raw)),
        });
    }
}

fn close_assistant(shared: &Shared) {
    let (assistant, turn_id) = {
        let mut state = shared.state.lock();
        (state.assistant.take(), state.turn.clone())
    };
    if let Some(item) = assistant {
        emit_stream_completed(shared, item, turn_id);
    }
}

fn emit_stream_completed(shared: &Shared, item: StreamItem, turn_id: Option<String>) {
    shared.sink.emit(PilotEvent::ItemCompleted {
        item: Item::new(item.id, item.kind, turn_id).with_body(json!({ "text": item.text })),
    });
}

fn prompt_usage(shared: &Shared, result: &Value) -> Usage {
    let raw = &result["usage"];
    let context = shared.state.lock().usage.context_window;
    Usage {
        input_tokens: raw["inputTokens"].as_u64().unwrap_or(0),
        output_tokens: raw["outputTokens"].as_u64().unwrap_or(0),
        cache_read_input_tokens: raw["cachedReadTokens"].as_u64().unwrap_or(0),
        cache_creation_input_tokens: raw["cachedWriteTokens"].as_u64().unwrap_or(0),
        total_cost_usd: shared.state.lock().usage.total_cost_usd,
        context_window: context,
    }
}

fn tool_body(raw: &Value) -> Value {
    let location = raw["locations"]
        .as_array()
        .and_then(|locations| locations.first())
        .and_then(|location| location["path"].as_str())
        .unwrap_or_default();
    json!({
        "name": raw["title"].as_str().unwrap_or("ACP tool"),
        "input": raw.get("rawInput").cloned().unwrap_or(Value::Null),
        "output": raw.get("rawOutput").cloned().unwrap_or_else(|| raw["content"].clone()),
        "status": raw["status"],
        "path": location,
        "locations": raw["locations"],
        "is_error": raw["status"].as_str() == Some("failed"),
    })
}

fn item_kind(kind: Option<&str>) -> ItemKind {
    match kind {
        Some("execute") => ItemKind::Command,
        Some("edit" | "delete" | "move") => ItemKind::FileChange,
        _ => ItemKind::ToolCall,
    }
}

fn merge_non_null(target: &mut Value, update: &Value) {
    let object = target.as_object_mut().expect("tool state starts as object");
    if let Some(fields) = update.as_object() {
        for (key, value) in fields {
            if !value.is_null() {
                object.insert(key.clone(), value.clone());
            }
        }
    }
}

fn block_text(content: &Value) -> Option<String> {
    match content["type"].as_str() {
        Some("text") => content["text"].as_str().map(str::to_string),
        Some("resource_link") => Some(format!(
            "{} ({})",
            content["name"].as_str().unwrap_or("resource"),
            content["uri"].as_str().unwrap_or_default()
        )),
        Some("image") => Some(format!(
            "[image: {}]",
            content["mimeType"].as_str().unwrap_or("unknown")
        )),
        Some("audio") => Some(format!(
            "[audio: {}]",
            content["mimeType"].as_str().unwrap_or("unknown")
        )),
        _ => None,
    }
}

fn content_text(content: &Value) -> Option<String> {
    let values = content.as_array()?;
    let text = values
        .iter()
        .filter_map(block_text)
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn is_model_config(option: &Value) -> bool {
    option["id"].as_str() == Some("model") || option["category"].as_str() == Some("model")
}

fn model_from_config(result: &Value) -> Option<String> {
    result["configOptions"]
        .as_array()?
        .iter()
        .find(|option| is_model_config(option))?["currentValue"]
        .as_str()
        .map(str::to_string)
}

fn config_value(result: &Value, id: &str) -> Option<String> {
    result["configOptions"]
        .as_array()?
        .iter()
        .find(|option| option["id"].as_str() == Some(id))?["currentValue"]
        .as_str()
        .map(str::to_string)
}

fn available_models(result: &Value) -> Vec<String> {
    let mut models = result["models"]["availableModels"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model["modelId"].as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(options) = result["configOptions"]
        .as_array()
        .and_then(|options| options.iter().find(|option| is_model_config(option)))
        .and_then(|option| option["options"].as_array())
    {
        models.extend(options.iter().flat_map(config_option_values));
    }
    models.sort();
    models.dedup();
    models
}

fn config_option_values(option: &Value) -> Vec<String> {
    if let Some(value) = option["value"].as_str() {
        return vec![value.to_string()];
    }
    option["options"]
        .as_array()
        .map(|options| options.iter().flat_map(config_option_values).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_tool_updates_keep_existing_fields() {
        let mut raw = json!({ "title": "Run", "kind": "execute", "rawInput": {"cmd":"ok"} });
        merge_non_null(&mut raw, &json!({ "status": "completed", "title": null }));
        assert_eq!(raw["title"], "Run");
        assert_eq!(raw["status"], "completed");
        assert_eq!(item_kind(raw["kind"].as_str()), ItemKind::Command);
    }

    #[test]
    fn form_enum_becomes_an_opaque_multi_select() {
        let question = question_from_property(
            "targets",
            &json!({
                "type": "array",
                "title": "Targets",
                "items": { "enum": ["web", "desktop"] }
            }),
            &json!({ "message": "Pick targets" }),
        );
        assert!(question.multi_select);
        assert_eq!(question.options[1].value, "desktop");
    }
}
