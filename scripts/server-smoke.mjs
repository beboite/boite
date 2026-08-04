// Smoke test the deployed boite-server end-to-end, from INSIDE the container:
//   docker cp scripts/server-smoke.mjs boite:/app/ && \
//   docker exec -e BOITE_TOKEN=$BOITE_TOKEN boite node /app/server-smoke.mjs
// Pure Node (>= 22, global WebSocket + crypto.randomUUID), no dependencies.
// Exercises: auth, project/shell RPC, the git command bus and its trust
// boundary, spawn + live output, multi-device attach (second client sees
// replay), detach -> output keeps buffering -> reattach replays it, live
// status, webhook test, kill. Nothing here writes to the repository it is
// pointed at.

import { readFile } from "node:fs/promises";
import { createPrivateKey, sign as signBytes, createHash } from "node:crypto";

const URL = process.env.SMOKE_URL || "ws://127.0.0.1:7337/ws";
const TOKEN = process.env.BOITE_TOKEN || "test";
const CWD = process.env.SMOKE_CWD || "/workspace";
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = false;
function check(label, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${extra}`);
  if (!ok) fail = true;
}

// The agent endpoint takes a signature, not a bearer token, from anything that
// presents a thread. This is the same canonical string `boite_identity` builds
// in Rust, and it has to stay that way: a separator that drifts here reads as
// "invalid signature", which looks like a wrong key and sends whoever is
// debugging it to the wrong file.
function canonical(method, path, threadId, ts, body) {
  const digest = createHash("sha256").update(body ?? "").digest("hex");
  return `boite-v1\n${method.toUpperCase()}\n${path}\n${threadId}\n${ts}\n${digest}`;
}

// A raw 32-byte ed25519 seed, which is what Boite writes, wrapped in the fixed
// PKCS#8 prefix node insists on before it will hold one.
function keyFromSeed(seedHex) {
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(seedHex, "hex"),
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

// What a shim sends: the thread, when it signed, and the signature over the
// request itself. Nothing reusable, which is the point.
function signedHeaders(key, threadId, method, path, body) {
  const ts = Date.now();
  const message = canonical(method, path, threadId, ts, body);
  return {
    "x-boite-thread": threadId,
    "x-boite-ts": String(ts),
    "x-boite-sig": signBytes(null, Buffer.from(message), key).toString("hex"),
  };
}

function bytesToUuid(b) {
  let h = "";
  for (let i = 0; i < 16; i++) h += b[i].toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function uuidToBytes(u) {
  const hex = u.replace(/-/g, "");
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

// Input frame: [0x02][16 byte thread id][payload].
function inputFrame(threadId, text) {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(17 + payload.length);
  frame[0] = 0x02;
  frame.set(uuidToBytes(threadId), 1);
  frame.set(payload, 17);
  return frame;
}

class Client {
  constructor() {
    this.ws = new WebSocket(URL);
    this.ws.binaryType = "arraybuffer";
    this.id = 1;
    this.pending = new Map();
    this.outputs = new Map(); // threadId -> accumulated text
    this.ws.onmessage = (ev) => this.onMessage(ev);
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error("ws error: " + (e?.message ?? e)));
    });
  }
  onMessage(ev) {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok === false) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
      return;
    }
    const buf = new Uint8Array(ev.data);
    if (buf.length < 17 || buf[0] !== 0x01) return;
    const tid = bytesToUuid(buf.subarray(1, 17));
    const chunk = dec.decode(buf.subarray(17));
    this.outputs.set(tid, (this.outputs.get(tid) || "") + chunk);
    // ConPTY asks the terminal where the cursor is (DSR, ESC[6n) and holds the
    // child's output back until something answers. A real client answers
    // through xterm; with no emulator here the whole test reads zero bytes on
    // Windows and passes on Linux, which is the worst way for a gate to fail.
    if (chunk.includes("\x1b[6n")) this.ws.send(inputFrame(tid, "\x1b[1;1R"));
  }
  rpc(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout: " + method));
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  out(tid) {
    return this.outputs.get(tid) || "";
  }
  close() {
    this.ws.close();
  }
}

const c = new Client();
await c.open();
await c.rpc("auth", { token: TOKEN });
check("auth", true);

const hello = await c.rpc("hello");
check("hello protocol 1", hello?.protocol === 1);

await c.rpc("project.create", {
  project: { id: "smoke", name: "smoke", cwd: CWD, icon: null, archived: false },
});
const pl = await c.rpc("project.list");
check("project round-trip", (pl.projects || []).some((p) => p.id === "smoke"));

const sh = await c.rpc("shell.available");
check("shell.available", (sh.shells || []).length > 0, `(${(sh.shells || []).length})`);

// The git surface is one command bus in boite-core with two front doors over
// it. Two things can break there without a compiler noticing: the trust
// boundary, and the envelope a remote client reads an answer out of. Both are
// checked here over the real socket, with read-only methods only.
const info = await c.rpc("git.repoInfo", { path: CWD });
check("git.repoInfo answers bare", typeof info?.isRepo === "boolean", `isRepo=${info?.isRepo}`);
if (info?.isRepo) {
  const st = await c.rpc("git.status", { path: CWD });
  check("git.status wraps its answer in entries", Array.isArray(st?.entries));
  const br = await c.rpc("git.branches", { path: CWD });
  check("git.branches wraps its answer in branches", Array.isArray(br?.branches));
  const lg = await c.rpc("git.log", { path: CWD, limit: 1, skip: 0 });
  check("git.log wraps its answer in commits", Array.isArray(lg?.commits));
}
try {
  await c.rpc("git.status", { path: "/" });
  check("a path outside the roots is refused", false, "it was accepted");
} catch (e) {
  const said = String(e?.message ?? e);
  check("a path outside the roots is refused", said.includes("outside registered project roots"), said);
}

// The filesystem half of the same bus. `file.readBase64` is new on this side:
// the desktop has had it since panes could hold a document, and a remote
// workspace answered `not-supported-remote`, so a PDF in a pane was a blank
// frame. `project.folderState` is the other one worth a check — it is asked
// about folders that do not exist yet, which is precisely what this side used
// to refuse.
const dir = await c.rpc("fs.readDir", { path: CWD });
check("fs.readDir wraps its answer in entries", Array.isArray(dir?.entries));

const pkg = `${CWD}/package.json`;
const text = await c.rpc("file.read", { path: pkg });
check("file.read answers bare", typeof text?.content === "string");

const bytes = await c.rpc("file.readBase64", { path: pkg });
const decoded = bytes?.base64 ? Buffer.from(bytes.base64, "base64").toString("utf8") : "";
check("file.readBase64 hands back the same file", decoded === text?.content, `${decoded.length}b`);

const missing = await c.rpc("project.folderState", { path: `${CWD}/not-a-folder-${Date.now()}` });
check("a folder that does not exist answers missing", missing === "missing", String(missing));
const occupied = await c.rpc("project.folderState", { path: CWD });
check("a folder with files in it says so", occupied === "occupied", String(occupied));

const threadId = crypto.randomUUID();
const thread = {
  id: threadId,
  projectId: "smoke",
  label: "smoke",
  cmd: "bash",
  args: ["-c", "echo SMOKEMARK; sleep 1; echo MIDMARK; sleep 60"],
  iconKey: null,
};
await c.rpc("thread.spawn", { thread, cwd: CWD, cols: 80, rows: 24 });
const att = await c.rpc("thread.attach", { threadId, cols: 80, rows: 24 });
check("attach returns ptyId", !!att?.ptyId);

await sleep(900);
check("live output", c.out(threadId).includes("SMOKEMARK"), `(${c.out(threadId).length}b)`);

// Second device on the same thread: gets the scrollback replay.
const c2 = new Client();
await c2.open();
await c2.rpc("auth", { token: TOKEN });
await c2.rpc("thread.attach", { threadId, cols: 80, rows: 24 });
await sleep(500);
check("multi-device replay", c2.out(threadId).includes("SMOKEMARK"));

// Detach; output keeps buffering server-side; reattach replays it.
await c.rpc("thread.detach", { threadId });
await sleep(1300); // MIDMARK prints (~t+1s) while c is detached
c.outputs.set(threadId, "");
await c.rpc("thread.attach", { threadId, cols: 80, rows: 24 });
await sleep(500);
check("reattach replays detached output", c.out(threadId).includes("MIDMARK"));

const tl = await c.rpc("thread.list");
const t = (tl.threads || []).find((x) => x.id === threadId);
check("live status + ptyId", !!t && !!t.ptyId && (t.status === "running" || t.status === "ready"), `status=${t?.status}`);

// The agent endpoint, from where an agent actually stands: inside a terminal
// this server spawned, holding only what was stamped into its environment. It
// is the one surface with no other caller — no frontend reaches it — so nothing
// else notices when it breaks. Wide columns because the terminal would wrap a
// long path and cut the value in half.
const probeId = crypto.randomUUID();
await c.rpc("thread.spawn", {
  thread: {
    id: probeId,
    projectId: "smoke",
    label: "probe",
    cmd: "bash",
    args: ["-c", "echo URL=$BOITE_MCP_URL; echo FILE=$BOITE_KEY_FILE; sleep 30"],
    iconKey: null,
  },
  cwd: CWD,
  cols: 200,
  rows: 24,
});
await c.rpc("thread.attach", { threadId: probeId, cols: 200, rows: 24 });
await sleep(900);
const said = c.out(probeId);
const agentUrl = said.match(/URL=(\S+)/)?.[1];
const keyFile = said.match(/FILE=(\S+)/)?.[1];
check("a spawned terminal is told where the agent endpoint is", !!agentUrl && !!keyFile);
if (agentUrl && keyFile) {
  // The path, never the value: the key travels in a file only its user can
  // read, so an agent typing `env` does not print its own credential into a
  // scrollback that is kept and replayed.
  const seed = (await readFile(keyFile, "utf8")).trim();
  const key = keyFromSeed(seed);
  const ask = (headers) => fetch(`${agentUrl}/v1/todos`, { headers });
  const mine = await ask(signedHeaders(key, probeId, "GET", "/v1/todos", ""));
  const body = mine.status === 200 ? await mine.json() : null;
  check("the agent endpoint answers its own thread", Array.isArray(body?.todos), `status=${mine.status}`);

  // The blocker this closes. Presenting a thread id used to be the whole of it.
  const bare = await ask({ "x-boite-thread": probeId });
  check("a thread id with no signature reaches nothing", bare.status === 401, `status=${bare.status}`);

  // A signature made with a key this workspace never issued.
  const forged = keyFromSeed("11".repeat(32));
  const impostor = await ask(signedHeaders(forged, probeId, "GET", "/v1/todos", ""));
  check("another key does not open this thread", impostor.status === 401, `status=${impostor.status}`);

  // And the signature covers the request, so one lifted off this call does not
  // authorise a different one.
  const lifted = await fetch(`${agentUrl}/v1/todos`, {
    method: "POST",
    headers: {
      ...signedHeaders(key, probeId, "GET", "/v1/todos", ""),
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "should never land" }),
  });
  check("a signature does not travel between requests", lifted.status === 401, `status=${lifted.status}`);

  const stranger = await ask(signedHeaders(key, crypto.randomUUID(), "GET", "/v1/todos", ""));
  check("a thread this workspace does not have reaches nothing", stranger.status === 401, `status=${stranger.status}`);

  // The workspace token drives devices. It was never an agent credential and is
  // not one now, whatever thread it is presented with.
  const device = await ask({ authorization: `Bearer ${TOKEN}`, "x-boite-project": "smoke" });
  check("the device token is not an agent credential", device.status === 401, `status=${device.status}`);

  // A call that reaches past the project the agent is in. It used to be handed
  // to a device and answered "moving to <project>"; it waits for the user now,
  // and the agent is told so in a way it should not retry.
  const moved = await fetch(`${agentUrl}/v1/thread/move`, {
    method: "POST",
    headers: {
      ...signedHeaders(key, probeId, "POST", "/v1/thread/move", JSON.stringify({ project: "smoke" })),
      "content-type": "application/json",
    },
    body: JSON.stringify({ project: "smoke" }),
  });
  const gate = moved.status === 200 ? await moved.json() : null;
  check(
    "a move across projects waits for the user",
    gate?.retryable === false && typeof gate?.approvalId === "string",
    `status=${moved.status}`,
  );
  // And says so as a status rather than as an error. Every client on the far
  // side reads an `error` field as a failed call, which this one is not.
  check(
    "waiting on the user is not answered as a failure",
    gate?.status === "awaiting-user" && gate?.error === undefined,
    `body=${JSON.stringify(gate)}`,
  );

  const waiting = await c.rpc("approval.list");
  check(
    "the request is waiting where a device can see it",
    (waiting.approvals ?? []).some((a) => a.id === gate?.approvalId && a.action === "thread.move"),
  );

  // Refused, so nothing runs and the probe stays where it is. Allowing it would
  // kill the PTY the rest of this script is still talking to.
  const answered = await c.rpc("approval.decide", { id: gate?.approvalId, allow: false });
  check("the user's answer closes it", answered.decided?.id === gate?.approvalId);
  const after = await c.rpc("approval.list");
  check("an answered request stops waiting", (after.approvals ?? []).length === 0);

  // What the terminal actually printed, read back from the file rather than
  // from a ring that dies with the process. The probe echoed its own
  // environment, so its transcript has to contain what it said.
  const printed = await fetch(`${agentUrl}/v1/transcript?bytes=4096`, {
    headers: signedHeaders(key, probeId, "GET", "/v1/transcript?bytes=4096", ""),
  });
  const said2 = printed.status === 200 ? await printed.json() : null;
  check(
    "a terminal's own output is kept where it can be read back",
    typeof said2?.text === "string" && said2.text.includes("URL="),
    `status=${printed.status}`,
  );
  // And any thread in the workspace, which is how one agent finds out what
  // another was doing when it stopped.
  const other = await fetch(`${agentUrl}/v1/transcript?bytes=4096&threadId=${threadId}`, {
    headers: signedHeaders(key, probeId, "GET", `/v1/transcript?bytes=4096&threadId=${threadId}`, ""),
  });
  const otherText = other.status === 200 ? await other.json() : null;
  check(
    "another terminal's output is readable too",
    typeof otherText?.text === "string" && otherText.text.includes("MIDMARK"),
    `status=${other.status}`,
  );

  // Three sources, one answer. The todo list is empty here, so what this
  // proves is the other two: the log of what was refused, and what a terminal
  // printed. Both were unfindable before, because neither was written down.
  const looking = "MIDMARK";
  const searched = await fetch(`${agentUrl}/v1/search?limit=20&q=${looking}`, {
    headers: signedHeaders(key, probeId, "GET", `/v1/search?limit=20&q=${looking}`, ""),
  });
  const hits = searched.status === 200 ? await searched.json() : null;
  check(
    "what a terminal printed is findable across the workspace",
    (hits?.hits ?? []).some((h) => h.kind === "transcript" && h.excerpt.includes(looking)),
    `status=${searched.status}`,
  );

  const denied = await fetch(`${agentUrl}/v1/search?limit=20&q=thread.move`, {
    headers: signedHeaders(key, probeId, "GET", "/v1/search?limit=20&q=thread.move", ""),
  });
  const events = denied.status === 200 ? await denied.json() : null;
  check(
    "what an agent asked for is findable in the log",
    (events?.hits ?? []).some((h) => h.kind === "event"),
    `status=${denied.status}`,
  );

  // And the other axis: what happened, in order, across all three sources.
  const when = await fetch(`${agentUrl}/v1/timeline?limit=50`, {
    headers: signedHeaders(key, probeId, "GET", "/v1/timeline?limit=50", ""),
  });
  const moments = when.status === 200 ? await when.json() : null;
  const kinds = new Set((moments?.moments ?? []).map((m) => m.kind));
  check(
    "the timeline carries every source on one clock",
    kinds.has("event") && kinds.has("thread"),
    `status=${when.status} kinds=${[...kinds].join(",")}`,
  );
  check(
    "the timeline is newest first",
    (moments?.moments ?? []).every((m, i, all) => i === 0 || all[i - 1].at >= m.at),
  );

  // What the stop hook asks at the end of a turn. The probe has no worktree of
  // its own, so the answer here is the empty one — and that is the case worth
  // pinning, because the hook turns anything but a reason into "carry on" and a
  // refusal at this route would end every turn with a hook that failed.
  const ending = await fetch(`${agentUrl}/v1/finish`, {
    headers: signedHeaders(key, probeId, "GET", "/v1/finish", ""),
  });
  const unfinished = ending.status === 200 ? await ending.json() : null;
  check(
    "the endpoint behind the stop hook answers rather than refusing",
    Array.isArray(unfinished?.objections),
    `status=${ending.status}`,
  );
  check(
    "nothing to object to is no message at all",
    (unfinished?.objections ?? []).length > 0 || !unfinished?.reason,
    `reason=${JSON.stringify(unfinished?.reason)}`,
  );

  // The one call an agent makes instead of asking a human what they see. Its
  // value is the comparison: what the rows claim, next to what this process
  // actually has a process for.
  const snap = await fetch(`${agentUrl}/v1/snapshot`, {
    headers: signedHeaders(key, probeId, "GET", "/v1/snapshot", ""),
  });
  const state = snap.status === 200 ? await snap.json() : null;
  check(
    "the snapshot answers with both lists",
    Array.isArray(state?.threads) && Array.isArray(state?.livePtys) && Array.isArray(state?.projects),
    `status=${snap.status}`,
  );
  check(
    "the snapshot sees the probe's own terminal running",
    (state?.livePtys ?? []).some((p) => p.threadId === probeId && p.childPid > 0),
  );
  check("the snapshot carries no problem to report", (state?.problems ?? []).length === 0, JSON.stringify(state?.problems ?? []));
  // The window's own description of itself is in here on a desktop. This host
  // has no window, so it says nothing about one rather than inventing an empty
  // description that an agent would read as "nothing is open".
  check(
    "a host with no window describes none",
    state?.screen === undefined,
    JSON.stringify(state?.screen ?? null),
  );
  // Whatever else it holds, it must not hold a credential.
  const asText = JSON.stringify(state ?? {});
  check("the snapshot carries no credential", !asText.includes(seed) && !asText.includes(TOKEN));
}
try {
  await c.rpc("thread.kill", { threadId: probeId, wait: false });
} catch {
  // The probe is about to be deleted either way.
}
await c.rpc("thread.delete", { threadId: probeId });

// The record domain: the last four tables to reach the bus, and the two guards
// each of which used to exist on one side only.
await c.rpc("todo.save", {
  todo: {
    id: "smoke-todo",
    projectId: "smoke",
    title: "a todo written by the smoke run",
    // A state this build does not know. The desktop's TypeScript folded these
    // back to `open` and the Rust reader did not, so the same row read two ways
    // gave two answers.
    state: "banana",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
});
const todos = await c.rpc("todo.list");
const saved = (todos.todos || []).find((t) => t.id === "smoke-todo");
check("a todo state nothing knows reads as open", saved?.state === "open", `state=${saved?.state}`);
await c.rpc("todo.delete", { todoId: "smoke-todo" });
const gone = await c.rpc("todo.list");
check("a deleted todo is gone", !(gone.todos || []).some((t) => t.id === "smoke-todo"));

// The colour lands in a CSS custom property on every connected device, so
// anything that is not one is dropped rather than stored.
await c.rpc("workspace.setInfo", { name: "smoke boite", color: "#0a0" });
await c.rpc("workspace.setInfo", { color: "javascript:alert(1)" });
const meta = await c.rpc("workspace.info");
check("a workspace colour that is not one is dropped", meta?.color === "#0a0", `color=${meta?.color}`);
check("and the name beside it survived", meta?.name === "smoke boite", `name=${meta?.name}`);
await c.rpc("workspace.setInfo", { name: null, color: null });

const nt = await c.rpc("notify.test", { title: "Smoke", body: "ping" });
check("notify.test responds", nt?.ok === true, `webhook_enabled=${nt?.enabled}`);

// A refused kill is a result, not a reason to stop: the checks after it still
// say something, and an uncaught rejection here reported the whole run as a
// crash with no summary line.
try {
  await c.rpc("thread.kill", { threadId, wait: true });
  check("kill accepted", true);
} catch (e) {
  check("kill accepted", false, String(e?.message ?? e));
}
await sleep(500);
const tl2 = await c.rpc("thread.list");
const t2 = (tl2.threads || []).find((x) => x.id === threadId);
check("killed thread no longer running", !t2 || t2.status !== "running", `status=${t2?.status}`);

await c.rpc("thread.delete", { threadId });
await c.rpc("project.delete", { id: "smoke" });
c.close();
c2.close();

console.log(fail ? "\nSERVER SMOKE FAIL" : "\nSERVER SMOKE PASS");
process.exit(fail ? 1 : 0);
