import type { Socket } from 'node:net';
import type { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';

/** Benchmark-only transport. BrowserDaemon still owns launch and cleanup.
 * Its normal command transport replaces native errors and kills the connection
 * on a timeout. This client preserves the raw error and leaves late replies
 * readable. Timed-out actions are never replayed and may still complete.
 */
export class BrowserLabNativeTransport {
  private next = 0;
  private buffer = '';
  private pending: { id: string; resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  constructor(private socket: Socket, private timeoutMs = 10_000, private signal?: AbortSignal) {
    socket.on('data', this.receive);
    socket.on('close', this.onClose);
    socket.on('error', this.onError);
    signal?.addEventListener('abort', this.onAbort);
  }
  private reject(error: Error) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = undefined;
  }
  private onClose = () => this.reject(new Error('Native browser connection closed.'));
  private onError = (error: Error) => this.reject(error);
  private onAbort = () => this.reject(new Error('Browser laboratory command aborted.'));
  private receive = (chunk: string | Buffer) => {
    this.buffer += String(chunk);
    if (this.buffer.length > 16_000_000) { this.reject(new Error('Native reply exceeds 16 MB.')); this.buffer = ''; return; }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      let reply: { id?: string; success?: boolean; data?: Record<string, unknown>; error?: unknown };
      try { reply = JSON.parse(line); } catch { this.reject(new Error(`Invalid native JSON: ${line}`)); continue; }
      if (!this.pending || reply.id !== this.pending.id) continue;
      const pending = this.pending;
      if (!reply.success || !reply.data || typeof reply.data !== 'object' || Array.isArray(reply.data)) {
        this.reject(new Error(`Native browser command failed: ${typeof reply.error === 'string' ? reply.error : JSON.stringify(reply)}`));
      } else {
        clearTimeout(pending.timer); this.pending = undefined; pending.resolve(reply.data);
      }
    }
  };
  command(action: string, args: Record<string, unknown> = {}) {
    this.signal?.throwIfAborted();
    if (this.pending) return Promise.reject(new Error('Only one native browser command may run at a time.'));
    if (this.socket.destroyed) return Promise.reject(new Error('Native browser connection closed.'));
    const id = `lab-${++this.next}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = ['navigate', 'download'].includes(action) ? Math.max(this.timeoutMs, 35_000) : this.timeoutMs;
      const timer = setTimeout(() => this.reject(new Error(`Native ${action} timed out after ${timeout} ms; it was not cancelled or retried and may still complete.`)), timeout);
      this.pending = { id, resolve, reject, timer };
      this.socket.write(JSON.stringify({ ...args, action, id }) + '\n');
    });
  }
  dispose() {
    this.reject(new Error('Native laboratory transport disposed.'));
    this.socket.off('data', this.receive); this.socket.off('close', this.onClose); this.socket.off('error', this.onError);
    this.signal?.removeEventListener('abort', this.onAbort);
  }
}

export async function connectIndependentNativeTransport(daemon: BrowserDaemon, timeoutMs?: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const socket = daemon.openClientSocket();
  socket.setEncoding('utf8');
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); socket.off('connect', connected); socket.off('error', failed);
        socket.off('close', closed); signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const connected = () => finish(), failed = (error: Error) => finish(error);
      const closed = () => finish(new Error('Independent native connection closed during setup.'));
      const aborted = () => finish(new Error('Independent native connection aborted.'));
      const timer = setTimeout(() => finish(new Error('Independent native connection timed out.')), 5000);
      socket.once('connect', connected); socket.once('error', failed); socket.once('close', closed);
      signal?.addEventListener('abort', aborted, { once: true });
    });
    const native = new BrowserLabNativeTransport(socket, timeoutMs, signal);
    const dispose = native.dispose.bind(native);
    native.dispose = () => { dispose(); socket.destroy(); };
    return native;
  } catch (error) { socket.destroy(); throw error; }
}
