import type { RpcEventName, RpcEvents } from '@boite/contracts';

export type EventPayload = RpcEvents[RpcEventName];
export type BusListener = (name: RpcEventName, payload: EventPayload) => void;
interface Notification { name: RpcEventName; payload: EventPayload }
/** A staged event, or an effect `whenCommitted` holds until the outermost commit. */
type Staged = Notification | { effect: () => void };

const DELTA_WINDOW_MS = 16;

interface PendingDelta {
  threadId: string;
  messageId: string;
  partIndex: number;
  text: string;
}

/**
 * Text deltas for the same message and part are concatenated for one window
 * before they reach a socket. Any other event flushes them first, so a client
 * never sees a part card before the text that came before it.
 */
export class Bus {
  private readonly listeners = new Set<BusListener>();
  private readonly committedListeners = new Set<BusListener>();
  private staged: Staged[] | null = null;
  private readonly pending = new Map<string, PendingDelta>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reporting = false;
  /**
   * Where a throwing listener is reported. One listener's error must neither
   * skip the listeners after it nor escape the delta timer, which would end the
   * process.
   */
  onError: (message: string) => void = (message) => console.error(message);
  /** Core diagnostics are normalized before either internal or committed observers see them. */
  normalizeLog?: (payload: RpcEvents['core.log']) => RpcEvents['core.log'];

  /**
   * Every event as it is emitted, possibly inside a transaction that can still
   * roll back. Only state that rolls back with it belongs here: an effect on a
   * process, the network or memory subscribes with `onCommitted`.
   */
  onAny(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Observers with effects see a write only after its synchronous transaction commits. */
  onCommitted(listener: BusListener): () => void {
    this.committedListeners.add(listener);
    return () => { this.committedListeners.delete(listener); };
  }

  /** Buffer external notifications around a synchronous storage commit; discard on rollback. */
  afterCommit<T>(write: () => T): T {
    this.flush();
    const parent = this.staged;
    const notifications: Staged[] = [];
    this.staged = notifications;
    let result: T;
    try {
      result = write();
      this.flush();
    } catch (error) {
      this.pending.clear();
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      throw error;
    } finally {
      this.staged = parent;
    }
    if (parent !== null) parent.push(...notifications);
    else for (const staged of notifications) this.release(staged);
    return result;
  }

  /**
   * Runs `effect` once the write around it commits, in order with the events
   * it emitted, or now outside any `afterCommit`. A rollback drops it: what
   * the write would have stopped, closed or forgotten keeps running.
   */
  whenCommitted(effect: () => void): void {
    this.flush();
    if (this.staged !== null) this.staged.push({ effect });
    else this.release({ effect });
  }

  private release(staged: Staged): void {
    if (!('effect' in staged)) { this.notify(this.committedListeners, staged.name, staged.payload); return; }
    try { staged.effect(); }
    catch (error) { this.onError(`committed effect failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  emit<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void {
    if (name === 'core.log' && this.normalizeLog) payload = this.normalizeLog(payload as RpcEvents['core.log']) as RpcEvents[E];
    if (name === 'message.delta') {
      this.queue(payload as RpcEvents['message.delta']);
      return;
    }
    this.flush();
    this.dispatch(name, payload);
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const items = [...this.pending.values()];
    this.pending.clear();
    for (const item of items) {
      this.dispatch('message.delta', {
        threadId: item.threadId,
        messageId: item.messageId,
        partIndex: item.partIndex,
        text: item.text,
      });
    }
  }

  dispose(): void {
    this.flush();
    this.listeners.clear();
    this.committedListeners.clear();
  }

  private queue(delta: RpcEvents['message.delta']): void {
    const key = `${delta.messageId}|${delta.partIndex}`;
    const current = this.pending.get(key);
    if (current) current.text += delta.text;
    else this.pending.set(key, { ...delta });
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, DELTA_WINDOW_MS);
    }
  }

  private dispatch(name: RpcEventName, payload: EventPayload): void {
    this.notify(this.listeners, name, payload);
    if (this.staged !== null) this.staged.push({ name, payload });
    else this.notify(this.committedListeners, name, payload);
  }

  private notify(listeners: Set<BusListener>, name: RpcEventName, payload: EventPayload): void {
    for (const listener of listeners) {
      try {
        listener(name, payload);
      } catch (error) {
        // A report is itself an event: a listener that throws on it too must not loop.
        if (this.reporting) continue;
        this.reporting = true;
        try {
          this.onError(`event listener failed on ${name}: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // Nothing left to report to.
        } finally {
          this.reporting = false;
        }
      }
    }
  }
}

export function eventThreadId(payload: EventPayload): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as { threadId?: unknown }).threadId;
  return typeof value === 'string' ? value : null;
}
