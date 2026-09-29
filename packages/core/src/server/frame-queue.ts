import type { ServerConnection } from './connection.ts';

const SLICE_MS = 4;
const MAX_PENDING_FRAMES = 4096;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const MAX_ACTIVE = 64;
const MAX_ACTIVE_PER_CONNECTION = 8;

interface Frame {
  raw: string;
  resolve(): void;
  reject(error: unknown): void;
}
interface Pending {
  frames: Frame[];
  head: number;
}

/** Round-robin requests leave time for HTTP, streamed replies and other clients. */
export class FrameQueue {
  private readonly pending = new Map<ServerConnection, Pending>();
  private readonly disconnected = new WeakSet<ServerConnection>();
  private readonly activeByConnection = new Map<ServerConnection, number>();
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private count = 0;
  private bytes = 0;
  private closed = false;

  constructor(private readonly handle: (connection: ServerConnection, raw: string) => Promise<void>) {}

  enqueue(connection: ServerConnection, raw: string): Promise<void> {
    if (this.closed || this.disconnected.has(connection)) return Promise.resolve();
    // UTF-16 size bounds the retained strings, including frames full of non-ASCII text.
    if (this.count >= MAX_PENDING_FRAMES || this.bytes + raw.length * 2 > MAX_PENDING_BYTES) {
      connection.close(1013, `RPC queue exceeds ${MAX_PENDING_FRAMES} frames or ${MAX_PENDING_BYTES} bytes; reconnect`);
      this.drop(connection);
      return Promise.resolve();
    }
    const queue = this.pending.get(connection) ?? { frames: [], head: 0 };
    this.pending.set(connection, queue);
    this.count++;
    this.bytes += raw.length * 2;
    const result = new Promise<void>((resolve, reject) => queue.frames.push({ raw, resolve, reject }));
    this.schedule();
    return result;
  }

  drop(connection: ServerConnection): void {
    this.disconnected.add(connection);
    const queue = this.pending.get(connection);
    if (!queue) return;
    this.pending.delete(connection);
    for (const frame of queue.frames.slice(queue.head)) {
      this.count--;
      this.bytes -= frame.raw.length * 2;
      frame.resolve();
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const connection of this.pending.keys()) this.drop(connection);
  }

  private pump(): void {
    this.timer = null;
    const deadline = performance.now() + SLICE_MS;
    while (this.pending.size > 0 && this.active < MAX_ACTIVE && performance.now() < deadline) {
      const available = [...this.pending].find(([connection]) => (this.activeByConnection.get(connection) ?? 0) < MAX_ACTIVE_PER_CONNECTION);
      if (!available) return;
      const [connection, queue] = available;
      const frame = queue.frames[queue.head++]!;
      delete queue.frames[queue.head - 1];
      if (queue.head >= 128 && queue.head * 2 >= queue.frames.length) {
        queue.frames = queue.frames.slice(queue.head);
        queue.head = 0;
      }
      this.pending.delete(connection);
      if (queue.head < queue.frames.length) this.pending.set(connection, queue);
      this.active++;
      this.activeByConnection.set(connection, (this.activeByConnection.get(connection) ?? 0) + 1);
      const complete = () => {
        this.count--;
        this.bytes -= frame.raw.length * 2;
        this.active--;
        const remaining = (this.activeByConnection.get(connection) ?? 1) - 1;
        if (remaining === 0) this.activeByConnection.delete(connection);
        else this.activeByConnection.set(connection, remaining);
        this.schedule();
      };
      try { void this.handle(connection, frame.raw).then(() => { complete(); frame.resolve(); }, error => { complete(); frame.reject(error); }); }
      catch (error) { complete(); frame.reject(error); }
    }
    if (this.active < MAX_ACTIVE) this.schedule();
  }

  private schedule(): void {
    if (!this.closed && this.pending.size > 0 && this.timer === null) this.timer = setTimeout(() => this.pump(), 1);
  }
}
