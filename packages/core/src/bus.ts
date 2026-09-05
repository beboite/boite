import type { RpcEventName, RpcEvents } from '@boite/contracts';

export type EventPayload = RpcEvents[RpcEventName];
export type BusListener = (name: RpcEventName, payload: EventPayload) => void;

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
  private readonly pending = new Map<string, PendingDelta>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  onAny(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void {
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
    for (const listener of this.listeners) listener(name, payload);
  }
}

export function eventThreadId(payload: EventPayload): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as { threadId?: unknown }).threadId;
  return typeof value === 'string' ? value : null;
}
