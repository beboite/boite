import type { ServerConnection } from './connection.ts';

const SLICE_MS = 4;
const MAX_PENDING_FRAMES = 4096;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const MAX_CONNECTION_FRAMES = 1024;
const MAX_CONNECTION_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE = 64;
/** Long agent waits must leave 16 slots for the UI, paired devices and new hellos. */
const MAX_AGENT_ACTIVE = MAX_ACTIVE - 16;
const MAX_ACTIVE_PER_CONNECTION = 8;

function fromAgent(connection: ServerConnection): boolean {
  return connection.authenticated && connection.identity.principal === 'agent';
}

interface Frame {
  raw: string;
  resolve(): void;
  reject(error: unknown): void;
}
interface Pending {
  frames: Frame[];
  head: number;
  bytes: number;
}

/** Round-robin requests leave time for HTTP, streamed replies and other clients. */
export class FrameQueue {
  private readonly pending = new Map<ServerConnection, Pending>();
  private readonly disconnected = new WeakSet<ServerConnection>();
  private readonly activeByConnection = new Map<ServerConnection, number>();
  private readonly retained = new Map<ServerConnection, { count: number; bytes: number }>();
  private active = 0;
  private activeAgents = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** A pump is queued as a microtask. */
  private soon = false;
  /** Time the microtask pumps took since the last timer pump or pause, and when the last one ended. */
  private fastSpent = 0;
  private fastEnd = 0;
  private count = 0;
  private bytes = 0;
  private closed = false;

  constructor(private readonly handle: (connection: ServerConnection, raw: string) => Promise<void>) {}

  enqueue(connection: ServerConnection, raw: string): Promise<void> {
    if (this.closed || this.disconnected.has(connection)) return Promise.resolve();
    // UTF-16 size bounds the retained strings, including frames full of non-ASCII text.
    const bytes = raw.length * 2;
    const retained = this.retained.get(connection) ?? { count: 0, bytes: 0 };
    if (retained.count >= MAX_CONNECTION_FRAMES || retained.bytes + bytes > MAX_CONNECTION_BYTES) {
      this.refuse(connection, `RPC connection queue exceeds ${MAX_CONNECTION_FRAMES} frames or ${MAX_CONNECTION_BYTES} bytes; reconnect`);
      return Promise.resolve();
    }
    while (this.count >= MAX_PENDING_FRAMES || this.bytes + bytes > MAX_PENDING_BYTES) {
      // Reclaim the largest queued contribution, rather than disconnecting the
      // next reader because another connection spent the shared capacity.
      const byBytes = this.bytes + bytes > MAX_PENDING_BYTES;
      let victim: ServerConnection | undefined, largest = 0;
      for (const [candidate, queue] of this.pending) {
        const size = byBytes ? queue.bytes : queue.frames.length - queue.head;
        if (size > largest) { largest = size; victim = candidate; }
      }
      // Active handlers retain their budget until completion and cannot be dropped.
      this.refuse(victim ?? connection, `RPC queue exceeds ${MAX_PENDING_FRAMES} frames or ${MAX_PENDING_BYTES} bytes; reconnect`);
      if (victim === undefined || victim === connection) return Promise.resolve();
    }
    const queue = this.pending.get(connection) ?? { frames: [], head: 0, bytes: 0 };
    this.pending.set(connection, queue);
    this.count++;
    this.bytes += bytes;
    queue.bytes += bytes;
    retained.count++;
    retained.bytes += bytes;
    this.retained.set(connection, retained);
    const result = new Promise<void>((resolve, reject) => queue.frames.push({ raw, resolve, reject }));
    this.schedule(this.active === 0 && this.count === 1);
    return result;
  }

  drop(connection: ServerConnection): void {
    this.disconnected.add(connection);
    const queue = this.pending.get(connection);
    if (!queue) return;
    this.pending.delete(connection);
    for (const frame of queue.frames.slice(queue.head)) {
      this.release(connection, frame);
      frame.resolve();
    }
  }

  close(): void {
    this.closed = true;
    this.cancel();
    for (const connection of this.pending.keys()) this.drop(connection);
  }

  private pump(): void {
    this.cancel();
    const deadline = performance.now() + SLICE_MS;
    while (this.pending.size > 0 && this.active < MAX_ACTIVE && performance.now() < deadline) {
      const available = [...this.pending].find(([connection]) => (this.activeByConnection.get(connection) ?? 0) < MAX_ACTIVE_PER_CONNECTION
        && (!fromAgent(connection) || this.activeAgents < MAX_AGENT_ACTIVE));
      if (!available) return;
      const [connection, queue] = available;
      const frame = queue.frames[queue.head++]!;
      queue.bytes -= frame.raw.length * 2;
      delete queue.frames[queue.head - 1];
      if (queue.head >= 128 && queue.head * 2 >= queue.frames.length) {
        queue.frames = queue.frames.slice(queue.head);
        queue.head = 0;
      }
      this.pending.delete(connection);
      if (queue.head < queue.frames.length) this.pending.set(connection, queue);
      this.active++;
      const agent = fromAgent(connection);
      if (agent) this.activeAgents++;
      this.activeByConnection.set(connection, (this.activeByConnection.get(connection) ?? 0) + 1);
      const complete = () => {
        this.release(connection, frame);
        this.active--;
        if (agent) this.activeAgents--;
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

  /**
   * A request that finds the queue idle runs in a microtask, after the frames
   * of the same read have queued, so a flood is still bounded before any of it
   * runs. Those microtask pumps share one 4 ms slice, refilled by a timer pump
   * or a 4 ms pause: a burst of quick requests, each finding the queue idle,
   * cannot hold the loop. Otherwise the queue pumps on a 1 ms timer, which lets
   * HTTP, drains and other clients in between slices. Not `setImmediate`: with
   * it, Windows CI left a client's last request queued until its socket closed.
   */
  private schedule(idle = false): void {
    if (this.closed || this.pending.size === 0 || this.timer !== null || this.soon) return;
    if (idle && performance.now() - this.fastEnd >= SLICE_MS) this.fastSpent = 0;
    if (idle && this.fastSpent < SLICE_MS) {
      this.soon = true;
      queueMicrotask(() => {
        if (!this.soon) return;
        const started = performance.now();
        this.pump();
        this.fastEnd = performance.now();
        this.fastSpent += this.fastEnd - started;
      });
    } else this.timer = setTimeout(() => { this.fastSpent = 0; this.pump(); }, 1);
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.soon = false;
  }

  private refuse(connection: ServerConnection, reason: string): void {
    connection.close(1013, reason);
    this.drop(connection);
  }

  private release(connection: ServerConnection, frame: Frame): void {
    const bytes = frame.raw.length * 2;
    this.count--;
    this.bytes -= bytes;
    const retained = this.retained.get(connection)!;
    retained.count--;
    retained.bytes -= bytes;
    if (retained.count === 0) this.retained.delete(connection);
  }
}
