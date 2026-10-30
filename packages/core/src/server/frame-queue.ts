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
/**
 * Requests of closed connections whose handlers still run. A handler that
 * ignores its signal keeps running after its slot came back: past these caps
 * new requests are refused, so reconnecting clients cannot pile them up.
 */
const MAX_DETACHED = MAX_ACTIVE;
const MAX_AGENT_DETACHED = MAX_AGENT_ACTIVE;

function fromAgent(connection: ServerConnection): boolean {
  return connection.authenticated && connection.identity.principal === 'agent';
}

interface Frame {
  raw: string;
  resolve(): void;
  reject(error: unknown): void;
}
/** A started request: `detach` gives its slot back when its client leaves, `free` its budget once at its end. */
interface Started {
  controller: AbortController;
  detach(): void;
  free(): void;
}
export interface FrameQueueOptions {
  /** Answers a request refused while closed connections' requests still run. */
  refuse(connection: ServerConnection, raw: string, message: string): void;
  /** Reports the first refusal of each episode. */
  warn(message: string): void;
}
export interface FrameQueueCounts {
  active: number;
  activeAgents: number;
  detached: number;
  detachedAgents: number;
}

/** The method a frame names, read without parsing it. */
function methodOf(raw: string): string {
  return /"method"\s*:\s*"([^"\\]{1,100})"/.exec(raw)?.[1] ?? '(unnamed)';
}
interface Pending {
  frames: Frame[];
  head: number;
  bytes: number;
}

/** Round-robin requests leave time for HTTP, streamed replies and other clients. */
export class FrameQueue {
  readonly #pending = new Map<ServerConnection, Pending>();
  readonly #disconnected = new WeakSet<ServerConnection>();
  readonly #activeByConnection = new Map<ServerConnection, number>();
  readonly #started = new Map<ServerConnection, Set<Started>>();
  readonly #retained = new Map<ServerConnection, { count: number; bytes: number }>();
  #active = 0;
  #activeAgents = 0;
  #detached = 0;
  #detachedAgents = 0;
  /** Detached requests by method: every one, and those of agents. */
  readonly #detachedMethods = new Map<string, { all: number; agents: number }>();
  #warned = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  private count = 0;
  private bytes = 0;
  #closed = false;

  /**
   * `signal` aborts when the request's connection closes: its slot is free
   * again by then, and the handler stops what waits only for that caller.
   */
  constructor(
    private readonly handle: (connection: ServerConnection, raw: string, signal: AbortSignal) => Promise<void>,
    private readonly options: FrameQueueOptions = { refuse: () => {}, warn: () => {} },
  ) {}

  get counts(): FrameQueueCounts {
    return { active: this.#active, activeAgents: this.#activeAgents, detached: this.#detached, detachedAgents: this.#detachedAgents };
  }

  enqueue(connection: ServerConnection, raw: string): Promise<void> {
    if (this.#closed || this.#disconnected.has(connection)) return Promise.resolve();
    if (this.#saturated(connection)) {
      this.#refuseDetached(connection, raw);
      return Promise.resolve();
    }
    // UTF-16 size bounds the retained strings, including frames full of non-ASCII text.
    const bytes = raw.length * 2;
    const retained = this.#retained.get(connection) ?? { count: 0, bytes: 0 };
    if (retained.count >= MAX_CONNECTION_FRAMES || retained.bytes + bytes > MAX_CONNECTION_BYTES) {
      this.#refuse(connection, `RPC connection queue exceeds ${MAX_CONNECTION_FRAMES} frames or ${MAX_CONNECTION_BYTES} bytes; reconnect`);
      return Promise.resolve();
    }
    while (this.count >= MAX_PENDING_FRAMES || this.bytes + bytes > MAX_PENDING_BYTES) {
      // Reclaim the largest queued contribution, rather than disconnecting the
      // next reader because another connection spent the shared capacity.
      const byBytes = this.bytes + bytes > MAX_PENDING_BYTES;
      let victim: ServerConnection | undefined, largest = 0;
      for (const [candidate, queue] of this.#pending) {
        const size = byBytes ? queue.bytes : queue.frames.length - queue.head;
        if (size > largest) { largest = size; victim = candidate; }
      }
      // Active and detached handlers retain their budget until completion and cannot be dropped.
      this.#refuse(victim ?? connection, `RPC queue exceeds ${MAX_PENDING_FRAMES} frames or ${MAX_PENDING_BYTES} bytes; reconnect`);
      if (victim === undefined || victim === connection) return Promise.resolve();
    }
    const queue = this.#pending.get(connection) ?? { frames: [], head: 0, bytes: 0 };
    this.#pending.set(connection, queue);
    this.count++;
    this.bytes += bytes;
    queue.bytes += bytes;
    retained.count++;
    retained.bytes += bytes;
    this.#retained.set(connection, retained);
    const result = new Promise<void>((resolve, reject) => queue.frames.push({ raw, resolve, reject }));
    this.#schedule();
    return result;
  }

  drop(connection: ServerConnection): void {
    this.#disconnected.add(connection);
    // A started handler nobody waits for gives its slot back now, not when it resolves:
    // handlers stuck on a gone client must not starve the next ones. It counts as
    // detached, and keeps its byte budget, until it really ends.
    const started = this.#started.get(connection);
    this.#started.delete(connection);
    for (const request of started ?? []) {
      request.detach();
      request.controller.abort(new Error('the client closed its connection'));
    }
    const queue = this.#pending.get(connection);
    if (!queue) return;
    this.#pending.delete(connection);
    for (const frame of queue.frames.slice(queue.head)) {
      this.#release(connection, frame);
      frame.resolve();
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    for (const connection of this.#pending.keys()) this.drop(connection);
  }

  #pump(): void {
    this.#timer = null;
    const deadline = performance.now() + SLICE_MS;
    while (this.#pending.size > 0 && this.#active < MAX_ACTIVE && performance.now() < deadline) {
      const available = [...this.#pending].find(([connection]) => (this.#activeByConnection.get(connection) ?? 0) < MAX_ACTIVE_PER_CONNECTION
        && (!fromAgent(connection) || this.#activeAgents < MAX_AGENT_ACTIVE));
      if (!available) return;
      const [connection, queue] = available;
      const frame = queue.frames[queue.head++]!;
      const refused = this.#saturated(connection);
      queue.bytes -= frame.raw.length * 2;
      delete queue.frames[queue.head - 1];
      if (queue.head >= 128 && queue.head * 2 >= queue.frames.length) {
        queue.frames = queue.frames.slice(queue.head);
        queue.head = 0;
      }
      this.#pending.delete(connection);
      if (queue.head < queue.frames.length) this.#pending.set(connection, queue);
      if (refused) {
        // Queued before the cap filled: refused now, never left waiting.
        this.#release(connection, frame);
        this.#refuseDetached(connection, frame.raw);
        frame.resolve();
        continue;
      }
      this.#active++;
      const agent = fromAgent(connection);
      if (agent) this.#activeAgents++;
      this.#activeByConnection.set(connection, (this.#activeByConnection.get(connection) ?? 0) + 1);
      let state: 'active' | 'detached' | 'freed' = 'active', method = '';
      const leaveActive = () => {
        this.#active--;
        if (agent) this.#activeAgents--;
        const remaining = (this.#activeByConnection.get(connection) ?? 1) - 1;
        if (remaining === 0) this.#activeByConnection.delete(connection);
        else this.#activeByConnection.set(connection, remaining);
      };
      const request: Started = {
        controller: new AbortController(),
        detach: () => {
          if (state !== 'active') return;
          state = 'detached';
          leaveActive();
          method = methodOf(frame.raw);
          this.#detached++;
          if (agent) this.#detachedAgents++;
          const counted = this.#detachedMethods.get(method) ?? { all: 0, agents: 0 };
          counted.all++;
          if (agent) counted.agents++;
          this.#detachedMethods.set(method, counted);
          this.#schedule();
        },
        free: () => {
          if (state === 'freed') return;
          if (state === 'active') leaveActive();
          else {
            this.#detached--;
            if (agent) this.#detachedAgents--;
            const counted = this.#detachedMethods.get(method)!;
            counted.all--;
            if (agent) counted.agents--;
            if (counted.all === 0) this.#detachedMethods.delete(method);
          }
          state = 'freed';
          this.#release(connection, frame);
          if (!this.#saturated(null)) this.#warned = false;
          this.#schedule();
        },
      };
      const started = this.#started.get(connection) ?? new Set<Started>();
      started.add(request);
      this.#started.set(connection, started);
      const complete = () => {
        request.free();
        const own = this.#started.get(connection);
        own?.delete(request);
        if (own?.size === 0) this.#started.delete(connection);
      };
      try { void this.handle(connection, frame.raw, request.controller.signal).then(() => { complete(); frame.resolve(); }, error => { complete(); frame.reject(error); }); }
      catch (error) { complete(); frame.reject(error); }
    }
    if (this.#active < MAX_ACTIVE) this.#schedule();
  }

  #schedule(): void {
    if (!this.#closed && this.#pending.size > 0 && this.#timer === null) this.#timer = setTimeout(() => this.#pump(), 1);
  }

  /** Whether detached requests fill a cap this connection's request falls under; `null` asks for an agent. */
  #saturated(connection: ServerConnection | null): boolean {
    if (this.#detached >= MAX_DETACHED) return true;
    return (connection === null || fromAgent(connection)) && this.#detachedAgents >= MAX_AGENT_DETACHED;
  }

  #refuseDetached(connection: ServerConnection, raw: string): void {
    const all = this.#detached >= MAX_DETACHED;
    const counted = [...this.#detachedMethods]
      .map(([method, count]) => [method, all ? count.all : count.agents] as const)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const running = all ? this.#detached : this.#detachedAgents;
    const whose = all ? 'closed connections' : 'closed agent connections';
    const list = counted.map(([method, count]) => `${method} x${count}`).join(', ');
    const message = `${running} requests of ${whose} still run (${list}); this request is refused until they end`;
    this.options.refuse(connection, raw, message);
    if (this.#warned) return;
    this.#warned = true;
    this.options.warn(`RPC refused new requests: ${running} requests of ${whose} still run after their clients left (${list})`);
  }

  #refuse(connection: ServerConnection, reason: string): void {
    connection.close(1013, reason);
    this.drop(connection);
  }

  #release(connection: ServerConnection, frame: Frame): void {
    const bytes = frame.raw.length * 2;
    this.count--;
    this.bytes -= bytes;
    const retained = this.#retained.get(connection)!;
    retained.count--;
    retained.bytes -= bytes;
    if (retained.count === 0) this.#retained.delete(connection);
  }
}
