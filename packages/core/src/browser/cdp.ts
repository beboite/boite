/*
 * A DevTools protocol connection to one Chromium process, in flat session
 * mode: one channel carries the browser's own commands and those of every
 * page it attached, each tagged with its `sessionId`. The channel is the
 * browser's descriptors 3 and 4 under `--remote-debugging-pipe`, two socket
 * pairs carrying one JSON message per NUL, so no port is open for another
 * process to use.
 * On Windows, where Bun cannot open those descriptors, it is a WebSocket to a
 * random loopback port instead, read by `ws-client.ts` rather than Bun's own
 * client, which loses frames of a sound stream and closes it with 1002.
 */

import { fstatSync } from 'node:fs';
import { TextSocket, UpgradeError } from '../ws-client.ts';

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;
interface Waiting { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; method: string; sessionId?: string }

/** What a command may take before the page is called stuck. */
const COMMAND_TIMEOUT_MS = 30_000;

export class CdpError extends Error {}

/** The connection is live, but the session awaiting this command has detached. */
export class CdpSessionDetachedError extends CdpError {
  constructor(readonly method: string, readonly sessionId: string) {
    super(`${method}: DevTools session ${sessionId} detached before answering`);
    this.name = 'CdpSessionDetachedError';
  }
}

export class Cdp {
  #write: (text: string) => void;
  #stop: () => void;
  #next = 1;
  #waiting = new Map<number, Waiting>();
  #listeners = new Map<string, Set<Listener>>();
  #closed: Error | null = null;
  readonly closed: Promise<void>;

  private constructor(write: (text: string) => void, stop: () => void) {
    this.#write = write; this.#stop = stop;
    let settle!: () => void;
    this.closed = new Promise(resolve => { settle = resolve; });
    this.#settle = settle;
    this.#ended = () => { this.#fail(new CdpError('the browser closed its DevTools pipe')); settle(); };
  }
  #ended: () => void;
  #settle: () => void;

  /**
   * `commands` is this side of the browser's descriptor 3, which it reads;
   * `replies` this side of its descriptor 4, which it writes. `procs.spawn`
   * makes each a socket pair, so both are opened as the sockets they are.
   * `Bun.file(fd).stream()` on the replies stopped being polled under load
   * (Bun 1.4.2 and 1.4.3 on Linux: its one-shot epoll registration was never
   * armed again while the browser's answers waited in the socket), and every
   * command after that timed out.
   */
  static async pipe(commands: number, replies: number): Promise<Cdp> {
    for (const fd of [commands, replies]) if (!fstatSync(fd).isSocket()) throw new CdpError(`the browser's DevTools descriptor ${fd} is not a socket pair; expected the sockets procs.spawn opens with extraPipes`);
    const decoder = new TextDecoder(), encoder = new TextEncoder();
    let pending: Uint8Array[] = [], size = 0;
    let reader: Bun.Socket | undefined, writer: Bun.Socket | undefined;
    // A socket takes what fits; the rest goes when it drains, in order.
    const queue: Uint8Array[] = [];
    const flush = (socket: Bun.Socket) => {
      while (queue.length) {
        const chunk = queue[0]!, written = socket.write(chunk);
        // Shut or failed for good (`-errno`), and Bun does not close it: the commands waiting would only time out.
        if (written < 0) { queue.length = 0; ended(); return; }
        if (written < chunk.length) { queue[0] = chunk.subarray(written); return; }
        queue.shift();
      }
    };
    const cdp = new Cdp(text => {
      queue.push(encoder.encode(`${text}\0`));
      if (writer && queue.length === 1) flush(writer);
    }, () => { writer?.end(); reader?.end(); });
    const ended = () => cdp.#ended();
    const connect = Bun.connect as unknown as (options: Bun.FdSocketOptions) => Promise<Bun.Socket>;
    reader = await connect({ fd: replies, socket: {
      data(_socket, value: Uint8Array) {
        let start = 0;
        for (let at = value.indexOf(0); at !== -1; at = value.indexOf(0, start)) {
          const part = value.subarray(start, at);
          const whole = pending.length ? concat([...pending, part], size + part.length) : part;
          pending = []; size = 0;
          cdp.#receive(decoder.decode(whole));
          start = at + 1;
        }
        // The socket's buffer is reused once this returns.
        if (start < value.length) { const rest = Uint8Array.prototype.slice.call(value, start); pending.push(rest); size += rest.length; }
      },
      end(socket) { socket.end(); ended(); },
      close: ended,
      error: ended,
    } });
    try {
      writer = await connect({ fd: commands, socket: { data() {}, drain: flush, close: ended, error: ended } });
    } catch (error) { reader.end(); throw error; }
    flush(writer);
    return cdp;
  }

  /** The Windows transport: the browser's WebSocket endpoint on 127.0.0.1. */
  static async connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    const socket = await TextSocket.connect(url, timeoutMs).catch((error: unknown) => {
      throw new CdpError(error instanceof UpgradeError && error.timedOut
        ? `the browser did not accept a DevTools connection within ${timeoutMs / 1000} seconds`
        : `could not connect to the browser's DevTools at ${url}: ${error instanceof Error ? error.message : String(error)}`);
    });
    const cdp = new Cdp(text => socket.send(text), () => socket.close());
    socket.onMessage(text => cdp.#receive(text));
    socket.onClose(() => cdp.#ended());
    return cdp;
  }

  /**
   * A connection someone else carries: the desktop app relays each message to
   * its own webviews and hands back their answers and events (`browser/host.ts`).
   */
  static relay(write: (text: string) => void, stop: () => void): { cdp: Cdp; receive(text: string): void; end(): void } {
    const cdp = new Cdp(write, stop);
    return { cdp, receive: text => cdp.#receive(text), end: () => cdp.#ended() };
  }
  get open(): boolean { return this.#closed === null; }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new CdpError(`the browser did not answer ${method} within ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      this.#waiting.set(id, { resolve: resolve as (value: Record<string, unknown>) => void, reject, timer, method, sessionId });
      this.#write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Every `method` event, from the browser or any attached page; returns the unsubscribe. */
  on(method: string, listener: Listener): () => void {
    let set = this.#listeners.get(method);
    if (!set) this.#listeners.set(method, set = new Set());
    set.add(listener);
    return () => { set.delete(listener); };
  }

  /**
   * `closed` settles here too: a relay's carrier never reports the end of a
   * connection the core closed itself, and a hosted engine's `exited` is that
   * promise, so its profile stayed taken for good (`BrowserEngines.get`).
   */
  close(): void {
    this.#fail(new CdpError('the browser connection was closed'));
    this.#stop();
    this.#settle();
  }

  #receive(text: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string };
    try { message = JSON.parse(text); } catch { return; }
    if (typeof message.id === 'number') {
      const waiting = this.#waiting.get(message.id);
      if (!waiting) return;
      this.#waiting.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new CdpError(`${waiting.method}: ${String(message.error.message ?? 'failed').slice(0, 500)}`));
      else waiting.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    if (message.method === 'Target.detachedFromTarget' && typeof message.params?.sessionId === 'string') {
      const sessionId = message.params.sessionId;
      for (const [id, waiting] of this.#waiting) {
        if (waiting.sessionId !== sessionId) continue;
        this.#waiting.delete(id); clearTimeout(waiting.timer);
        waiting.reject(new CdpSessionDetachedError(waiting.method, sessionId));
      }
    }
    for (const listener of this.#listeners.get(message.method) ?? []) {
      try { listener(message.params ?? {}, message.sessionId); } catch { /* a listener's fault stays its own */ }
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const waiting of this.#waiting.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.#waiting.clear();
  }
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { whole.set(part, at); at += part.length; }
  return whole;
}
