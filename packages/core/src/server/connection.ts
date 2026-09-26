import type { RpcError, RpcEventName, RpcEvents, ThreadId } from '@boite/contracts';
import type { ServerWebSocket } from 'bun';
import type { Core } from '../core.ts';
import { newId } from '../ids.ts';
import type { Connection } from '../router.ts';
import type { Identity } from '../sessions.ts';

const REMOTE_DELTA_WINDOW_MS = 80;

export interface SocketData {
  connection: ServerConnection;
  /** The address its hello wait is counted under; null for the owner's own machine. */
  peer: string | null;
}

interface OutgoingResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: RpcError;
}

export class ServerConnection implements Connection {
  readonly id = newId('con_');
  readonly subscriptions = new Set<ThreadId>();
  authenticated = false;
  /** Owner until hello says otherwise; nothing reads it before `authenticated` is true. */
  identity: Identity = { principal: 'owner', sessionId: null, threadId: null };

  private socket: ServerWebSocket<SocketData> | null = null;
  private congested = false;
  private readonly catchUp = new Set<string>();
  private readonly paced = new Map<string, RpcEvents['message.delta']>();
  private paceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `remote` is a client that reached the core by a name other than this
   * machine's loopback: a phone, a laptop, a tunnel. Its frames are deflated
   * and its deltas paced; the shell on 127.0.0.1 gets neither, because there
   * the bytes are free and the CPU is not.
   */
  constructor(private readonly core: Core, readonly remote = false) { }

  attach(socket: ServerWebSocket<SocketData>): void {
    this.socket = socket;
  }

  sendEvent<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void {
    if (name === 'message.delta' && this.remote && !this.congested) {
      this.pace(payload as RpcEvents['message.delta']);
      return;
    }
    this.flushPaced();
    this.sendNow(name, payload);
  }

  /**
   * A remote client gets its text every `REMOTE_DELTA_WINDOW_MS` rather than
   * every 16 ms. Each frame costs its envelope, its ids and the headers under
   * it whatever text it carries, so five deltas in one frame are a fifth of
   * the bytes, and the UI only re-renders a paragraph once it closes. Any
   * other frame on this socket, an event or a response, sends what is held
   * first: a client never sees a card, or a snapshot, before the text that
   * came before it.
   */
  private pace(delta: RpcEvents['message.delta']): void {
    const key = `${delta.messageId}|${delta.partIndex}`;
    const held = this.paced.get(key);
    if (held) held.text += delta.text;
    else this.paced.set(key, { ...delta });
    this.paceTimer ??= setTimeout(() => this.flushPaced(), REMOTE_DELTA_WINDOW_MS);
  }

  private flushPaced(): void {
    if (this.paceTimer !== null) {
      clearTimeout(this.paceTimer);
      this.paceTimer = null;
    }
    if (this.paced.size === 0) return;
    const held = [...this.paced.values()];
    this.paced.clear();
    for (const delta of held) this.sendNow('message.delta', delta);
  }

  private sendNow<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void {
    if (name === 'message.delta' && this.congested) {
      this.queueCatchUp(payload as RpcEvents['message.delta']);
      return;
    }
    const sent = this.write({ jsonrpc: '2.0', method: name, params: payload });
    if (sent > 0) return;
    if (sent === 0) {
      this.close(1013, 'connection dropped a frame; reconnect');
      return;
    }
    this.congested = true;
    if (name === 'message.delta') this.queueCatchUp(payload as RpcEvents['message.delta']);
  }

  sendResponse(response: OutgoingResponse): void {
    this.flushPaced();
    if (this.write(response) === 0) this.close(1013, 'connection dropped a response; reconnect');
  }

  close(code: number, reason?: string): void {
    this.core.speech.cancel(this.id);
    if (this.paceTimer !== null) clearTimeout(this.paceTimer);
    this.paceTimer = null;
    this.paced.clear();
    this.catchUp.clear();
    this.socket?.close(code, reason);
  }

  bufferedAmount(): number {
    return this.socket?.getBufferedAmount() ?? 0;
  }

  private write(frame: unknown): number {
    if (this.socket === null) return 0;
    return this.socket.send(JSON.stringify(frame), this.remote);
  }

  /**
   * Backpressure: deltas are dropped, and the part they belonged to is resent
   * once the socket drains. Only that part: every other frame is still queued
   * while congested, so a finished tool output never needs a second copy.
   */
  private queueCatchUp(payload: RpcEvents['message.delta']): void {
    this.catchUp.add(`${payload.messageId}|${payload.partIndex}`);
  }

  drain(): void {
    if (this.core.journal.isClosed()) return;
    // The bus holds up to 16 ms of text the journal flush below folds into the
    // part. Dispatched now, while still congested, it lands in the catch-up
    // rather than arriving after the part as a second copy.
    this.core.bus.flush();
    this.core.journal.flushDeltas();
    this.congested = false;
    const messages = new Map<string, ReturnType<Core['journal']['getMessage']>>();
    for (const key of [...this.catchUp]) {
      const cut = key.lastIndexOf('|');
      const messageId = key.slice(0, cut);
      const partIndex = Number(key.slice(cut + 1));
      if (!messages.has(messageId)) messages.set(messageId, this.core.journal.getMessage(messageId));
      const message = messages.get(messageId) ?? null;
      const part = message?.parts[partIndex];
      this.catchUp.delete(key);
      if (message === null || part === undefined) continue;
      const sent = this.write({
        jsonrpc: '2.0',
        method: 'message.part',
        params: { threadId: message.threadId, messageId, partIndex, part },
      });
      if (sent === 0) { this.close(1013, 'catch-up dropped; reconnect'); return; }
      // -1 is queued, not lost: Bun delivers it. The keys left wait for the next drain.
      if (sent < 0) { this.congested = true; return; }
    }
  }
}
