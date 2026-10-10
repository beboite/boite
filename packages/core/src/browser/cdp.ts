/*
 * A DevTools protocol connection to one Chromium process, in flat session
 * mode: one channel carries the browser's own commands and those of every
 * page it attached, each tagged with its `sessionId`. The channel is the two
 * pipes `--remote-debugging-pipe` gives (descriptors 3 and 4 of the browser,
 * one JSON message per NUL), so no port is open for another process to use.
 * On Windows, where Bun cannot open those descriptors, it is a WebSocket to a
 * random loopback port instead.
 */

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;
interface Waiting { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; method: string }

/** What a command may take before the page is called stuck. */
const COMMAND_TIMEOUT_MS = 30_000;

export class CdpError extends Error {}

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
    this.#ended = () => { this.#fail(new CdpError('the browser closed its DevTools pipe')); settle(); };
  }
  #ended: () => void;

  /**
   * `commands` is this side of the browser's descriptor 3, which it reads;
   * `replies` this side of its descriptor 4, which it writes.
   */
  static pipe(commands: number, replies: number): Cdp {
    const writer = Bun.file(commands).writer();
    const reader = Bun.file(replies).stream().getReader();
    const cdp = new Cdp(text => { writer.write(`${text}\0`); void Promise.resolve(writer.flush()).catch(() => {}); }, () => {
      void reader.cancel().catch(() => {});
      try { void Promise.resolve(writer.end()).catch(() => {}); } catch { /* already closed */ }
    });
    void (async () => {
      const decoder = new TextDecoder();
      let pending: Uint8Array[] = [], size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          let start = 0;
          for (let at = value.indexOf(0); at !== -1; at = value.indexOf(0, start)) {
            const part = value.subarray(start, at);
            const whole = pending.length ? concat([...pending, part], size + part.length) : part;
            pending = []; size = 0;
            cdp.#receive(decoder.decode(whole));
            start = at + 1;
          }
          if (start < value.length) { const rest = value.slice(start); pending.push(rest); size += rest.length; }
        }
      } catch { /* the pipe broke: the browser is gone */ }
      cdp.#ended();
    })();
    return cdp;
  }

  /** The Windows transport: the browser's WebSocket endpoint on 127.0.0.1. */
  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.close(); reject(new CdpError(`the browser did not accept a DevTools connection within ${timeoutMs / 1000} seconds`)); }, timeoutMs);
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new CdpError(`could not connect to the browser's DevTools at ${url}`)); }, { once: true });
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        const cdp = new Cdp(text => socket.send(text), () => { try { socket.close(); } catch { /* already gone */ } });
        socket.addEventListener('message', event => cdp.#receive(String(event.data)));
        socket.addEventListener('close', () => cdp.#ended());
        resolve(cdp);
      }, { once: true });
    });
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
      this.#waiting.set(id, { resolve: resolve as (value: Record<string, unknown>) => void, reject, timer, method });
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

  close(): void {
    this.#fail(new CdpError('the browser connection was closed'));
    this.#stop();
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
