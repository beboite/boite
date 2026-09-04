import http from "node:http";

const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.slice("--port=".length) ?? 0);
const clients = new Set();
const cwd = process.cwd();
let eventSequence = 0;
let currentPrompt = "";
let currentModel = "fake/model-a";

function sendJson(response, status, body) {
  const payload = body === undefined || body === null ? "" : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function emit(type, properties = {}) {
  const event = JSON.stringify({ id: `evt_${++eventSequence}`, type, properties });
  for (const client of clients) client.write(`data: ${event}\n\n`);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

function assistantInfo(messageID = "msg_assistant") {
  const [providerID, ...modelParts] = currentModel.split("/");
  return {
    id: messageID,
    sessionID: "ses_fake",
    role: "assistant",
    parentID: "msg_prompt",
    providerID,
    modelID: modelParts.join("/"),
  };
}

function finishText(text, messageID = "msg_assistant") {
  emit("session.status", { sessionID: "ses_fake", status: { type: "busy" } });
  emit("message.updated", { sessionID: "ses_fake", info: assistantInfo(messageID) });
  emit("message.part.updated", {
    sessionID: "ses_fake",
    time: Date.now(),
    part: {
      id: `prt_${messageID}`,
      sessionID: "ses_fake",
      messageID,
      type: "text",
      text,
      time: { start: Date.now(), end: Date.now() },
    },
  });
  emit("session.status", { sessionID: "ses_fake", status: { type: "idle" } });
}

function runPlainTurn() {
  emit("session.status", { sessionID: "ses_fake", status: { type: "busy" } });
  emit("message.updated", { sessionID: "ses_fake", info: assistantInfo() });
  emit("message.part.updated", {
    sessionID: "ses_fake",
    time: Date.now(),
    part: {
      id: "prt_text",
      sessionID: "ses_fake",
      messageID: "msg_assistant",
      type: "text",
      text: "",
      time: { start: Date.now() },
    },
  });
  emit("message.part.delta", {
    sessionID: "ses_fake",
    messageID: "msg_assistant",
    partID: "prt_text",
    field: "text",
    delta: "o",
  });
  emit("message.part.delta", {
    sessionID: "ses_fake",
    messageID: "msg_assistant",
    partID: "prt_text",
    field: "text",
    delta: "k",
  });
  emit("message.part.updated", {
    sessionID: "ses_fake",
    time: Date.now(),
    part: {
      id: "prt_text",
      sessionID: "ses_fake",
      messageID: "msg_assistant",
      type: "text",
      text: "ok",
      time: { start: Date.now(), end: Date.now() },
    },
  });
  emit("message.part.updated", {
    sessionID: "ses_fake",
    time: Date.now(),
    part: {
      id: "prt_tool",
      sessionID: "ses_fake",
      messageID: "msg_assistant",
      type: "tool",
      callID: "call_tool",
      tool: "bash",
      state: { status: "pending", input: { command: "git status" } },
    },
  });
  emit("message.part.updated", {
    sessionID: "ses_fake",
    time: Date.now(),
    part: {
      id: "prt_tool",
      sessionID: "ses_fake",
      messageID: "msg_assistant",
      type: "tool",
      callID: "call_tool",
      tool: "bash",
      state: { status: "completed", input: { command: "git status" }, output: "clean" },
    },
  });
  emit("todo.updated", {
    sessionID: "ses_fake",
    todos: [{ content: "Verify", status: "completed", priority: "high" }],
  });
  emit("message.part.updated", {
    sessionID: "ses_fake",
    time: Date.now(),
    part: {
      id: "prt_usage",
      sessionID: "ses_fake",
      messageID: "msg_assistant",
      type: "step-finish",
      reason: "stop",
      cost: 0.02,
      tokens: { total: 32, input: 20, output: 9, reasoning: 3, cache: { read: 4, write: 1 } },
    },
  });
  emit("session.status", { sessionID: "ses_fake", status: { type: "idle" } });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname;
  if (request.method === "GET" && path === "/global/health") {
    return sendJson(response, 200, { healthy: true, version: "1.18.27" });
  }
  if (request.method === "GET" && path === "/provider") {
    return sendJson(response, 200, {
      connected: ["fake"],
      default: { fake: "model-a" },
      all: [{
        id: "fake",
        models: {
          "model-a": { id: "model-a", providerID: "fake" },
          "model-b": { id: "model-b", providerID: "fake" },
        },
      }],
    });
  }
  if (request.method === "GET" && path === "/permission") {
    return sendJson(response, 200, [{
      id: "per_recovered",
      sessionID: "ses_resume",
      permission: "bash",
      patterns: ["git diff"],
      metadata: { command: "git diff" },
      always: ["git diff"],
    }]);
  }
  if (request.method === "GET" && path === "/question") {
    return sendJson(response, 200, []);
  }
  if (request.method === "GET" && path === "/event") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    clients.add(response);
    response.write(`data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", properties: {} })}\n\n`);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "POST" && path === "/mcp") {
    await readBody(request);
    return sendJson(response, 200, { status: "connected" });
  }
  if (request.method === "POST" && path === "/session") {
    await readBody(request);
    return sendJson(response, 200, { id: "ses_fake", directory: cwd });
  }
  if (request.method === "GET" && path === "/session/ses_resume") {
    return sendJson(response, 200, { id: "ses_resume", directory: cwd });
  }
  if (request.method === "GET" && path.startsWith("/session/")) {
    return sendJson(response, 404, { error: "not found" });
  }
  if (request.method === "PATCH" && path.startsWith("/session/")) {
    await readBody(request);
    const id = path.split("/")[2];
    return sendJson(response, 200, { id, directory: cwd });
  }
  if (request.method === "POST" && path.endsWith("/prompt_async")) {
    const body = await readBody(request);
    currentPrompt = body.parts?.[0]?.text ?? "";
    currentModel = `${body.model.providerID}/${body.model.modelID}`;
    sendJson(response, 204, null);
    setImmediate(() => {
      if (currentPrompt === "plain") runPlainTurn();
      else if (currentPrompt === "approve") {
        emit("session.status", { sessionID: "ses_fake", status: { type: "busy" } });
        emit("session.created", {
          info: { id: "ses_child", parentID: "ses_fake", directory: cwd },
        });
        emit("permission.asked", {
          id: "per_native",
          sessionID: "ses_child",
          permission: "bash",
          patterns: ["git status"],
          metadata: { command: "git status" },
          always: ["git status"],
          tool: { messageID: "msg_assistant", callID: "call_permission" },
        });
      } else if (currentPrompt === "question") {
        emit("session.status", { sessionID: "ses_fake", status: { type: "busy" } });
        emit("question.asked", {
          id: "que_native",
          sessionID: "ses_fake",
          questions: [
            {
              header: "Target",
              question: "Where should it run?",
              options: [{ label: "Web", description: "Browser" }, { label: "Desktop", description: "Native" }],
              multiple: false,
              custom: true,
            },
            {
              header: "Flags",
              question: "Which flags?",
              options: [{ label: "Fast" }, { label: "Safe" }],
              multiple: true,
              custom: false,
            },
          ],
          tool: { messageID: "msg_assistant", callID: "call_question" },
        });
      } else if (currentPrompt === "hang") {
        emit("session.status", { sessionID: "ses_fake", status: { type: "busy" } });
      } else {
        finishText(`${currentModel}:${currentPrompt}`);
      }
    });
    return;
  }
  if (request.method === "POST" && path === "/permission/per_native/reply") {
    const body = await readBody(request);
    sendJson(response, 200, true);
    setImmediate(() => {
      emit("permission.replied", { sessionID: "ses_fake", requestID: "per_native", reply: body.reply });
      finishText(body.reply, "msg_permission");
    });
    return;
  }
  if (request.method === "POST" && path === "/question/que_native/reply") {
    const body = await readBody(request);
    sendJson(response, 200, true);
    setImmediate(() => {
      emit("question.replied", { sessionID: "ses_fake", requestID: "que_native", answers: body.answers });
      finishText(body.answers.map((answer) => answer.join("+")).join(":"), "msg_question");
    });
    return;
  }
  if (request.method === "POST" && path === "/question/que_native/reject") {
    sendJson(response, 200, true);
    return;
  }
  if (request.method === "POST" && path.endsWith("/abort")) {
    emit("session.status", { sessionID: "ses_fake", status: { type: "busy" } });
    emit("session.idle", { sessionID: "ses_fake" });
    setTimeout(() => sendJson(response, 200, true), 25);
    return;
  }
  if (request.method === "POST" && path.endsWith("/summarize")) {
    await readBody(request);
    sendJson(response, 200, true);
    return;
  }
  sendJson(response, 404, { error: `${request.method} ${path}` });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`opencode server listening on http://127.0.0.1:${address.port}\n`);
});

process.stdin.resume();
process.stdin.on("end", () => server.close());
process.on("SIGTERM", () => server.close(() => process.exit(0)));
