import { RPC_CHUNK_BYTES, RPC_CHUNK_MARK, RPC_MAX_FRAME_BYTES, RpcErrorCode, projectLiveMessage, projectLivePart, type HelloAccepted, type RpcError, type RpcEventName, type RpcEvents, type SentFrom, type ThreadId, type TransportOptions } from '@boite/contracts';
import type { ServerWebSocket } from 'bun';
import type { Core } from '../core.ts';
import { newId } from '../ids.ts';
import type { Connection } from '../router.ts';
import type { Identity } from '../sessions.ts';

const REMOTE_DELTA_WINDOW_MS = 80;
export const OUTBOUND_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
export const OUTBOUND_MAX_PENDING_PARTS = 1024;
export const OUTBOUND_CONGESTION_TIMEOUT_MS = 10_000;
/** How far a chunked answer runs ahead of the socket before it waits for a drain. */
const CHUNK_BACKLOG = 1024 * 1024;

export interface SocketData {
  connection: ServerConnection;
  /** The address its hello wait is counted under; null for the owner's own machine. */
  peer: string | null;
}

/** An event serialized once, with its UTF-8 size. */
export interface EventFrame {
  text: string;
  bytes: number;
}

/**
 * One event's frames during a broadcast, by `ServerConnection.variant`:
 * every socket that projects it the same way sends the same text, so a large
 * event is stringified and measured once rather than once per window.
 */
export type EventFrames = Map<string, EventFrame>;

/** The JSON of `text` as a string value, quotes excluded, in UTF-8 bytes. */
function jsonTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/** A delta frame's UTF-8 bytes. */
function deltaFrameBytes(delta: RpcEvents['message.delta']): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'message.delta', params: delta }));
}

/** No UTF-16 unit takes more than this in JSON: `\u001f`, or a lone surrogate's `\udc00`. */
const JSON_BYTES_PER_UNIT = 6;

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
  transport: TransportOptions = {};
  sentFrom: SentFrom | null = null;
  /** For the log: when the socket opened, the client name hello gave and the close the core asked for. */
  readonly openedAt = Date.now();
  clientName = 'unknown';
  /** The newer events this client's hello said it handles (`hello` `accepts`). */
  accepts: ReadonlySet<HelloAccepted> = new Set();
  closedBy: { code: number; reason: string } | null = null;
  /** A hello is being answered. */
  greeting = false;

  #socket: ServerWebSocket<SocketData> | null = null;
  #congested = false;
  #closed = false;
  readonly #closeListeners = new Set<() => void>();
  #congestionTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the socket held at the last write or drain that left it congested: a later drain below it took bytes. */
  #congestionMark = 0;
  /** UTF-8 bytes of the held deltas, except the texts merged into them that `unmeasured` holds. */
  #pacedBytes = 0;
  /** Texts merged into held deltas and not counted yet, with their upper bound in `unmeasuredBound`. */
  #unmeasured: string[] = [];
  #unmeasuredBound = 0;
  #catchUpBytes = 0;
  readonly #catchUp = new Set<string>();
  readonly #paced = new Map<string, RpcEvents['message.delta']>();
  #paceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Frames waiting behind a chunked answer that is still leaving, in order; null when none is. */
  #outbox: Iterator<string>[] | null = null;
  #outboxBytes = 0;

  /**
   * `remote` is a client that reached the core by a name other than this
   * machine's loopback: a phone, a laptop, a tunnel. Its frames are deflated
   * and its deltas paced; the shell on 127.0.0.1 gets neither, because there
   * the bytes are free and the CPU is not.
   */
  constructor(private readonly core: Core, readonly remote = false, private readonly congestionTimeoutMs = OUTBOUND_CONGESTION_TIMEOUT_MS) { }

  /** Set at the upgrade from the peer address, the Host and the Origin (`encryptedLink` in server/peer.ts). */
  encrypted = false;

  attach(socket: ServerWebSocket<SocketData>): void {
    if (!this.#closed) this.#socket = socket;
  }

  /**
   * `frames` is shared by the sockets one broadcast reaches: the first socket
   * of each variant serializes the event and the others send that text.
   */
  sendEvent<E extends RpcEventName>(name: E, payload: RpcEvents[E], frames?: EventFrames): void {
    if (this.#closed) return;
    if (name === 'message.delta' && this.remote && !this.#congested) {
      this.#pace(payload as RpcEvents['message.delta']);
      return;
    }
    this.#flushPaced();
    if (this.#closed) return;
    if (name === 'message.delta' && this.#congested) {
      this.#queueCatchUp(payload as RpcEvents['message.delta']);
      return;
    }
    const key = this.#variant(name, payload);
    let frame = frames?.get(key);
    if (frame === undefined) {
      const text = JSON.stringify({ jsonrpc: '2.0', method: name, params: this.#live(name, payload) });
      frame = { text, bytes: Buffer.byteLength(text) };
      frames?.set(key, frame);
    }
    this.#sendNow(name, payload, frame);
  }

  /** What changes how this socket projects the event: two sockets with the same variant receive the same frame. */
  #variant<E extends RpcEventName>(name: E, payload: RpcEvents[E]): string {
    const { compactTools, compactToolParts, compactFiles, compactImages } = this.transport;
    if (name === 'message.started') return `${compactFiles ? 'f' : ''}${compactImages ? 'i' : ''}`;
    if (name !== 'message.part') return '';
    const kind = (payload as RpcEvents['message.part']).part.type;
    if (kind === 'tool') return `${compactTools ? 't' : ''}${compactToolParts ? 'p' : ''}`;
    if (kind === 'file') return compactFiles ? 'f' : '';
    if (kind === 'image') return compactImages ? 'i' : '';
    return '';
  }

  /**
   * A live part or prompt as this socket's pages send it. A 30 MB tool output
   * reaches the client as its preview, and the card fetches the rest with
   * `messages.toolPart` when it opens: sent whole, it would cost the frame
   * limit and close the socket. A prompt's or an artifact's files and large
   * pictures stay on the core and are read with `messages.attachment`; a
   * picture goes without its blur, which is queued for the next page. A part
   * is projected as an assistant's, the rule that keeps the most.
   */
  #live<E extends RpcEventName>(name: E, payload: RpcEvents[E]): RpcEvents[E] {
    const transport = this.transport;
    if (name === 'message.part') {
      const event = payload as RpcEvents['message.part'];
      const kind = event.part.type;
      if (kind !== 'tool' && kind !== 'file' && kind !== 'image') return payload;
      const previews = kind === 'tool' ? undefined : this.core.media.lookup(event.threadId);
      const part = projectLivePart(event.part, transport, 'assistant', event.messageId, event.partIndex, previews);
      return (part === event.part ? event : { ...event, part }) as RpcEvents[E];
    }
    if (name === 'message.started' && (transport.compactFiles || transport.compactImages)) {
      const message = payload as RpcEvents['message.started'];
      return projectLiveMessage(message, transport, this.core.media.lookup(message.threadId)) as RpcEvents[E];
    }
    return payload;
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
  #pace(delta: RpcEvents['message.delta']): void {
    const key = `${delta.messageId}|${delta.partIndex}`;
    let held = this.#paced.get(key);
    // Merged text counts as its upper bound until the bounds could cross the
    // frame limit; then everything held is counted exactly, so the flush
    // falls where an exact count puts it.
    let exact = !held;
    let bytes = held ? delta.text.length * JSON_BYTES_PER_UNIT : deltaFrameBytes(delta);
    if (this.#pacedBytes + this.#unmeasuredBound + bytes > RPC_MAX_FRAME_BYTES) {
      this.#measurePaced();
      if (held) { exact = true; bytes = jsonTextBytes(delta.text); }
    }
    if (this.#pacedBytes + this.#unmeasuredBound + bytes > RPC_MAX_FRAME_BYTES || (!held && this.#paced.size >= OUTBOUND_MAX_PENDING_PARTS)) {
      this.#flushPaced();
      if (this.#closed) return;
      if (this.#congested) { this.#queueCatchUp(delta); return; }
      if (held) { held = undefined; exact = true; bytes = deltaFrameBytes(delta); }
    }
    if (held) held.text += delta.text;
    else this.#paced.set(key, { ...delta });
    if (exact) this.#pacedBytes += bytes;
    else { this.#unmeasured.push(delta.text); this.#unmeasuredBound += bytes; }
    if (this.#pacedBytes > RPC_MAX_FRAME_BYTES) { this.#flushPaced(); return; }
    this.#paceTimer ??= setTimeout(() => this.#flushPaced(), REMOTE_DELTA_WINDOW_MS);
  }

  /** Counts the merged texts held by their bound, once. */
  #measurePaced(): void {
    for (const text of this.#unmeasured) this.#pacedBytes += jsonTextBytes(text);
    this.#unmeasured = [];
    this.#unmeasuredBound = 0;
  }

  #flushPaced(): void {
    if (this.#paceTimer !== null) {
      clearTimeout(this.#paceTimer);
      this.#paceTimer = null;
    }
    if (this.#paced.size === 0) return;
    const held = [...this.#paced.values()];
    this.#paced.clear();
    this.#pacedBytes = 0;
    this.#unmeasured = [];
    this.#unmeasuredBound = 0;
    for (const delta of held) this.#sendNow('message.delta', delta);
  }

  /** `frame` is the event already serialized for this socket; without it, `payload` is. */
  #sendNow<E extends RpcEventName>(name: E, payload: RpcEvents[E], frame?: EventFrame): void {
    if (this.#closed) return;
    if (name === 'message.delta' && this.#congested) {
      this.#queueCatchUp(payload as RpcEvents['message.delta']);
      return;
    }
    const sent = frame ? this.#write(null, frame.text, frame.bytes) : this.#write({ jsonrpc: '2.0', method: name, params: payload });
    if (sent > 0) return;
    if (sent === 0) {
      this.close(1013, 'connection dropped a frame; reconnect');
      return;
    }
    this.#markCongested();
    if (name === 'message.delta') this.#queueCatchUp(payload as RpcEvents['message.delta']);
  }

  /** `chunked`: the request asked for `progress`, and a long answer leaves in counted slices. */
  sendResponse(response: OutgoingResponse, chunked = false): void {
    if (this.#closed) return;
    this.#flushPaced();
    if (this.#closed) return;
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
    const sent = chunked && bytes > RPC_CHUNK_BYTES && bytes <= RPC_MAX_FRAME_BYTES
      ? this.#writeChunked(response.id, serialized, bytes)
      : this.#write(response, serialized);
    if (sent === 0) this.close(1013, 'connection dropped a response; reconnect');
  }

  /**
   * The answer as `RPC_CHUNK_MARK` frames of about `RPC_CHUNK_BYTES` each. The
   * browser hands a frame over only once all of it arrived: slices are what lets
   * the page say "1.2 MB / 3.4 MB" while a long thread loads. They leave as the
   * socket drains, never more than `CHUNK_BACKLOG` ahead of it, and every frame
   * written meanwhile waits behind them, so a client never sees an event before
   * the snapshot that does not hold it. Returns 0 when the connection gave up.
   */
  #writeChunked(id: number | string, text: string, bytes: number): number {
    if (this.#closed || this.#socket === null) return 0;
    if (this.bufferedAmount() + this.#outboxBytes + bytes > OUTBOUND_MAX_BUFFERED_BYTES) {
      this.close(1013, 'connection exceeded outgoing buffer limit; reconnect');
      return 0;
    }
    this.#outboxBytes += bytes;
    const frames = chunkFrames(id, text, bytes);
    if (this.#outbox !== null) {
      this.#outbox.push(frames);
      return 1;
    }
    this.#outbox = [frames];
    return this.#pump();
  }

  /** Sends what the outbox holds while the socket keeps up: -1 when it waits for a drain, 0 when a frame was dropped, 1 once empty. */
  #pump(): number {
    while (this.#outbox !== null && this.#socket !== null && !this.#closed) {
      const head = this.#outbox[0];
      if (head === undefined) {
        this.#outbox = null;
        this.#outboxBytes = 0;
        break;
      }
      if (this.bufferedAmount() > CHUNK_BACKLOG) {
        this.#markCongested();
        return -1;
      }
      const next = head.next();
      if (next.done === true) {
        this.#outbox.shift();
        continue;
      }
      this.#outboxBytes = Math.max(0, this.#outboxBytes - Buffer.byteLength(next.value));
      if (this.#socket.send(next.value, this.remote) === 0) {
        this.#outbox = null;
        this.#outboxBytes = 0;
        return 0;
      }
    }
    return 1;
  }

  onClose(callback: () => void): () => void {
    if (this.#closed) {
      try { callback(); } catch { /* Registration must not revive a closed socket. */ }
      return () => {};
    }
    this.#closeListeners.add(callback);
    return () => { this.#closeListeners.delete(callback); };
  }

  close(code: number, reason?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    // The server logs a close before its own handler calls this, so a value here is the core's choice.
    this.closedBy = { code, reason: reason ?? '' };
    for (const callback of [...this.#closeListeners]) {
      try { callback(); } catch { /* One held request must not interrupt socket cleanup. */ }
    }
    this.#closeListeners.clear();
    this.core.speech.cancel(this.id);
    this.#clearCongestion();
    if (this.#paceTimer !== null) clearTimeout(this.#paceTimer);
    this.#paceTimer = null;
    this.#paced.clear();
    this.#catchUp.clear();
    this.#catchUpBytes = 0;
    this.#pacedBytes = 0;
    this.#unmeasured = [];
    this.#unmeasuredBound = 0;
    this.#outbox = null;
    this.#outboxBytes = 0;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(code, reason);
  }

  bufferedAmount(): number {
    return this.#socket?.getBufferedAmount() ?? 0;
  }

  #markCongested(): void {
    if (this.#closed) return;
    this.#congested = true;
    this.#congestionMark = this.bufferedAmount();
    this.#congestionTimer ??= setTimeout(() => this.close(1013, 'connection remained congested; reconnect'), this.congestionTimeoutMs);
  }

  #clearCongestion(): void {
    if (this.#congestionTimer !== null) clearTimeout(this.#congestionTimer);
    this.#congestionTimer = null;
    this.#congested = false;
    this.#congestionMark = 0;
  }

  /** `bytes` is `serialized`'s UTF-8 size when the caller counted it already. */
  #write(frame: unknown, serialized?: string, counted?: number): number {
    if (this.#closed || this.#socket === null) return 0;
    const text = serialized ?? JSON.stringify(frame);
    const bytes = serialized !== undefined && counted !== undefined ? counted : Buffer.byteLength(text);
    if (bytes > RPC_MAX_FRAME_BYTES) {
      this.close(1009, 'event exceeds the 16 MiB frame limit');
      return 0;
    }
    if (this.bufferedAmount() + this.#outboxBytes + bytes > OUTBOUND_MAX_BUFFERED_BYTES) {
      this.close(1013, 'connection exceeded outgoing buffer limit; reconnect');
      return 0;
    }
    // Behind a chunked answer still leaving, in the order it was written.
    if (this.#outbox !== null) {
      this.#outbox.push([text][Symbol.iterator]());
      this.#outboxBytes += bytes;
      return 1;
    }
    const sent = this.#socket.send(text, this.remote);
    if (sent < 0 || this.bufferedAmount() > 0) this.#markCongested();
    return sent;
  }

  /**
   * Backpressure: deltas are dropped, and the part they belonged to is resent
   * once the socket drains. Only that part: every other frame is still queued
   * while congested within the byte and time limits, so a finished tool output
   * never needs a second copy. Exceeding a limit requires a fresh snapshot.
   */
  #queueCatchUp(payload: RpcEvents['message.delta']): void {
    if (this.#closed) return;
    const key = `${payload.messageId}|${payload.partIndex}`;
    if (this.#catchUp.has(key)) return;
    const bytes = Buffer.byteLength(key);
    if (this.#catchUp.size >= OUTBOUND_MAX_PENDING_PARTS || this.#catchUpBytes + bytes > RPC_MAX_FRAME_BYTES) {
      this.close(1013, 'connection exceeded catch-up part limit; reconnect');
      return;
    }
    this.#catchUp.add(key);
    this.#catchUpBytes += bytes;
  }

  drain(): void {
    if (this.#closed || this.core.journal.isClosed()) return;
    // A chunked answer leaves first; what it held back goes with it.
    if (this.#outbox !== null) {
      // The socket took slices since the last drain: the congestion clock
      // counts from now, so a long answer on a slow link is not cut off.
      if (this.#congestionTimer !== null) clearTimeout(this.#congestionTimer);
      this.#congestionTimer = null;
      if (this.#pump() === 0) {
        this.close(1013, 'connection dropped a response; reconnect');
        return;
      }
      this.#markCongested();
      if (this.#outbox !== null) return;
    }
    const buffered = this.bufferedAmount();
    if (buffered > 0) {
      // One large frame, a 12 MB page, leaves a slow link a slice per drain with
      // nothing left to pump: a drain that took bytes restarts the clock as a
      // chunked answer's slices do. A drain with as much still queued is no progress.
      if (buffered < this.#congestionMark) {
        if (this.#congestionTimer !== null) clearTimeout(this.#congestionTimer);
        this.#congestionTimer = null;
        this.#markCongested();
      }
      return;
    }
    // The bus holds up to 16 ms of text the journal flush below folds into the
    // part. Dispatched now, while still congested, it lands in the catch-up
    // rather than arriving after the part as a second copy.
    this.core.bus.flush();
    if (this.#closed || this.bufferedAmount() > 0) return;
    this.core.journal.flushDeltas();
    this.#clearCongestion();
    const messages = new Map<string, ReturnType<Core['journal']['getMessage']>>();
    for (const key of [...this.#catchUp]) {
      const cut = key.lastIndexOf('|');
      const messageId = key.slice(0, cut);
      const partIndex = Number(key.slice(cut + 1));
      if (!messages.has(messageId)) messages.set(messageId, this.core.journal.getMessage(messageId));
      const message = messages.get(messageId) ?? null;
      const part = message?.parts[partIndex];
      this.#catchUp.delete(key);
      this.#catchUpBytes -= Buffer.byteLength(key);
      if (message === null || part === undefined) continue;
      const sent = this.#write({
        jsonrpc: '2.0',
        method: 'message.part',
        params: this.#live('message.part', { threadId: message.threadId, messageId, partIndex, part }),
      });
      if (sent === 0) { this.close(1013, 'catch-up dropped; reconnect'); return; }
      // -1 is queued, not lost: Bun delivers it. The keys left wait for the next drain.
      if (sent < 0) { this.#markCongested(); return; }
    }
  }
}

/**
 * `text` cut into pieces of about `size` UTF-16 units, never between the two
 * halves of a surrogate pair: a lone half would reach the client as U+FFFD.
 */
export function* slices(text: string, size: number): Generator<string> {
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    const last = text.charCodeAt(end - 1);
    // Ending on a high half: stop before it, or take the pair when it is all the slice holds.
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end += end - 1 > start ? -1 : 1;
    yield text.slice(start, end);
    start = end;
  }
}

/** The chunk frames of one answer, made one at a time as the socket takes them. */
function* chunkFrames(id: number | string, text: string, total: number): Generator<string> {
  for (const slice of slices(text, RPC_CHUNK_BYTES)) {
    const header = JSON.stringify({ id, bytes: Buffer.byteLength(slice), total });
    yield `${RPC_CHUNK_MARK}${header}\n${slice}`;
  }
}
