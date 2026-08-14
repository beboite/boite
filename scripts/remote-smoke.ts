// Phase 4 gate: drive the real RemoteBackend against a running boite-server.
// Type-only imports inside the backend are erased by bun, so this loads the
// actual Socket + RemoteBackend with no $lib resolution.
// Start a server first: BOITE_TOKEN=test BOITE_BIND=127.0.0.1:7399 boite-server.
//
// `BOITE_TOKEN` is the bootstrap credential and pairs a device; what the backend
// takes is that device's own credential, which it turns into a socket ticket
// itself. So this pairs a throwaway device first and revokes it at the end.

import { RemoteBackend } from "../src/lib/backend/remote/index.ts";

const URL = "ws://127.0.0.1:7399/ws";
const HTTP = URL.replace(/^ws/, "http").replace(/\/ws\/?$/, "");
const BOOTSTRAP = process.env.BOITE_TOKEN || "test";
const dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fail = false;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${extra}`);
  if (!ok) fail = true;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${HTTP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} refused (${res.status})`);
  return res.json();
}

// `admin` is in there only so this can revoke itself on the way out.
const invite = await post(
  "/api/pairings",
  {
    label: "remote-smoke",
    kind: "cli",
    scopes: ["read", "write", "terminal", "approve", "admin"],
  },
  { authorization: `Bearer ${BOOTSTRAP}` },
);
const paired = await post("/api/pair", {
  token: invite.token,
  label: "remote-smoke",
  kind: "cli",
});

const rb = new RemoteBackend(URL, paired.credential, (s) => console.log("  conn:", s));
await rb.connect();
check("connect", rb.connectionState === "connected");

// project + settings round-trip
await rb.db.saveProject({ id: "p1", name: "smoke", cwd: process.cwd(), icon: null, archived: false });
const projects = await rb.db.loadProjects();
check("project.list", projects.some((p) => p.id === "p1"), `(${projects.length})`);

const shells = await rb.shell.availableShells();
check("shell.available iconKey mapped", shells.length > 0 && shells.every((s) => "iconKey" in s));

// pty open (spawn path) + live output
const threadId = crypto.randomUUID();
let out = "";
const key = await rb.pty.open(
  {
    threadId,
    spec: {
      cwd: process.cwd(),
      cmd: "cmd",
      args: ["/c", "echo REMOTEMARK & ping -n 3 127.0.0.1 >NUL"],
      cols: 80,
      rows: 24,
    },
    meta: { projectId: "p1", label: "t", iconKey: null },
  },
  (e) => {
    if (e.type === "output") {
      const chunk = dec.decode(e.bytes);
      out += chunk;
      // ConPTY DSR: answer the cursor-position query so output flows.
      if (chunk.indexOf("\x1b[6n") >= 0) {
        void rb.pty.write(key, new TextEncoder().encode("\x1b[1;1R"));
      }
    }
  },
);
check("pty.open returns key", !!key, `key=${String(key).slice(0, 8)}`);

await sleep(1200);
check("live output", out.includes("REMOTEMARK"), `(${out.length} bytes)`);

// detach (release) then reattach -> replay carries the earlier output
await rb.pty.release(key);
await sleep(300);
out = "";
const key2 = await rb.pty.open(
  {
    threadId,
    spec: { cwd: process.cwd(), cmd: "cmd", args: [], cols: 80, rows: 24 },
    meta: { projectId: "p1", label: "t", iconKey: null },
  },
  (e) => {
    if (e.type === "output") out += dec.decode(e.bytes);
  },
);
await sleep(400);
check("reattach replay", out.includes("REMOTEMARK"));

const threads = await rb.db.loadThreads();
const t = threads.find((x) => x.id === threadId);
check("thread.list live", t?.status === "running" && !!t?.ptyId, `status=${t?.status}`);

await rb.pty.kill(key2);
await sleep(200);
// The device this run paired for itself, so a boite it is pointed at does not
// collect one per run.
await rb.pairing?.revoke(paired.pairing.id);
rb.dispose();

console.log(fail ? "\nREMOTE SMOKE FAIL" : "\nREMOTE SMOKE PASS");
process.exit(fail ? 1 : 0);
