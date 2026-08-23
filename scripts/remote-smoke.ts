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

// The one command this drives has to exist on whatever runs it. `cmd` is not on
// a Linux runner and `sh` is not on Windows, and a script that only ever ran on
// its author's machine is how this one reached CI red the first time it was
// wired up: it passed here and could not have passed there. Both spellings
// print the same mark and then stay alive long enough for the detach-and-
// reattach half to have something to replay.
const WINDOWS = process.platform === "win32";
const MARKER = "REMOTEMARK";
// The second mark is printed a second later, which is what the reattach half
// reads. A remote reattach asks for the delta since the byte this client
// already has — that is the point of keeping the offset across a detach, so a
// terminal does not redraw what is already on it — so the first mark is
// precisely what a correct server does not send again, and a check for it
// tested the ConPTY redraw that happened to resend it rather than the replay.
const MARKER2 = "REMOTEBACK";
const talker = WINDOWS
  ? {
      cmd: "cmd",
      args: [
        "/c",
        `echo ${MARKER} & ping -n 2 127.0.0.1 >NUL & echo ${MARKER2} & ping -n 30 127.0.0.1 >NUL`,
      ],
    }
  : { cmd: "sh", args: ["-c", `echo ${MARKER}; sleep 1; echo ${MARKER2}; sleep 30`] };
// Reattaching wants a shell that sits there rather than the command above a
// second time: the point is the replay, and a fresh copy of the same output
// would pass the check whether or not anything was replayed.
const idler = { cmd: WINDOWS ? "cmd" : "sh", args: [] as string[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Output arrives when it arrives: a spawn on a cold shared runner is slower
// than the same spawn on a laptop, and a fixed wait long enough for the slow
// case is dead time in every other run. This waits for the thing it is about
// to assert on and gives up at the deadline, so a real failure still fails.
async function until(cond: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

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
    spec: { cwd: process.cwd(), ...talker, cols: 80, rows: 24 },
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

await until(() => out.includes(MARKER));
check("live output", out.includes(MARKER), `(${out.length} bytes)`);

// detach (release), let the terminal talk to nobody for a moment, then
// reattach: what comes back is what was missed.
await rb.pty.release(key);
await sleep(1500);
out = "";
const key2 = await rb.pty.open(
  {
    threadId,
    spec: { cwd: process.cwd(), ...idler, cols: 80, rows: 24 },
    meta: { projectId: "p1", label: "t", iconKey: null },
  },
  (e) => {
    if (e.type === "output") out += dec.decode(e.bytes);
  },
);
await until(() => out.includes(MARKER2));
check("reattach replays what was missed", out.includes(MARKER2), `(${out.length} bytes)`);

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
