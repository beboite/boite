import type { ControlEvent } from "../types";

export type ConnState = "connecting" | "connected" | "disconnected";

const FRAME_OUTPUT = 0x01;
const FRAME_INPUT = 0x02;
const FRAME_OUTPUT_GZIP = 0x03;
const RPC_TIMEOUT = 20_000;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 30_000;

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
}

interface PendingReplay {
  reset: boolean;
  offset: number;
}

// One multiplexed WebSocket per remote workspace: JSON control plane (auth,
// RPC request/response, server events) plus binary frames for PTY I/O
// ([opcode][16-byte thread uuid][payload]). Reconnects with exponential
// backoff and re-attaches every tracked thread (the server replays scrollback).
// Writes are dropped while disconnected: replaying stale keystrokes into a live
// agent is worse than losing them.
export class Socket {
  #url: string;
  #token: string;
  #ws: WebSocket | null = null;
  #state: ConnState = "disconnected";
  #stateCb: (s: ConnState) => void;
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

  constructor(url: string, token: string, onState: (s: ConnState) => void) {
    this.#url = url;
    this.#token = token;
    this.#stateCb = onState;
  }

  get state(): ConnState {
    return this.#state;
  }

  connect(): Promise<void> {
    this.#closed = false;
    return this.#open();
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#failAllPending(new Error("socket disposed"));
    this.#attached.clear();
    this.#offsets.clear();
    this.#pendingReplay.clear();
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, RPC_TIMEOUT);
      this.#pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  sendInput(threadId: string, data: Uint8Array): void {
    const ws = this.#ws;
    if (!ws || this.#state !== "connected") return;
    const frame = new Uint8Array(17 + data.length);
    frame[0] = FRAME_INPUT;
    frame.set(uuidToBytes(threadId), 1);
    frame.set(data, 17);
    ws.send(frame);
  }

  // Register the output sink BEFORE the attach RPC: the server pushes the
  // replay marker and scrollback frame ahead of the attach response.
  async attach(
    threadId: string,
    cols: number,
    rows: number,
    onOutput: (bytes: Uint8Array) => void,
    onReset: () => void,
  ): Promise<{ ptyId?: string; size?: { cols: number; rows: number } }> {
    this.#attached.set(threadId, { cols, rows, onOutput, onReset });
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

  #open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#setState("connecting");
      let settled = false;
      const ws = new WebSocket(this.#url);
      ws.binaryType = "arraybuffer";
      this.#ws = ws;

      ws.onopen = () => {
        this.rpc("auth", { token: this.#token })
          .then(() => {
            this.#backoff = BACKOFF_MIN;
            this.#setState("connected");
            // Reconnect: re-attach everything. The server sends only the delta
            // since our tracked offset (full ring + reset if it rolled off).
            for (const [threadId, reg] of this.#attached) {
              this.rpc(
                "thread.attach",
                this.#attachParams(threadId, reg.cols, reg.rows),
              ).catch(() => {});
            }
            if (!settled) {
              settled = true;
              resolve();
            }
          })
          .catch((e) => {
            if (!settled) {
              settled = true;
              reject(e);
            }
            ws.close();
          });
      };

      ws.onmessage = (ev) => this.#onMessage(ev);

      ws.onclose = () => {
        this.#failAllPending(new Error("socket closed"));
        this.#ws = null;
        this.#setState("disconnected");
        if (!this.#closed) this.#scheduleReconnect();
        if (!settled) {
          settled = true;
          reject(new Error("socket closed before auth"));
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
        if (msg.ok === false) p.reject(new Error(msg.error ?? "rpc error"));
        else p.resolve(msg.result);
        return;
      }
      if (typeof msg.event === "string") {
        // Consumed here, not forwarded: the replay marker pairs with the binary
        // frame that follows it, not the app-level control plane.
        if (msg.event === "replay") {
          this.#onReplayMarker(msg.data);
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
    this.#binChain = this.#binChain.then(() => this.#handleBinary(op, buf));
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
    if (this.#closed || this.#reconnectTimer) return;
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
