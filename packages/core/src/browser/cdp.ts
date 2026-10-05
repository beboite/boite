/*
 * A DevTools protocol connection to one Chromium process, in flat session
 * mode: one WebSocket carries the browser's own commands and those of every
 * page it attached, each tagged with its `sessionId`.
 */

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;
interface Waiting { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; method: string }

/** What a command may take before the page is called stuck. */
const COMMAND_TIMEOUT_MS = 30_000;

export class CdpError extends Error {}

export class Cdp {
  #socket: WebSocket;
  #next = 1;
  #waiting = new Map<number, Waiting>();
  #listeners = new Map<string, Set<Listener>>();
  #closed: Error | null = null;
  readonly closed: Promise<void>;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    let settle!: () => void;
    this.closed = new Promise(resolve => { settle = resolve; });
    socket.addEventListener('message', event => this.#receive(String(event.data)));
    socket.addEventListener('close', () => { this.#fail(new CdpError('the browser closed its DevTools connection')); settle(); });
    socket.addEventListener('error', () => this.#fail(new CdpError('the browser DevTools connection failed')));
  }

  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.close(); reject(new CdpError(`the browser did not accept a DevTools connection within ${timeoutMs / 1000} seconds`)); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new Cdp(socket)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new CdpError(`could not connect to the browser's DevTools at ${url}`)); }, { once: true });
    });
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
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
    try { this.#socket.close(); } catch { /* already gone */ }
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
