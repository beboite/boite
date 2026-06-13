// Phase 2 gate: spawn a PTY thread, write input, detach, reattach, verify the
// scrollback replay still carries earlier output. Run against a boite-server
// started with BOITE_TOKEN=test on 127.0.0.1:7399.

const URL = "ws://127.0.0.1:7399/ws";
const TOKEN = "test";
const THREAD_ID = crypto.randomUUID();
const MARK = "BOITEMARK_" + Math.floor(performance.now());

function uuidToBytes(u) {
  const hex = u.replace(/-/g, "");
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}
function inputFrame(threadId, text) {
  const id = uuidToBytes(threadId);
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(1 + 16 + payload.length);
  frame[0] = 0x02;
  frame.set(id, 1);
  frame.set(payload, 17);
  return frame;
}

const ws = new WebSocket(URL);
ws.binaryType = "arraybuffer";
const dec = new TextDecoder();
let collected = "";
let nextId = 1;
const pending = new Map();

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.onmessage = (ev) => {
  if (typeof ev.data === "string") {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.event) {
      // events: thread.status / thread.title / replay / ...
      if (msg.event === "replay") console.log("  <- replay marker", JSON.stringify(msg.data.size), msg.data.bytes, "bytes");
      if (msg.event === "thread.status") console.log("  <- status", msg.data.status);
    }
  } else {
    // binary output frame: [0x01][16 id][payload]
    const buf = new Uint8Array(ev.data);
    const chunk = dec.decode(buf.slice(17));
    collected += chunk;
    // ConPTY queries cursor position (DSR, ESC[6n) on startup and withholds
    // child output until the terminal answers. In production xterm replies;
    // here we answer manually so output flows.
    if (chunk.indexOf("\x1b[6n") >= 0) ws.send(inputFrame(THREAD_ID, "\x1b[1;1R"));
  }
};

ws.onerror = (e) => { console.error("ws error", e.message ?? e); process.exit(1); };

ws.onopen = async () => {
  let r = await rpc("auth", { token: TOKEN });
  console.log("auth:", r.ok);
  if (!r.ok) process.exit(1);

  r = await rpc("thread.spawn", {
    thread: { id: THREAD_ID, projectId: "p1", label: "smoke", cmd: "cmd", args: ["/c", `echo ${MARK} & ping -n 4 127.0.0.1 >NUL`], iconKey: null },
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });
  console.log("spawn ok:", r.ok, "ptyId:", r.result?.thread?.ptyId?.slice(0, 8));
  if (!r.ok) process.exit(1);

  r = await rpc("thread.attach", { threadId: THREAD_ID, cols: 80, rows: 24 });
  console.log("attach ok:", r.ok);

  await sleep(1000);
  const sawLive = collected.includes(MARK);
  console.log("live output saw MARK:", sawLive, "| collected", collected.length, "bytes:", JSON.stringify(collected.slice(0, 120)));

  collected = "";
  r = await rpc("thread.detach", { threadId: THREAD_ID });
  console.log("detach ok:", r.ok);
  await sleep(300);

  collected = "";
  r = await rpc("thread.attach", { threadId: THREAD_ID, cols: 80, rows: 24 });
  await sleep(500);
  const replaySawMark = collected.includes(MARK);
  console.log("reattach replay saw MARK:", replaySawMark);

  r = await rpc("thread.list", {});
  const t = r.result.threads.find((x) => x.id === THREAD_ID);
  console.log("list: status =", t?.status, "ptyId set =", !!t?.ptyId);

  await rpc("thread.kill", { threadId: THREAD_ID, wait: false });
  await sleep(200);

  const pass = sawLive && replaySawMark && t?.ptyId;
  console.log(pass ? "\nSMOKE PASS" : "\nSMOKE FAIL");
  ws.close();
  process.exit(pass ? 0 : 1);
};

setTimeout(() => { console.error("timeout"); process.exit(2); }, 15000);
