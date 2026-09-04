//! Reduction from OpenCode's SSE events to Boite's canonical event stream.

use serde_json::{json, Value};

use super::{now_ms, PendingRequest, Shared, StreamPart};
use crate::event::{
    Item, ItemKind, PilotEvent, Request, RequestKind, RequestOption, RequestQuestion, Status,
};

pub(super) fn handle_event(shared: &Shared, event: &Value) {
    let event_type = event["type"].as_str().unwrap_or_default();
    update_related_sessions(shared, event_type, event);
    let relation = event_relation(shared, event);
    let child_request = matches!(
        event_type,
        "permission.asked"
            | "permission.replied"
            | "question.asked"
            | "question.replied"
            | "question.rejected"
    );
    if event_type != "server.connected"
        && !matches!(relation, Relation::Parent)
        && !(matches!(relation, Relation::Child) && child_request)
    {
        return;
    }
    match event_type {
        "message.updated" => message_updated(shared, &event["properties"]["info"]),
        "message.part.updated" => part_updated(shared, &event["properties"]["part"]),
        "message.part.delta" => part_delta(shared, &event["properties"]),
        "permission.asked" => permission_asked(shared, &event["properties"]),
        "permission.replied" => request_terminal(
            shared,
            &event["properties"],
            event["properties"]["reply"] == "reject",
        ),
        "question.asked" => question_asked(shared, &event["properties"]),
        "question.replied" => request_terminal(shared, &event["properties"], false),
        "question.rejected" => request_terminal(shared, &event["properties"], true),
        "todo.updated" => todos_updated(shared, &event["properties"]),
        "session.status" => session_status(shared, &event["properties"]),
        "session.idle" if shared.state.lock().turn_saw_busy => complete_turn(shared),
        "session.error" => session_error(shared, &event["properties"]),
        _ => {}
    }
}

#[derive(Clone, Copy)]
enum Relation {
    Parent,
    Child,
    Other,
}

fn event_relation(shared: &Shared, event: &Value) -> Relation {
    let state = shared.state.lock();
    let session_id = event["properties"]["sessionID"]
        .as_str()
        .or_else(|| event["properties"]["info"]["sessionID"].as_str())
        .or_else(|| event["properties"]["part"]["sessionID"].as_str());
    if state.native_session_id.as_deref() == session_id {
        Relation::Parent
    } else if session_id.is_some_and(|id| state.related_session_ids.contains(id)) {
        Relation::Child
    } else {
        Relation::Other
    }
}

fn update_related_sessions(shared: &Shared, event_type: &str, event: &Value) {
    match event_type {
        "session.created" | "session.updated" => {
            let info = &event["properties"]["info"];
            let Some(id) = info["id"].as_str() else {
                return;
            };
            let Some(parent) = info["parentID"].as_str() else {
                return;
            };
            let mut state = shared.state.lock();
            if state.related_session_ids.contains(parent) {
                state.related_session_ids.insert(id.to_string());
            }
        }
        "session.deleted" => {
            if let Some(id) = event["properties"]["info"]["id"].as_str() {
                shared.state.lock().related_session_ids.remove(id);
            }
        }
        _ => {}
    }
}

fn message_updated(shared: &Shared, info: &Value) {
    let Some(id) = info["id"].as_str() else {
        return;
    };
    let Some(role) = info["role"].as_str() else {
        return;
    };
    shared
        .state
        .lock()
        .message_roles
        .insert(id.to_string(), role.to_string());
    if role != "assistant" {
        return;
    }
    if let (Some(provider), Some(model)) = (info["providerID"].as_str(), info["modelID"].as_str()) {
        set_model(shared, &format!("{provider}/{model}"));
    }
    let parts = {
        let state = shared.state.lock();
        state
            .parts
            .values()
            .filter(|part| part.message_id == id)
            .cloned()
            .collect::<Vec<_>>()
    };
    for part in parts {
        emit_stream_part(shared, part);
    }
}

fn part_updated(shared: &Shared, raw: &Value) {
    let Some(id) = raw["id"].as_str().map(str::to_string) else {
        return;
    };
    match raw["type"].as_str().unwrap_or_default() {
        "text" | "reasoning" => {
            let kind = if raw["type"] == "reasoning" {
                ItemKind::Reasoning
            } else {
                ItemKind::AssistantText
            };
            let part = StreamPart {
                id: id.clone(),
                message_id: raw["messageID"].as_str().unwrap_or_default().to_string(),
                kind,
                text: raw["text"].as_str().unwrap_or_default().to_string(),
                completed: raw["time"]["end"].is_number(),
            };
            let assistant = {
                let mut state = shared.state.lock();
                let assistant = state
                    .message_roles
                    .get(&part.message_id)
                    .map(String::as_str)
                    == Some("assistant");
                state.parts.insert(id, part.clone());
                assistant
            };
            if assistant {
                emit_stream_part(shared, part);
            }
        }
        "tool" => tool_updated(shared, raw),
        "step-finish" => usage_updated(shared, raw),
        "patch" => patch_updated(shared, raw),
        _ => {}
    }
}

fn emit_stream_part(shared: &Shared, part: StreamPart) {
    let (turn_id, prior, opened, already_completed) = {
        let mut state = shared.state.lock();
        let prior = state
            .emitted_text
            .get(&part.id)
            .cloned()
            .unwrap_or_default();
        let opened = state.open_items.insert(part.id.clone());
        let already_completed = state.completed_items.contains(&part.id);
        state
            .emitted_text
            .insert(part.id.clone(), part.text.clone());
        (state.turn.clone(), prior, opened, already_completed)
    };
    if opened {
        shared.sink.emit(PilotEvent::ItemStarted {
            item: Item::new(part.id.clone(), part.kind, turn_id.clone()),
        });
    }
    let delta = appended_text(&prior, &part.text);
    if !delta.is_empty() {
        shared.sink.emit(PilotEvent::ItemDelta {
            item_id: part.id.clone(),
            text: delta,
        });
    }
    if part.completed && !already_completed {
        shared.state.lock().completed_items.insert(part.id.clone());
        shared.sink.emit(PilotEvent::ItemCompleted {
            item: Item::new(part.id, part.kind, turn_id).with_body(json!({ "text": part.text })),
        });
    }
}

fn part_delta(shared: &Shared, properties: &Value) {
    if properties["field"].as_str() != Some("text") {
        return;
    }
    let Some(id) = properties["partID"].as_str() else {
        return;
    };
    let Some(delta) = properties["delta"].as_str().filter(|text| !text.is_empty()) else {
        return;
    };
    let assistant = {
        let mut state = shared.state.lock();
        let message_id = state.parts.get(id).map(|part| part.message_id.clone());
        let assistant = message_id.as_ref().is_some_and(|message_id| {
            state.message_roles.get(message_id).map(String::as_str) == Some("assistant")
        });
        if assistant {
            if let Some(part) = state.parts.get_mut(id) {
                part.text.push_str(delta);
            }
            state
                .emitted_text
                .entry(id.to_string())
                .or_default()
                .push_str(delta);
        }
        assistant
    };
    if assistant {
        shared.sink.emit(PilotEvent::ItemDelta {
            item_id: id.to_string(),
            text: delta.to_string(),
        });
    }
}

fn tool_updated(shared: &Shared, raw: &Value) {
    let Some(id) = raw["callID"].as_str().or_else(|| raw["id"].as_str()) else {
        return;
    };
    let tool = raw["tool"].as_str().unwrap_or("tool");
    let status = raw["state"]["status"].as_str().unwrap_or("pending");
    let input = raw["state"]["input"].clone();
    let kind = if input["command"].is_string() || matches!(tool, "bash" | "shell") {
        ItemKind::Command
    } else if matches!(tool, "edit" | "write" | "patch" | "apply_patch") {
        ItemKind::FileChange
    } else {
        ItemKind::ToolCall
    };
    let turn_id = shared.state.lock().turn.clone();
    let first = shared.state.lock().open_items.insert(id.to_string());
    if first {
        shared.sink.emit(PilotEvent::ItemStarted {
            item: Item::new(id, kind, turn_id.clone()).with_body(json!({
                "tool_name": tool,
                "input": input
            })),
        });
    }
    if matches!(status, "completed" | "error")
        && shared.state.lock().completed_items.insert(id.to_string())
    {
        shared.sink.emit(PilotEvent::ItemCompleted {
            item: Item::new(id, kind, turn_id).with_body(json!({
                "tool_name": tool,
                "input": input,
                "status": status,
                "output": raw["state"]["output"],
                "error": raw["state"]["error"]
            })),
        });
    }
}

fn patch_updated(shared: &Shared, raw: &Value) {
    let Some(id) = raw["id"].as_str() else {
        return;
    };
    let turn_id = shared.state.lock().turn.clone();
    if shared.state.lock().completed_items.insert(id.to_string()) {
        shared.sink.emit(PilotEvent::ItemStarted {
            item: Item::new(id, ItemKind::FileChange, turn_id.clone()),
        });
        shared.sink.emit(PilotEvent::ItemCompleted {
            item: Item::new(id, ItemKind::FileChange, turn_id).with_body(json!({
                "files": raw["files"],
                "hash": raw["hash"]
            })),
        });
    }
}

fn usage_updated(shared: &Shared, raw: &Value) {
    let Some(id) = raw["id"].as_str() else {
        return;
    };
    let usage = {
        let mut state = shared.state.lock();
        if !state.completed_items.insert(id.to_string()) {
            return;
        }
        state.usage.input_tokens += number(&raw["tokens"]["input"]);
        state.usage.output_tokens += number(&raw["tokens"]["output"]);
        state.usage.cache_read_input_tokens += number(&raw["tokens"]["cache"]["read"]);
        state.usage.cache_creation_input_tokens += number(&raw["tokens"]["cache"]["write"]);
        let cost = raw["cost"].as_f64().unwrap_or(0.0);
        state.usage.total_cost_usd = Some(state.usage.total_cost_usd.unwrap_or(0.0) + cost);
        state.usage.clone()
    };
    shared.sink.emit(PilotEvent::UsageUpdated { usage });
}

fn permission_asked(shared: &Shared, raw: &Value) {
    let Some(id) = raw["id"].as_str().map(str::to_string) else {
        return;
    };
    if shared.state.lock().open_requests.contains_key(&id) {
        return;
    }
    let permission = raw["permission"].as_str().unwrap_or("tool");
    let description = raw["patterns"].as_array().map(|patterns| {
        patterns
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    });
    shared
        .state
        .lock()
        .open_requests
        .insert(id.clone(), PendingRequest::Permission);
    shared.sink.emit(PilotEvent::RequestOpened {
        request: Request {
            id,
            kind: RequestKind::ToolApproval,
            tool_name: Some(permission.to_string()),
            tool_use_id: raw["tool"]["callID"].as_str().map(str::to_string),
            input: raw.clone(),
            title: Some(format!("OpenCode wants to use {permission}")),
            description,
            options: vec![
                RequestOption {
                    value: "once".into(),
                    label: "Allow".into(),
                },
                RequestOption {
                    value: "always".into(),
                    label: "Always allow".into(),
                },
                RequestOption {
                    value: "reject".into(),
                    label: "Deny".into(),
                },
            ],
            questions: vec![],
            suggestions: raw["always"].clone(),
        },
    });
    shared.settle_status();
}

fn question_asked(shared: &Shared, raw: &Value) {
    let Some(id) = raw["id"].as_str().map(str::to_string) else {
        return;
    };
    if shared.state.lock().open_requests.contains_key(&id) {
        return;
    }
    let questions = raw["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, question)| {
            let prompt = question["question"].as_str()?.trim();
            let header = question["header"].as_str().unwrap_or("Question").trim();
            let native_id = question_id(index, header);
            let options = question["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    let label = option["label"].as_str()?.trim();
                    (!label.is_empty()).then(|| RequestOption {
                        value: label.to_string(),
                        label: label.to_string(),
                    })
                })
                .collect();
            Some(RequestQuestion {
                id: native_id,
                header: header.to_string(),
                question: prompt.to_string(),
                options,
                allow_custom_answer: question["custom"].as_bool().unwrap_or(true),
                secret: false,
                multi_select: question["multiple"].as_bool().unwrap_or(false),
            })
        })
        .collect::<Vec<_>>();
    let question_ids = questions
        .iter()
        .map(|question| question.id.clone())
        .collect();
    let options = questions
        .first()
        .map(|question| question.options.clone())
        .unwrap_or_default();
    let title = questions.first().map(|question| question.header.clone());
    let description = questions.first().map(|question| question.question.clone());
    shared
        .state
        .lock()
        .open_requests
        .insert(id.clone(), PendingRequest::Question { question_ids });
    shared.sink.emit(PilotEvent::RequestOpened {
        request: Request {
            id,
            kind: RequestKind::Question,
            tool_name: None,
            tool_use_id: raw["tool"]["callID"].as_str().map(str::to_string),
            input: raw.clone(),
            title,
            description,
            options,
            questions,
            suggestions: Value::Null,
        },
    });
    shared.settle_status();
}

fn question_id(index: usize, header: &str) -> String {
    let slug = header
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if slug.is_empty() {
        format!("question-{index}")
    } else {
        format!("question-{index}-{slug}")
    }
}

fn request_terminal(shared: &Shared, raw: &Value, denied: bool) {
    let Some(id) = raw["requestID"].as_str() else {
        return;
    };
    if shared.state.lock().open_requests.remove(id).is_some() {
        shared.sink.emit(PilotEvent::RequestResolved {
            request_id: id.to_string(),
            outcome: if denied {
                crate::event::RequestOutcome::Denied
            } else {
                crate::event::RequestOutcome::Allowed
            },
        });
        shared.settle_status();
    }
}

fn todos_updated(shared: &Shared, raw: &Value) {
    let (turn_id, id) = {
        let mut state = shared.state.lock();
        let turn = state.turn.clone();
        state.plan_seq += 1;
        (turn, format!("opencode-plan-{}", state.plan_seq))
    };
    let Some(turn_id) = turn_id else { return };
    let entries = raw["todos"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|todo| todo["status"].as_str() != Some("cancelled"))
        .map(|todo| {
            json!({
                "step": todo["content"],
                "status": match todo["status"].as_str() {
                    Some("completed") => "completed",
                    Some("in_progress") => "in_progress",
                    _ => "pending"
                }
            })
        })
        .collect::<Vec<_>>();
    shared.sink.emit(PilotEvent::ItemStarted {
        item: Item::new(id.clone(), ItemKind::Plan, Some(turn_id.clone())),
    });
    shared.sink.emit(PilotEvent::ItemCompleted {
        item: Item::new(id, ItemKind::Plan, Some(turn_id)).with_body(json!({ "entries": entries })),
    });
}

fn session_status(shared: &Shared, raw: &Value) {
    match raw["status"]["type"].as_str() {
        Some("busy") | Some("retry") => {
            shared.state.lock().turn_saw_busy = true;
            shared.set_status(Status::Busy);
        }
        Some("idle") if shared.state.lock().turn_saw_busy => complete_turn(shared),
        _ => {}
    }
}

pub(super) fn complete_turn(shared: &Shared) {
    let (turn_id, started, usage) = {
        let mut state = shared.state.lock();
        if state.interrupting {
            state.deferred_idle = true;
            return;
        }
        if state.compacting {
            return;
        }
        state.deferred_idle = false;
        let Some(turn_id) = state.turn.take() else {
            drop(state);
            shared.settle_status();
            return;
        };
        (turn_id, state.turn_started_ms, state.usage.clone())
    };
    shared.sink.emit(PilotEvent::TurnCompleted {
        turn_id,
        duration_ms: now_ms().saturating_sub(started),
        usage,
    });
    shared.settle_status();
}

fn session_error(shared: &Shared, raw: &Value) {
    let message = raw["error"]["data"]["message"]
        .as_str()
        .or_else(|| raw["error"]["message"].as_str())
        .unwrap_or("OpenCode session error")
        .to_string();
    let turn_id = shared.state.lock().turn.take();
    shared.sink.emit(PilotEvent::Error {
        message: message.clone(),
        turn_id: turn_id.clone(),
    });
    if let Some(turn_id) = turn_id {
        shared.sink.emit(PilotEvent::TurnAborted {
            turn_id,
            reason: Some(message),
        });
    }
    shared.settle_status();
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

fn appended_text(previous: &str, next: &str) -> String {
    next.strip_prefix(previous).unwrap_or(next).to_string()
}

fn number(value: &Value) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_f64().map(|value| value.max(0.0) as u64))
        .unwrap_or(0)
}
