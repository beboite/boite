#!/usr/bin/env node
// ACP 1 JSONL fake. It exercises Boite's transport without reading an account
// or contacting a model.

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

let sessionId = "native-acp";
let model = "acp-default";
let mode = "default";
let promptId = null;
let permissionId = null;
let elicitationId = null;

function write(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
}

function result(id, value = {}) {
  write({ id, result: value });
}

function update(value) {
  write({
    method: "session/update",
    params: { sessionId, update: value },
  });
}

function setup(extra = {}) {
  return {
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: model,
        options: [
          { value: "acp-default", name: "ACP default" },
          { value: "grok-test", name: "Grok test" },
          { value: "cursor-test", name: "Cursor test" },
        ],
      },
      {
        id: "mode",
        name: "Mode",
        type: "select",
        currentValue: mode,
        options: [
          { value: "default", name: "Default" },
          { value: "acceptEdits", name: "Accept edits" },
          { value: "auto_edit", name: "Auto edit" },
          { value: "yolo", name: "Yolo" },
        ],
      },
    ],
    models: {
      currentModelId: model,
      availableModels: [
        { modelId: "acp-default", name: "ACP default" },
        { modelId: "grok-test", name: "Grok test" },
      ],
    },
    modes: {
      currentModeId: mode,
      availableModes: [
        { id: "default", name: "Default" },
        { id: "acceptEdits", name: "Accept edits" },
        { id: "auto_edit", name: "Auto edit" },
        { id: "yolo", name: "Yolo" },
      ],
    },
    ...extra,
  };
}

function assistant(text) {
  const messageId = randomUUID();
  for (const delta of text) {
    update({
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: delta },
    });
  }
}

function finish(reason = "end_turn") {
  if (promptId === null) return;
  const id = promptId;
  promptId = null;
  update({
    sessionUpdate: "usage_update",
    used: 210,
    size: 128000,
    cost: { amount: 0.01, currency: "USD" },
  });
  result(id, {
    stopReason: reason,
    usage: {
      inputTokens: 21,
      outputTokens: 8,
      cachedReadTokens: 5,
      cachedWriteTokens: 2,
      totalTokens: 29,
    },
  });
}

function plainTurn(prompt) {
  const thoughtId = randomUUID();
  update({
    sessionUpdate: "agent_thought_chunk",
    messageId: thoughtId,
    content: { type: "text", text: "checking" },
  });
  const toolCallId = `tool-${randomUUID()}`;
  update({
    sessionUpdate: "tool_call",
    toolCallId,
    title: "Read status",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "git status" },
  });
  update({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    rawOutput: "clean",
  });
  update({
    sessionUpdate: "plan",
    entries: [
      { content: "Inspect", priority: "high", status: "completed" },
      { content: "Answer", priority: "medium", status: "in_progress" },
    ],
  });
  assistant(prompt === "settings" ? `${model}:${mode}` : "ok");
  finish();
}

function askPermission() {
  permissionId = `permission-${randomUUID()}`;
  write({
    id: permissionId,
    method: "session/request_permission",
    params: {
      sessionId,
      options: [
        { optionId: "native-once", name: "Allow once", kind: "allow_once" },
        { optionId: "native-always", name: "Always allow", kind: "allow_always" },
        { optionId: "native-reject", name: "Reject", kind: "reject_once" },
      ],
      toolCall: {
        toolCallId: "permission-tool",
        title: "Run tests",
        kind: "execute",
        rawInput: { command: "cargo test" },
        status: "pending",
      },
    },
  });
}

function elicit() {
  elicitationId = `elicitation-${randomUUID()}`;
  write({
    id: elicitationId,
    method: "session/elicitation",
    params: {
      sessionId,
      mode: "form",
      message: "Choose deployment details",
      requestedSchema: {
        type: "object",
        title: "Deployment",
        required: ["targets", "note"],
        properties: {
          targets: {
            type: "array",
            title: "Targets",
            description: "Where should this run?",
            items: { type: "string", enum: ["web", "desktop"] },
          },
          note: {
            type: "string",
            title: "Note",
            description: "Add a note",
          },
        },
      },
    },
  });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);

  if (frame.method === "initialize" && frame.id !== undefined) {
    result(frame.id, {
      protocolVersion: 1,
      agentInfo: { name: "fake-acp", version: "1.0.0" },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: true },
      },
      authMethods: [
        { id: "cursor_login", name: "Cursor" },
        { id: "cached_token", name: "Grok" },
        { id: "xai.api_key", name: "Grok API key" },
        { id: "oauth-personal", name: "Google" },
      ],
    });
    return;
  }
  if (frame.method === "authenticate" && frame.id !== undefined) {
    result(frame.id);
    return;
  }
  if (frame.method === "session/new" && frame.id !== undefined) {
    update({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "/compact", description: "Compact context" }],
    });
    result(frame.id, setup({ sessionId }));
    return;
  }
  if (frame.method === "session/load" && frame.id !== undefined) {
    sessionId = frame.params.sessionId;
    model = "loaded-model";
    assistant("replayed history");
    result(frame.id, setup());
    return;
  }
  if (frame.method === "session/resume" && frame.id !== undefined) {
    sessionId = frame.params.sessionId;
    model = "resumed-model";
    result(frame.id, setup());
    return;
  }
  if (frame.method === "session/set_model" && frame.id !== undefined) {
    model = frame.params.modelId;
    result(frame.id, setup());
    return;
  }
  if (frame.method === "session/set_config_option" && frame.id !== undefined) {
    if (frame.params.configId === "model") model = frame.params.value;
    if (frame.params.configId === "mode") mode = frame.params.value;
    result(frame.id, setup());
    return;
  }
  if (frame.method === "session/prompt" && frame.id !== undefined) {
    promptId = frame.id;
    const prompt = (frame.params.prompt ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (prompt === "approve") askPermission();
    else if (prompt === "elicit") elicit();
    else if (prompt !== "hang") plainTurn(prompt);
    return;
  }
  if (frame.method === "session/cancel" && frame.id === undefined) {
    finish("cancelled");
    return;
  }
  if (frame.id !== undefined && frame.result !== undefined) {
    if (frame.id === permissionId) {
      const selected = frame.result.outcome?.optionId ?? frame.result.outcome?.outcome ?? "missing";
      permissionId = null;
      assistant(selected);
      finish();
    } else if (frame.id === elicitationId) {
      const content = frame.result.action?.content ?? {};
      elicitationId = null;
      assistant(`${(content.targets ?? []).join("+")}:${content.note ?? ""}`);
      finish();
    }
  }
});

lines.on("close", () => process.exit(0));
