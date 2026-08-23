import type { ControlEvent, ServerIdentity } from "../types";
import type { Platform } from "$lib/storage/platform.svelte";

export type ConnState = "connecting" | "connected" | "disconnected";

/**
 * Why a dial failed. `auth` is the only one a login form can fix, so it is the
 * only one that should ever raise the login gate; the rest mean the boite was
 * never reached and retrying is the answer.
 */
export type ConnFailReason = "auth" | "unreachable" | "timeout" | "url";

export class ConnectError extends Error {
  readonly reason: ConnFailReason;
  constructor(reason: ConnFailReason, message: string) {
    super(message);
    this.name = "ConnectError";
    this.reason = reason;
  }
}

/**
 * An error the server sent back, as opposed to one this side invented when the
 * socket died under it. This is what tells a refused token apart from a boite
 * that never answered: both used to arrive as a bare Error and the app could
 * only guess, so it guessed "wrong credentials" every time.
 */
class RpcError extends Error {}

export function connectFailReason(e: unknown): ConnFailReason {
  return e instanceof ConnectError ? e.reason : "unreachable";
}

const FRAME_OUTPUT = 0x01;
const FRAME_INPUT = 0x02;
const FRAME_OUTPUT_GZIP = 0x03;
const RPC_TIMEOUT = 20_000;
const CONNECT_TIMEOUT = 12_000;
const TICKET_TIMEOUT = 10_000;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 30_000;

/**
 * The HTTP origin behind a `ws://` URL, with the socket's own path taken off.
 *
 * A boite is not always at the root: a reverse proxy serving it under `/boite`
 * gives `wss://host/boite/ws`, and the ticket endpoint is then
 * `https://host/boite/api/ticket`. Stripping the trailing `/ws` rather than
 * replacing the whole path is what keeps that working.
 */
export function httpBase(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/ws\/?$/, "");
  return u.toString().replace(/\/$/, "");
}

/**
 * Buys a ticket for one socket.
 *
 * This is the only place the long-lived credential is presented, and it is
 * presented in a header over HTTP: the WebSocket handshake's URL would reach a
 * reverse proxy's access log, and nobody rotates those. What comes back is
 * single-use and expires in five minutes, so the frame that carries it through
 * the same proxy is worth nothing by the time anybody reads it back.
 *
 * A `401` is the one failure the login form can fix, so it is the only one that
 * raises the gate. Anything else is a boite that was not reached.
 */
async function buyTicket(wsUrl: string, credential: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TICKET_TIMEOUT);
  let res: Response;
  try {
    res = await fetch(`${httpBase(wsUrl)}/api/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
  } catch (e) {
    throw new ConnectError(
      controller.signal.aborted ? "timeout" : "unreachable",
      e instanceof Error ? e.message : "could not reach the boite",
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    throw new ConnectError("auth", "this device is not paired with that boite");
  }
  if (!res.ok) {
    throw new ConnectError("unreachable", `ticket refused (${res.status})`);
  }
  const body = (await res.json().catch(() => null)) as { ticket?: unknown } | null;
  if (typeof body?.ticket !== "string" || !body.ticket) {
    throw new ConnectError("unreachable", "the boite issued no ticket");
  }
  return body.ticket;
}

/**
 * The calls twenty seconds is the wrong number for, and what each one is
 * actually waiting on.
 *
 * One flat ceiling treats a question about a directory and a `git push` over a
 * mobile link as the same kind of work. They are not, and the failure was not
 * symmetric: a slow read that times out is a read to ask again, while a write
 * that times out is reported as a write that did not happen. A push that landed
 * at twenty-one seconds came back as an error, and the branch was on the remote
 * the whole time.
 *
 * Every entry is a ceiling on something the boite does with a disk or a network,
 * never a target. Nothing here waits the full amount in the ordinary case.
 */
const RPC_TIMEOUTS: Record<string, number> = {
  // Who the boite is, on a socket that is already open. Held short on purpose:
  // the handshake waits for it, so a server that will not answer must cost the
  // connection a few seconds rather than the flat ceiling.
  hello: 5_000,
  // A year of transcripts, per directory: two directory walks and a JSON parse
  // per session that has moved since it was last read. `USAGE_DAYS` is 371, and
  // a boite that has been worked in all year has thousands of them — a warm
  // scan answers in milliseconds, but the first one on a cold cache reads the
  // whole year off the disk and that is what this ceiling is for.
  "session.usage": 180_000,
  // Objects over whatever link the boite has to the forge. Nothing bounds this
  // but the size of what is being sent.
  "git.push": 300_000,
  "git.pull": 300_000,
  "git.fetch": 300_000,
  // `git worktree add`, plus the junctions it makes, against a cold repository.
  // This is the call a new agent thread waits on before it has a directory.
  "worktree.open": 120_000,
  // Walks every file of every checkout of the repository.
  "worktree.sizes": 120_000,
  // A long-poll by design: the server may hold it open for up to 120 s
  // (`boite_core::pulse::MAX_TIMEOUT_MS`) before answering "nothing happened".
  // The ceiling sits just above that, so only a genuinely dead socket trips it.
  "conduct.pulse": 130_000,
};

function rpcTimeout(method: string): number {
  return RPC_TIMEOUTS[method] ?? RPC_TIMEOUT;
}

/**
 * `hello`, as far as it can be trusted. Every field but the protocol is read
 * defensively and left null when it is not there: a server built before this
 * answered with `{ ok, protocol }` and nothing else, and null is what draws as
 * "it did not say" rather than as a machine named `undefined`.
 */
function readIdentity(r: unknown): ServerIdentity {
  const d = (r ?? {}) as {
    protocol?: unknown;
    version?: unknown;
    platform?: unknown;
    host?: unknown;
  };
  const os = d.platform;
  return {
    protocol: typeof d.protocol === "number" ? d.protocol : 0,
    version: typeof d.version === "string" && d.version ? d.version : null,
    platform:
      os === "windows" || os === "macos" || os === "linux" || os === "unknown"
        ? (os as Platform)
        : null,
    host: typeof d.host === "string" && d.host ? d.host : null,
  };
}

// DecompressionStream is missing on some older WebKitGTK builds; only advertise
// gzip support to the server when we can actually inflate.
const GZIP_OK = typeof DecompressionStream !== "undefined";

async function inflateGzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function uuidToBytes(u: string): Uint8Array {
  const hex = u.replace(/-/g, "");
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

function bytesToUuid(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < 16; i++) h += b[i].toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AttachReg {
  cols: number;
  rows: number;
  onOutput: (bytes: Uint8Array) => void;
  onReset: () => void;
  // A reconnect found the row but no PTY behind it: the server restarted under
  // us. The socket cannot fix that alone, since only the caller holds the spawn
  // spec, so it hands the thread back instead of leaving a blank pane.
  onLost?: () => void;
}

interface PendingReplay {
  reset: boolean;
  offset: number;
}

export interface SocketOptions {
  /**
   * Whether the socket schedules its own reconnects.
   *
   * False hands that job to an `EnvironmentSupervisor`, which is the only retry
   * owner once several environments are live: two backoff loops on one link
   * dial twice as often as either was written to, and neither can see the other
   * to stop.
   */
  autoReconnect?: boolean;
}

// One multiplexed WebSocket per remote workspace: JSON control plane (auth,
// RPC request/response, server events) plus binary frames for PTY I/O
// ([opcode][16-byte thread uuid][payload]). Reconnects with exponential
// backoff and re-attaches every tracked thread (the server replays scrollback).
// Writes are dropped while disconnected: replaying stale keystrokes into a live
// agent is worse than losing them. What the state callback drives has to make
// that loss visible, because this side cannot.
//
// Every dial is two steps now: an HTTP round trip that turns this device's
// long-lived credential into a five-minute single-use ticket, then the socket,
// which sees only the ticket. The credential never reaches a frame and never
// reaches a URL.
export class Socket {
  #url: string;
  #token: string;
  // A dial is in flight but no socket exists yet: the ticket is still being
  // bought. `#ws` is null for that whole window, so without this a manual retry
  // lands on top of an attempt already running.
  #dialing = false;
  #ws: WebSocket | null = null;
  #state: ConnState = "disconnected";
  #stateCb: (s: ConnState) => void;
  #authRejectedCb: () => void;
  // A refused token will be refused again, so the backoff loop stops rather
  // than hammering the boite with a credential it already said no to.
  #authRejected = false;
  // What the boite answered `hello` with, re-read on every successful
  // handshake: a server that was redeployed under a reconnect is a different
  // build, and the previous one's version would outlive it otherwise.
  #server: ServerIdentity | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #control = new Set<(e: ControlEvent) => void>();
  #attached = new Map<string, AttachReg>();
  // Per-thread byte offset (absolute count of output bytes consumed). Sent as
  // `since` on reattach so the server replies with just the delta. Survives a
  // detach so unhiding a thread costs only the bytes produced while hidden.
  #offsets = new Map<string, number>();
  // A "replay" marker sets this; the next binary frame for that thread is the
  // replay body (reset => clear first), not a live frame.
  #pendingReplay = new Map<string, PendingReplay>();
  // Serialize binary-frame handling: a gzip replay inflates asynchronously and
  // must not let the live frames behind it overtake it.
  #binChain: Promise<void> = Promise.resolve();
  #closed = false;
  #backoff = BACKOFF_MIN;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #autoReconnect: boolean;

  constructor(
    url: string,
    token: string,
    onState: (s: ConnState) => void,
    onAuthRejected: () => void = () => {},
    options: SocketOptions = {},
  ) {
    this.#url = url;
    this.#token = token;
    this.#stateCb = onState;
    this.#authRejectedCb = onAuthRejected;
    this.#autoReconnect = options.autoReconnect !== false;
  }

  get state(): ConnState {
    return this.#state;
  }

  get authRejected(): boolean {
    return this.#authRejected;
  }

  // Set before the state reaches "connected", so anything that reads this off a
  // connected socket finds it there. Null is a socket that has never completed a
  // handshake, or one whose `hello` failed.
  get serverIdentity(): ServerIdentity | null {
    return this.#server;
  }

  connect(): Promise<void> {
    this.#closed = false;
    this.#authRejected = false;
    return this.#open();
  }

  // Manual retry from the connection banner. The scheduled attempt can be half a
  // minute out, and someone who just fixed their wifi should not wait for it.
  retryNow(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    // A dial is already in flight (#ws lives from construction to onclose, and
    // #dialing covers the ticket round trip before it).
    if (this.#ws || this.#dialing) return;
    this.#closed = false;
    this.#authRejected = false;
    this.#backoff = BACKOFF_MIN;
    void this.#open().catch(() => {});
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#failAllPending(new Error("socket disposed"));
    this.#server = null;
    this.#attached.clear();
    this.#offsets.clear();
    this.#pendingReplay.clear();
    this.#binChain = Promise.resolve();
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
    this.#setState("disconnected");
  }

  rpc(method: string, params: unknown = {}): Promise<any> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("socket not open"));
    }
    const id = this.#nextId++;
    const ceiling = rpcTimeout(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`rpc timeout: ${method} (${ceiling}ms)`));
      }, ceiling);
      this.#pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Returns whether the bytes left this device. False is a keystroke thrown away:
  // queueing it would replay stale input into a live agent minutes later. The
  // user has to learn about the loss from the connection state, which is why the
  // banner exists at all.
  sendInput(threadId: string, data: Uint8Array): boolean {
    const ws = this.#ws;
    if (!ws || this.#state !== "connected") return false;
    const frame = new Uint8Array(17 + data.length);
    frame[0] = FRAME_INPUT;
    frame.set(uuidToBytes(threadId), 1);
    frame.set(data, 17);
    ws.send(frame);
    return true;
  }

  // Register the output sink BEFORE the attach RPC: the server pushes the
  // replay marker and scrollback frame ahead of the attach response.
  async attach(
    threadId: string,
    cols: number,
    rows: number,
    onOutput: (bytes: Uint8Array) => void,
    onReset: () => void,
    onLost?: () => void,
  ): Promise<{ ptyId?: string; size?: { cols: number; rows: number } }> {
    this.#attached.set(threadId, { cols, rows, onOutput, onReset, onLost });
    try {
      return await this.rpc("thread.attach", this.#attachParams(threadId, cols, rows));
    } catch (e) {
      this.#attached.delete(threadId);
      throw e;
    }
  }

  // Keep the offset across detach so reattaching only pulls the delta; drop the
  // pending replay since no frame will follow once detached.
  detach(threadId: string): Promise<void> {
    this.#attached.delete(threadId);
    this.#pendingReplay.delete(threadId);
    return this.rpc("thread.detach", { threadId })
      .then(() => {})
      .catch(() => {});
  }

  #attachParams(threadId: string, cols: number, rows: number): Record<string, unknown> {
    const params: Record<string, unknown> = { threadId, cols, rows, gzip: GZIP_OK };
    const since = this.#offsets.get(threadId);
    if (since !== undefined) params.since = since;
    return params;
  }

  setAttachSize(threadId: string, cols: number, rows: number): void {
    const reg = this.#attached.get(threadId);
    if (reg) {
      reg.cols = cols;
      reg.rows = rows;
    }
  }

  onControl(cb: (e: ControlEvent) => void): () => void {
    this.#control.add(cb);
    return () => this.#control.delete(cb);
  }

  async #open(): Promise<void> {
    this.#setState("connecting");
    this.#dialing = true;
    let ticket: string;
    try {
      ticket = await buyTicket(this.#url, this.#token);
    } catch (e) {
      this.#dialing = false;
      this.#setState("disconnected");
      if (e instanceof ConnectError && e.reason === "auth") {
        this.#authRejected = true;
        this.#authRejectedCb();
      } else if (!this.#closed) {
        this.#scheduleReconnect();
      }
      throw e;
    }
    try {
      return await this.#openWith(ticket);
    } finally {
      this.#dialing = false;
    }
  }

  #openWith(ticket: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      // `new WebSocket` throws synchronously when CSP blocks the URL or it is
      // malformed; turn that into a normal rejection instead of an unhandled
      // throw inside the executor.
      try {
        ws = new WebSocket(this.#url);
      } catch (e) {
        this.#setState("disconnected");
        reject(
          new ConnectError(
            "url",
            e instanceof Error ? e.message : "WebSocket construction failed",
          ),
        );
        return;
      }
      ws.binaryType = "arraybuffer";
      this.#ws = ws;

      // A blocked or unreachable host can sit in CONNECTING for the OS TCP
      // timeout (~minutes). Bound it so the picker button does not hang.
      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // already closing
        }
        reject(new ConnectError("timeout", "connect timeout"));
      }, CONNECT_TIMEOUT);

      ws.onopen = () => {
        // The ticket, and nothing else. A device credential presented here is
        // refused by the server on purpose: accepting both would leave the
        // shape this replaced working under a new name.
        this.rpc("auth", { ticket })
          .then(async () => {
            this.#backoff = BACKOFF_MIN;
            // Asked here rather than by a caller, and asked again on every
            // reconnect. It is one round trip on a socket that is already open,
            // and it has to be in hand before the state says "connected":
            // whatever reads the boite's version has that flag as its only
            // reactive signal, and a `hello` that landed after it would never
            // be looked at again. A failure costs the identity and not the
            // connection: a server too old to answer is still a server.
            const identity = this.rpc("hello")
              .then((r) => readIdentity(r))
              .catch(() => null);
            // Reconnect: re-attach everything. The server sends only the delta
            // since our tracked offset (full ring + reset if it rolled off).
            // Fired, never awaited, so the replay is already on the wire while
            // the answer above is still coming back.
            for (const [threadId, reg] of this.#attached) {
              this.rpc(
                "thread.attach",
                this.#attachParams(threadId, reg.cols, reg.rows),
              ).catch((e) => {
                // The row outlived its PTY, so the server went down and came
                // back between our two attaches. Every other failure is the
                // transport dropping again, which the next reconnect retries.
                if (!String(e).includes("not live")) return;
                this.#offsets.delete(threadId);
                this.#pendingReplay.delete(threadId);
                reg.onReset();
                reg.onLost?.();
              });
            }
            this.#server = await identity;
            // The connect timeout can have closed this socket while `hello` was
            // out; `onclose` already published "disconnected" and dropped it.
            // Calling `connected` on it now would light a link that is gone.
            if (this.#ws !== ws) return;
            this.#setState("connected");
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              resolve();
            }
          })
          .catch((e) => {
            // A ticket refused here is NOT a refused credential, and latching
            // the login gate on it is the bug this used to have in another
            // shape. The credential was already accepted seconds ago, at the
            // ticket door; what failed is a ticket that expired, raced with a
            // revocation, or never reached the server. So this reconnects,
            // which buys a fresh one, and the `401` there is the one answer
            // that raises the gate. A socket that died mid-handshake reads the
            // same way, which is what kept a PWA with no network off the login
            // form.
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              reject(
                new ConnectError(
                  "unreachable",
                  e instanceof Error ? e.message : "auth failed",
                ),
              );
            }
            ws.close();
          });
      };

      ws.onmessage = (ev) => this.#onMessage(ev);

      ws.onclose = () => {
        clearTimeout(connectTimer);
        this.#failAllPending(new Error("socket closed"));
        this.#ws = null;
        this.#setState("disconnected");
        if (!this.#closed) this.#scheduleReconnect();
        if (!settled) {
          settled = true;
          reject(new ConnectError("unreachable", "socket closed before auth"));
        }
      };

      ws.onerror = () => {
        // onclose fires next; reconnect is handled there.
      };
    });
  }

  #onMessage(ev: MessageEvent): void {
    if (typeof ev.data === "string") {
      let msg: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; data?: unknown };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id != null && this.#pending.has(msg.id)) {
        const p = this.#pending.get(msg.id)!;
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok === false) p.reject(new RpcError(msg.error ?? "rpc error"));
        else p.resolve(msg.result);
        return;
      }
      if (typeof msg.event === "string") {
        // Consumed here, not forwarded: the replay marker pairs with the binary
        // frame that follows it, not the app-level control plane. It goes
        // through #binChain like the frames do — handling it synchronously let
        // it overtake a binary frame still queued behind a gzip inflate, and
        // that stale live frame was then consumed as the replay body: terminal
        // cleared at the wrong point, offset left pointing at the wrong byte.
        if (msg.event === "replay") {
          const data = msg.data;
          this.#chain(() => this.#onReplayMarker(data));
          return;
        }
        const ce: ControlEvent = { event: msg.event, data: msg.data };
        for (const cb of this.#control) cb(ce);
      }
      return;
    }
    const buf = new Uint8Array(ev.data as ArrayBuffer);
    if (buf.length < 17) return;
    const op = buf[0];
    if (op !== FRAME_OUTPUT && op !== FRAME_OUTPUT_GZIP) return;
    // Chain so a gzip replay's async inflate keeps frame order intact.
    this.#chain(() => this.#handleBinary(op, buf));
  }

  // Serializes output-plane work (replay markers and binary frames) in arrival
  // order. The catch matters: one rejection would leave #binChain permanently
  // rejected and silently swallow every later frame on the socket.
  #chain(step: () => void | Promise<void>): void {
    this.#binChain = this.#binChain.then(step).catch(() => {});
  }

  #onReplayMarker(data: unknown): void {
    const d = data as { threadId?: string; reset?: boolean; offset?: number } | null;
    if (!d?.threadId) return;
    this.#pendingReplay.set(d.threadId, {
      reset: !!d.reset,
      offset: typeof d.offset === "number" ? d.offset : 0,
    });
  }

  async #handleBinary(op: number, buf: Uint8Array): Promise<void> {
    const threadId = bytesToUuid(buf.subarray(1, 17));
    const reg = this.#attached.get(threadId);
    if (!reg) return;
    let payload = buf.subarray(17);
    if (op === FRAME_OUTPUT_GZIP) {
      try {
        payload = await inflateGzip(payload);
      } catch {
        return;
      }
    }
    const pending = this.#pendingReplay.get(threadId);
    if (pending) {
      this.#pendingReplay.delete(threadId);
      if (pending.reset) reg.onReset();
      if (payload.length) reg.onOutput(payload);
      // Replay ends exactly at the server's offset; trust it rather than the
      // (possibly decompressed) length.
      this.#offsets.set(threadId, pending.offset);
    } else {
      if (payload.length) reg.onOutput(payload);
      this.#offsets.set(threadId, (this.#offsets.get(threadId) ?? 0) + payload.length);
    }
  }

  #scheduleReconnect(): void {
    if (!this.#autoReconnect) return;
    if (this.#closed || this.#authRejected || this.#reconnectTimer) return;
    const base = Math.min(this.#backoff, BACKOFF_MAX);
    const delay = base * (0.5 + Math.random() * 0.5);
    this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open().catch(() => {});
    }, delay);
  }

  #failAllPending(err: Error): void {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }

  #setState(s: ConnState): void {
    if (this.#state === s) return;
    this.#state = s;
    this.#stateCb(s);
  }
}
