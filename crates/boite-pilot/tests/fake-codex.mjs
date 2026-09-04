#!/usr/bin/env node
// Minimal Codex App Server used by the Rust wire tests. It speaks JSON-RPC
// JSONL on stdio and never contacts a model or reads Codex credentials.

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const resumed = argv.includes("--resume-test");
let nativeThreadId = resumed ? "native-resumed" : "native-codex";
let currentTurn = null;
const pending = new Map();

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function result(id, value) {
  write({ id, result: value });
}

function notification(method, params) {
  write({ method, params });
}

function turn(id, status = "inProgress", extra = {}) {
  return { id, items: [], status, ...extra };
}

function complete(turnId, status = "completed", error = null) {
  notification("thread/tokenUsage/updated", {
    threadId: nativeThreadId,
    turnId,
    tokenUsage: {
      last: {
        inputTokens: 11,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 2,
        outputTokens: 7,
        reasoningOutputTokens: 1,
        totalTokens: 18,
      },
      total: {
        inputTokens: 11,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 2,
        outputTokens: 7,
        reasoningOutputTokens: 1,
        totalTokens: 18,
      },
      modelContextWindow: 200000,
    },
  });
  notification("turn/completed", {
    threadId: nativeThreadId,
    turn: turn(turnId, status, { durationMs: 42, error }),
  });
  currentTurn = null;
}

function assistant(turnId, text = "ok") {
  const itemId = `item_${randomUUID()}`;
  const base = { threadId: nativeThreadId, turnId };
  notification("item/started", {
    ...base,
    startedAtMs: Date.now(),
    item: { id: itemId, type: "agentMessage", text: "" },
  });
  for (const delta of text) {
    notification("item/agentMessage/delta", { ...base, itemId, delta });
  }
  notification("item/completed", {
    ...base,
    completedAtMs: Date.now(),
    item: { id: itemId, type: "agentMessage", text },
  });
}

function command(turnId) {
  const itemId = `cmd_${randomUUID()}`;
  const base = { threadId: nativeThreadId, turnId };
  notification("item/started", {
    ...base,
    startedAtMs: Date.now(),
    item: {
      id: itemId,
      type: "commandExecution",
      command: "git status",
      commandActions: [],
      cwd: process.cwd(),
      status: "inProgress",
      aggregatedOutput: "",
    },
  });
  const rpcId = `approval_${randomUUID()}`;
  pending.set(rpcId, { kind: "approval", turnId, itemId });
  write({
    id: rpcId,
    method: "item/commandExecution/requestApproval",
    params: {
      approvalId: itemId,
      command: "git status",
      cwd: process.cwd(),
      itemId,
      reason: "inspect the worktree",
      startedAtMs: Date.now(),
      threadId: nativeThreadId,
      turnId,
    },
  });
}

function question(turnId, multiple = false) {
  const itemId = `question_${randomUUID()}`;
  const rpcId = `question_rpc_${randomUUID()}`;
  pending.set(rpcId, { kind: "question", turnId, itemId });
  write({
    id: rpcId,
    method: "item/tool/requestUserInput",
    params: {
      isBlocking: true,
      itemId,
      threadId: nativeThreadId,
      turnId,
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Which target?",
          options: [
            { label: "Desktop", description: "Build the desktop target" },
            { label: "Server", description: "Build the server target" },
          ],
        },
        ...(multiple
          ? [
              {
                id: "reason",
                header: "Reason",
                question: "Why this target?",
                options: null,
                isOther: true,
              },
            ]
          : []),
      ],
    },
  });
}

function startTurn(id, params) {
  const turnId = `turn_${randomUUID()}`;
  currentTurn = turnId;
  result(id, { turn: turn(turnId) });
  notification("turn/started", { threadId: nativeThreadId, turn: turn(turnId) });
  const prompt = (params.input ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (prompt === "approve") {
    command(turnId);
  } else if (prompt === "question") {
    question(turnId);
  } else if (prompt === "questions") {
    question(turnId, true);
  } else if (prompt === "hang") {
    assistant(turnId, "waiting");
  } else if (prompt === "crash") {
    process.exit(7);
  } else {
    assistant(turnId);
    complete(turnId);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);

  if (frame.method === "initialize" && frame.id !== undefined) {
    result(frame.id, {
      codexHome: "fake",
      platformFamily: "windows",
      platformOs: "windows",
      userAgent: "fake-codex/0.153.2",
    });
    return;
  }
  if (frame.method === "initialized") return;
  if (frame.method === "model/list") {
    if (argv.includes("--no-model-list")) {
      write({ id: frame.id, error: { code: -32601, message: "Method not found" } });
    } else if (frame.params.cursor == null) {
      result(frame.id, { data: [
        { id: "picker-id", model: "live-model-a" },
        { id: "hidden", model: "hidden-model", hidden: true },
      ], nextCursor: "page-2" });
    } else {
      result(frame.id, { data: [
        { id: "duplicate", model: "live-model-a" }, { id: "live-model-b" },
      ], nextCursor: argv.includes("--cyclic-model-list") ? "page-2" : null });
    }
    return;
  }
  if ((frame.method === "thread/start" || frame.method === "thread/resume") && frame.id !== undefined) {
    nativeThreadId = frame.method === "thread/resume" ? frame.params.threadId : nativeThreadId;
    result(frame.id, {
      thread: {
        id: nativeThreadId,
        model: frame.params.model ?? "gpt-test",
        cliVersion: "0.153.2-fake",
      },
      cwd: frame.params.cwd ?? process.cwd(),
      model: frame.params.model ?? "gpt-test",
      modelProvider: "openai",
      approvalPolicy: frame.params.approvalPolicy,
      approvalsReviewer: frame.params.approvalsReviewer,
      sandbox: frame.params.sandbox,
    });
    notification("thread/started", {
      thread: { id: nativeThreadId, model: frame.params.model ?? "gpt-test" },
    });
    return;
  }
  if (frame.method === "turn/start" && frame.id !== undefined) {
    startTurn(frame.id, frame.params);
    return;
  }
  if (frame.method === "thread/compact/start" && frame.id !== undefined) {
    const turnId = `compact_${randomUUID()}`;
    currentTurn = turnId;
    result(frame.id, {});
    notification("turn/started", { threadId: nativeThreadId, turn: turn(turnId) });
    notification("item/completed", {
      threadId: nativeThreadId,
      turnId,
      item: { id: `compaction_${randomUUID()}`, type: "contextCompaction" },
    });
    complete(turnId);
    return;
  }
  if (frame.method === "turn/interrupt" && frame.id !== undefined) {
    const interrupted = currentTurn;
    result(frame.id, {});
    if (interrupted) complete(interrupted, "interrupted");
    return;
  }
  if (frame.method === "turn/steer" && frame.id !== undefined) {
    if (!currentTurn || frame.params.expectedTurnId !== currentTurn || frame.params.input[0].text === "reject-steer") {
      write({ id: frame.id, error: { code: -32602, message: "Steer refused" } });
    } else {
      result(frame.id, { turnId: currentTurn });
      assistant(currentTurn, frame.params.input[0].text);
    }
    return;
  }

  if (frame.id !== undefined && frame.result !== undefined) {
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    if (request.kind === "approval") {
      const decision = frame.result.decision;
      notification("item/completed", {
        threadId: nativeThreadId,
        turnId: request.turnId,
        completedAtMs: Date.now(),
        item: {
          id: request.itemId,
          type: "commandExecution",
          command: "git status",
          commandActions: [],
          cwd: process.cwd(),
          status: decision === "decline" ? "declined" : "completed",
          aggregatedOutput: decision,
          exitCode: decision === "decline" ? 1 : 0,
        },
      });
      assistant(request.turnId, decision);
    } else {
      const answer = frame.result.answers?.target?.answers?.[0] ?? "";
      const reason = frame.result.answers?.reason?.answers?.[0] ?? "";
      assistant(request.turnId, reason ? `${answer}:${reason}` : answer);
    }
    complete(request.turnId);
  }
});

lines.on("close", () => process.exit(0));
