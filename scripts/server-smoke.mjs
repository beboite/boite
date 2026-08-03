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
    args: ["-c", "echo URL=$BOITE_MCP_URL; echo FILE=$BOITE_TOKEN_FILE; sleep 30"],
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
const tokenFile = said.match(/FILE=(\S+)/)?.[1];
check("a spawned terminal is told where the agent endpoint is", !!agentUrl && !!tokenFile);
if (agentUrl && tokenFile) {
  // The path, never the value: the token travels in a file only its user can
  // read, so an agent typing `env` does not print its own credential into a
  // scrollback that is kept and replayed.
  const token = (await readFile(tokenFile, "utf8")).trim();
  const ask = (headers) => fetch(`${agentUrl}/v1/todos`, { headers });
  const mine = await ask({ authorization: `Bearer ${token}`, "x-boite-thread": probeId });
  const body = mine.status === 200 ? await mine.json() : null;
  check("the agent endpoint answers its own thread", Array.isArray(body?.todos), `status=${mine.status}`);

  const wrong = await ask({ authorization: "Bearer not-the-token", "x-boite-thread": probeId });
  check("a wrong token reaches nothing", wrong.status === 401, `status=${wrong.status}`);

  // A leaked token with no thread reaches nothing either: the token says the
  // caller came from Boite, the thread says what it may see.
  const anonymous = await ask({ authorization: `Bearer ${token}` });
  check("a token with no thread reaches nothing", anonymous.status === 400, `status=${anonymous.status}`);

  const stranger = await ask({
    authorization: `Bearer ${token}`,
    "x-boite-thread": crypto.randomUUID(),
  });
  check("a thread this workspace does not have reaches nothing", stranger.status === 404, `status=${stranger.status}`);
}
try {
  await c.rpc("thread.kill", { threadId: probeId, wait: false });
} catch {
  // The probe is about to be deleted either way.
}
await c.rpc("thread.delete", { threadId: probeId });

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
