/*
 * A DevTools protocol connection to one Chromium process, in flat session
 * mode: one channel carries the browser's own commands and those of every
 * page it attached, each tagged with its `sessionId`. The channel is the
 * browser's descriptors 3 and 4 under `--remote-debugging-pipe`, two socket
 * pairs carrying one JSON message per NUL, so no port is open for another
 * process to use.
 * On Windows, where Bun cannot open those descriptors, it is a WebSocket to a
 * random loopback port instead.
 */

import { fstatSync } from 'node:fs';
import { loadavg } from 'node:os';

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;
interface Waiting { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; method: string }

/** What a command may take before the page is called stuck. */
const COMMAND_TIMEOUT_MS = 30_000;
/**
 * `BOITE_CDP_TRACE=1` (CI flake loops): a timed-out command also says how many
 * bytes of the browser's answers sit unread on the replies descriptor, the
 * machine's load, and whether the browser still answers `Browser.getVersion`.
 */
const TRACE = process.env.BOITE_CDP_TRACE === '1';

export class CdpError extends Error {}

export class Cdp {
  #write: (text: string) => void;
  #stop: () => void;
  #next = 1;
  #waiting = new Map<number, Waiting>();
  #listeners = new Map<string, Set<Listener>>();
  #closed: Error | null = null;
  /** When the last message from the browser arrived, for a timeout to say how long it has been quiet. */
  #heardAt = performance.now();
  /** Bytes waiting unread on the replies descriptor, under `BOITE_CDP_TRACE` and the pipe only. */
  #unread: (() => number | null) | null = null;
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
    if (TRACE) cdp.#unread = await unreadBytes(replies);
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
        const quiet = `the last message from the browser came ${Math.round(performance.now() - this.#heardAt)} ms ago`;
        const error = (detail: string) => new CdpError(`the browser did not answer ${method} within ${Math.round(timeoutMs / 1000)} seconds; ${quiet}${detail}`);
        if (!TRACE || method === 'Browser.getVersion') { reject(error('')); return; }
        void this.#trace().then(detail => reject(error(detail)));
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

  /** What `BOITE_CDP_TRACE` adds to a timeout: unread bytes, load, and a browser-level probe. */
  async #trace(): Promise<string> {
    const unread = this.#unread?.();
    const started = performance.now();
    const probe = await this.send('Browser.getVersion', {}, undefined, 5_000)
      .then(() => `answered in ${Math.round(performance.now() - started)} ms`, (error: Error) => error.message.split(';')[0]);
    const after = this.#unread?.();
    const bytes = unread === undefined || unread === null ? 'unread bytes unknown' : `${unread} bytes unread before the probe, ${after} after`;
    return `; trace: ${bytes}, load ${loadavg().map(n => n.toFixed(1)).join(' ')}, Browser.getVersion ${probe}; busiest: ${busiest()}`;
  }

  #receive(text: string): void {
    this.#heardAt = performance.now();
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

/** The ten processes using the most CPU, with their state and memory, and how many Chromium processes run. */
function busiest(): string {
  if (process.platform === 'win32') return 'not read on Windows';
  const ps = Bun.spawnSync(['ps', '-A', '-o', 'pid=,pcpu=,rss=,state=,comm='], { stdout: 'pipe', stderr: 'ignore' });
  const rows = ps.stdout.toString().trim().split('\n').map(line => line.trim().split(/\s+/))
    .map(([pid, cpu, rss, state, ...command]) => ({ pid, cpu: Number(cpu), rss: Math.round(Number(rss) / 1024), state, name: command.join(' ').split('/').pop() ?? '' }));
  const chromium = rows.filter(row => /chrom/i.test(row.name)).length;
  return `${chromium} Chromium processes; ` + rows.sort((a, b) => b.cpu - a.cpu).slice(0, 10).map(row => `${row.name} ${row.pid} ${row.cpu}% ${row.rss} MB ${row.state}`).join(', ');
}

/**
 * Peeks the bytes a socket holds without reading them, `recv(MSG_PEEK |
 * MSG_DONTWAIT)` through libc. Bytes there while a command times out mean the
 * browser answered and nobody read it; none mean the browser stayed silent.
 */
async function unreadBytes(fd: number): Promise<(() => number | null) | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    });
    const buffer = new Uint8Array(1 << 20);
    const flags = 0x2 | (process.platform === 'darwin' ? 0x80 : 0x40);
    return () => { const n = Number(libc.symbols.recv(fd, ptr(buffer), buffer.length, flags)); return n < 0 ? 0 : n; };
  } catch { return null; }
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { whole.set(part, at); at += part.length; }
  return whole;
}
