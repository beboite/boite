#!/usr/bin/env node
// A stand-in for `claude --print --output-format stream-json --input-format
// stream-json`, speaking the same wire against a scenario file.
//
// Why it exists: every wire test would otherwise spend tokens and need a
// credential, and neither belongs in CI. The frames below are the ones pinned
// against claude 2.1.259 in ../README.md; changing one here without changing
// that file is how the fake starts passing tests the real CLI would fail.
//
// It is launched as `node fake-claude.mjs <scenario.json> <the CLI's own
// flags...>`: a .mjs file is not executable on Windows, so the driver is handed
// an explicit argv rather than a shim on the PATH. The scenario path may also
// come from BOITE_PILOT_SCENARIO.

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const scenarioPath =
  argv.find((a) => !a.startsWith("-") && a.endsWith(".json")) ??
  process.env.BOITE_PILOT_SCENARIO;
if (!scenarioPath) {
  process.stderr.write("fake-claude: no scenario file\n");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

// The CLI takes both `--flag value` and `--flag=value`; the driver writes the
// `=` form for the two session flags and the spaced form for the rest.
function flag(name) {
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  if (at !== -1 && at + 1 < argv.length && !argv[at + 1].startsWith("--")) {
    return argv[at + 1];
  }
  return undefined;
}

const resumed = flag("resume");
const sessionId =
  resumed ?? flag("session-id") ?? scenario.native_session_id ?? randomUUID();
const model = flag("model") ?? scenario.model ?? "claude-fable-5-1";
let permissionMode = flag("permission-mode") ?? "default";

const used = new Set();
const pendingPermissions = new Map();
let currentModel = model;

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function envelope(extra) {
  return { ...extra, session_id: sessionId, uuid: randomUUID() };
}

write(
  envelope({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    tools: ["Bash", "Read", "Edit"],
    mcp_servers: [],
    model: currentModel,
    permissionMode,
    slash_commands: scenario.slash_commands ?? ["init", "review"],
    output_style: "default",
    skills: [],
    plugins: [],
    agents: [],
    apiKeySource: "none",
    claude_code_version: "2.1.259-fake",
    capabilities: ["interrupt_receipt_v1"],
    // The argv is echoed so a test can assert the command line without
    // reaching into the process table.
    argv,
  }),
);

function stepFor(prompt) {
  const steps = scenario.steps ?? [];
  let index = steps.findIndex((s, i) => !used.has(i) && s.prompt === prompt);
  if (index === -1) {
    index = steps.findIndex((s, i) => !used.has(i) && s.prompt == null);
  }
  if (index === -1) return undefined;
  used.add(index);
  return steps[index];
}

const usageOf = (step) => ({
  input_tokens: step.usage?.input_tokens ?? 3,
  output_tokens: step.usage?.output_tokens ?? 2,
  cache_read_input_tokens: step.usage?.cache_read_input_tokens ?? 0,
  cache_creation_input_tokens: step.usage?.cache_creation_input_tokens ?? 0,
});

async function runStep(step) {
  const messageId = `msg_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const text = (step.deltas ?? []).join("");

  write(
    envelope({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          model: currentModel,
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          stop_reason: null,
          usage: usageOf(step),
        },
      },
      parent_tool_use_id: null,
    }),
  );
  write(
    envelope({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      parent_tool_use_id: null,
    }),
  );
  for (const delta of step.deltas ?? []) {
    write(
      envelope({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta },
        },
        parent_tool_use_id: null,
      }),
    );
  }
  write(
    envelope({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      parent_tool_use_id: null,
    }),
  );

  const content = [{ type: "text", text }];
  const toolUseId = step.request ? `toolu_${randomUUID().slice(0, 8)}` : null;
  if (step.request) {
    content.push({
      type: "tool_use",
      id: toolUseId,
      name: step.request.tool_name,
      input: step.request.input ?? {},
    });
  }
  write(
    envelope({
      type: "assistant",
      message: {
        model: currentModel,
        id: messageId,
        type: "message",
        role: "assistant",
        content,
        stop_reason: null,
        usage: usageOf(step),
      },
      parent_tool_use_id: null,
    }),
  );

  // A child that dies mid-turn: no result, no exit frame, just the pipes
  // closing. The driver has to notice that on its own.
  if (step.exit_mid_turn) {
    process.exit(1);
  }

  if (step.request) {
    const requestId = `cli_${randomUUID().slice(0, 8)}`;
    const answer = new Promise((resolve) =>
      pendingPermissions.set(requestId, resolve),
    );
    write({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: step.request.tool_name,
        input: step.request.input ?? {},
        tool_use_id: toolUseId,
        title: step.request.title ?? `Claude wants to run ${step.request.tool_name}`,
        permission_suggestions: step.request.permission_suggestions ?? [
          {
            type: "addRules",
            rules: [{ toolName: step.request.tool_name }],
            behavior: "allow",
            destination: "session",
          },
        ],
      },
    });
    const decision = await answer;
    write(
      envelope({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: decision.behavior === "allow" ? "done" : decision.message,
              is_error: decision.behavior !== "allow",
            },
          ],
        },
        parent_tool_use_id: null,
      }),
    );
  }

  // A turn the scenario never ends: the test interrupts it.
  if (step.hang) return;

  const failed = step.abort === true;
  write(
    envelope({
      type: "result",
      subtype: failed ? "error_during_execution" : "success",
      is_error: failed,
      duration_ms: step.duration_ms ?? 42,
      duration_api_ms: step.duration_ms ?? 40,
      num_turns: 1,
      result: text,
      stop_reason: "end_turn",
      total_cost_usd: step.total_cost_usd ?? 0.001,
      usage: usageOf(step),
      modelUsage: { [currentModel]: { contextWindow: 200000 } },
      permission_denials: [],
      errors: [],
    }),
  );

  if (step.exit) process.exit(0);
}

function controlSuccess(requestId, response) {
  write({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

const queue = [];
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const step = queue.shift();
    await runStep(step);
  }
  draining = false;
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.stderr.write(`fake-claude: unparsed ${line}\n`);
    return;
  }

  if (frame.type === "user") {
    const prompt =
      typeof frame.message?.content === "string"
        ? frame.message.content
        : (frame.message?.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
    const step = stepFor(prompt);
    if (!step) {
      process.stderr.write(`fake-claude: no step for ${JSON.stringify(prompt)}\n`);
      return;
    }
    queue.push(step);
    void drain();
    return;
  }

  if (frame.type === "control_response") {
    const resolve = pendingPermissions.get(frame.response?.request_id);
    if (resolve) {
      pendingPermissions.delete(frame.response.request_id);
      resolve(frame.response.response ?? { behavior: "deny", message: "no answer" });
    }
    return;
  }

  if (frame.type === "control_request") {
    const { request_id: requestId, request } = frame;
    switch (request?.subtype) {
      case "interrupt":
        // The real CLI answers once the turn is really gone, and the queue it
        // drops is what `still_queued` reports.
        queue.length = 0;
        controlSuccess(requestId, { still_queued: [] });
        break;
      case "set_model":
        currentModel = request.model ?? model;
        controlSuccess(requestId, { model: currentModel });
        break;
      case "set_permission_mode":
        permissionMode = request.mode;
        controlSuccess(requestId, {});
        break;
      case "initialize":
        controlSuccess(requestId, { commands: [], modes: [] });
        break;
      default:
        write({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: requestId,
            error: `unsupported subtype ${request?.subtype}`,
          },
        });
    }
    return;
  }
});

// stdin closing is the polite stop: the CLI runs its exit path and leaves.
lines.on("close", () => {
  process.exit(0);
});
