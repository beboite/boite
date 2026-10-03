import { RPC_MAX_FRAME_BYTES, RpcErrorCode, type RpcError, type RpcEventName, type RpcEvents, type ThreadId } from '@boite/contracts';
import type { ServerWebSocket } from 'bun';
import type { Core } from '../core.ts';
import { newId } from '../ids.ts';
import type { Connection } from '../router.ts';
import type { Identity } from '../sessions.ts';

const REMOTE_DELTA_WINDOW_MS = 80;
export const OUTBOUND_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
export const OUTBOUND_MAX_PENDING_PARTS = 1024;
export const OUTBOUND_CONGESTION_TIMEOUT_MS = 10_000;

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
  private closed = false;
  private readonly closeListeners = new Set<() => void>();
  private congestionTimer: ReturnType<typeof setTimeout> | null = null;
  private pacedBytes = 0;
  private catchUpBytes = 0;
  private readonly catchUp = new Set<string>();
  private readonly paced = new Map<string, RpcEvents['message.delta']>();
  private paceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `remote` is a client that reached the core by a name other than this
   * machine's loopback: a phone, a laptop, a tunnel. Its frames are deflated
   * and its deltas paced; the shell on 127.0.0.1 gets neither, because there
   * the bytes are free and the CPU is not.
   */
  constructor(private readonly core: Core, readonly remote = false, private readonly congestionTimeoutMs = OUTBOUND_CONGESTION_TIMEOUT_MS) { }

  attach(socket: ServerWebSocket<SocketData>): void {
    if (!this.closed) this.socket = socket;
  }

  sendEvent<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void {
    if (this.closed) return;
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
    let held = this.paced.get(key);
    const bytes = held ? Buffer.byteLength(JSON.stringify(delta.text)) - 2
      : Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'message.delta', params: delta }));
    if (this.pacedBytes + bytes > RPC_MAX_FRAME_BYTES || (!held && this.paced.size >= OUTBOUND_MAX_PENDING_PARTS)) {
      this.flushPaced();
      if (this.closed) return;
      if (this.congested) { this.queueCatchUp(delta); return; }
      held = undefined;
    }
    if (held) held.text += delta.text;
    else this.paced.set(key, { ...delta });
    this.pacedBytes += held ? bytes : Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'message.delta', params: delta }));
    if (this.pacedBytes > RPC_MAX_FRAME_BYTES) { this.flushPaced(); return; }
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
    this.pacedBytes = 0;
    for (const delta of held) this.sendNow('message.delta', delta);
  }

  private sendNow<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void {
    if (this.closed) return;
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
    this.markCongested();
    if (name === 'message.delta') this.queueCatchUp(payload as RpcEvents['message.delta']);
  }

  sendResponse(response: OutgoingResponse): void {
    if (this.closed) return;
    this.flushPaced();
    if (this.closed) return;
    let serialized = JSON.stringify(response);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > RPC_MAX_FRAME_BYTES) {
      const error: RpcError = { code: RpcErrorCode.Refused,
        message: `RPC response exceeds ${RPC_MAX_FRAME_BYTES} serialized UTF-8 bytes; request a smaller result`,
        data: { field: 'response', bytes, max: RPC_MAX_FRAME_BYTES, expected: `a complete RPC response at most ${RPC_MAX_FRAME_BYTES} serialized UTF-8 bytes` },
      };
      serialized = JSON.stringify({ jsonrpc: '2.0', id: response.id, error });
      if (Buffer.byteLength(serialized) > RPC_MAX_FRAME_BYTES) {
        // A large valid caller ID may leave room only for a minimal matched error.
        serialized = JSON.stringify({ jsonrpc: '2.0', id: response.id, error: { code: RpcErrorCode.Refused, message: 'RPC response exceeds the 16 MiB frame limit' } });
        if (Buffer.byteLength(serialized) > RPC_MAX_FRAME_BYTES) {
          this.close(1009, 'request ID leaves no room for a bounded RPC response');
          return;
        }
      }
    }
    if (this.write(response, serialized) === 0) this.close(1013, 'connection dropped a response; reconnect');
  }

  onClose(callback: () => void): () => void {
    if (this.closed) {
      try { callback(); } catch { /* Registration must not revive a closed socket. */ }
      return () => {};
    }
    this.closeListeners.add(callback);
    return () => { this.closeListeners.delete(callback); };
  }

  close(code: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const callback of [...this.closeListeners]) {
      try { callback(); } catch { /* One held request must not interrupt socket cleanup. */ }
    }
    this.closeListeners.clear();
    this.core.speech.cancel(this.id);
    this.clearCongestion();
    if (this.paceTimer !== null) clearTimeout(this.paceTimer);
    this.paceTimer = null;
    this.paced.clear();
    this.catchUp.clear();
    this.catchUpBytes = 0;
    this.pacedBytes = 0;
    const socket = this.socket;
    this.socket = null;
    socket?.close(code, reason);
  }

  bufferedAmount(): number {
    return this.socket?.getBufferedAmount() ?? 0;
  }

  private markCongested(): void {
    if (this.closed) return;
    this.congested = true;
    this.congestionTimer ??= setTimeout(() => this.close(1013, 'connection remained congested; reconnect'), this.congestionTimeoutMs);
  }

  private clearCongestion(): void {
    if (this.congestionTimer !== null) clearTimeout(this.congestionTimer);
    this.congestionTimer = null;
    this.congested = false;
  }

  private write(frame: unknown, serialized?: string): number {
    if (this.closed || this.socket === null) return 0;
    const text = serialized ?? JSON.stringify(frame);
    const bytes = Buffer.byteLength(text);
    if (bytes > RPC_MAX_FRAME_BYTES) {
      this.close(1009, 'event exceeds the 16 MiB frame limit');
      return 0;
    }
    if (this.bufferedAmount() + bytes > OUTBOUND_MAX_BUFFERED_BYTES) {
      this.close(1013, 'connection exceeded outgoing buffer limit; reconnect');
      return 0;
    }
    const sent = this.socket.send(text, this.remote);
    if (sent < 0 || this.bufferedAmount() > 0) this.markCongested();
    return sent;
  }

  /**
   * Backpressure: deltas are dropped, and the part they belonged to is resent
   * once the socket drains. Only that part: every other frame is still queued
   * while congested within the byte and time limits, so a finished tool output
   * never needs a second copy. Exceeding a limit requires a fresh snapshot.
   */
  private queueCatchUp(payload: RpcEvents['message.delta']): void {
    if (this.closed) return;
    const key = `${payload.messageId}|${payload.partIndex}`;
    if (this.catchUp.has(key)) return;
    const bytes = Buffer.byteLength(key);
    if (this.catchUp.size >= OUTBOUND_MAX_PENDING_PARTS || this.catchUpBytes + bytes > RPC_MAX_FRAME_BYTES) {
      this.close(1013, 'connection exceeded catch-up part limit; reconnect');
      return;
    }
    this.catchUp.add(key);
    this.catchUpBytes += bytes;
  }

  drain(): void {
    if (this.closed || this.core.journal.isClosed()) return;
    if (this.bufferedAmount() > 0) return;
    // The bus holds up to 16 ms of text the journal flush below folds into the
    // part. Dispatched now, while still congested, it lands in the catch-up
    // rather than arriving after the part as a second copy.
    this.core.bus.flush();
    if (this.closed || this.bufferedAmount() > 0) return;
    this.core.journal.flushDeltas();
    this.clearCongestion();
    const messages = new Map<string, ReturnType<Core['journal']['getMessage']>>();
    for (const key of [...this.catchUp]) {
      const cut = key.lastIndexOf('|');
      const messageId = key.slice(0, cut);
      const partIndex = Number(key.slice(cut + 1));
      if (!messages.has(messageId)) messages.set(messageId, this.core.journal.getMessage(messageId));
      const message = messages.get(messageId) ?? null;
      const part = message?.parts[partIndex];
      this.catchUp.delete(key);
      this.catchUpBytes -= Buffer.byteLength(key);
      if (message === null || part === undefined) continue;
      const sent = this.write({
        jsonrpc: '2.0',
        method: 'message.part',
        params: { threadId: message.threadId, messageId, partIndex, part },
      });
      if (sent === 0) { this.close(1013, 'catch-up dropped; reconnect'); return; }
      // -1 is queued, not lost: Bun delivers it. The keys left wait for the next drain.
      if (sent < 0) { this.markCongested(); return; }
    }
  }
}
