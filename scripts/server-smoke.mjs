// Smoke test the deployed boite-server end-to-end, from INSIDE the container:
//   docker cp scripts/server-smoke.mjs boite:/app/ && \
//   docker exec -e BOITE_TOKEN=$BOITE_TOKEN boite node /app/server-smoke.mjs
// Pure Node (>= 22, global WebSocket + crypto.randomUUID), no dependencies.
// Exercises: auth, project/shell RPC, spawn + live output, multi-device
// attach (second client sees replay), detach -> output keeps buffering ->
// reattach replays it, live status, webhook test, kill.

const URL = process.env.SMOKE_URL || "ws://127.0.0.1:7337/ws";
const TOKEN = process.env.BOITE_TOKEN || "test";
const CWD = process.env.SMOKE_CWD || "/workspace";
const dec = new TextDecoder();
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = false;
function check(label, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${extra}`);
  if (!ok) fail = true;
}

function uuidToBytes(u) {
  const hex = u.replace(/-/g, "");
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}
function bytesToUuid(b) {
  let h = "";
  for (let i = 0; i < 16; i++) h += b[i].toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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
    this.outputs.set(tid, (this.outputs.get(tid) || "") + dec.decode(buf.subarray(17)));
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

const nt = await c.rpc("notify.test", { title: "Smoke", body: "ping" });
check("notify.test responds", nt?.ok === true, `webhook_enabled=${nt?.enabled}`);

await c.rpc("thread.kill", { threadId, wait: true });
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
