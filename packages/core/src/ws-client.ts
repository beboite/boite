/*
 * The WebSocket client of every socket the core opens: the browser's DevTools
 * on Windows (`browser/cdp.ts`), another core for the CLI (`client.ts`) and
 * for the group relay (`group/relay.ts`). It runs on `Bun.connect`, because
 * Bun's own client (1.4.2 and 1.4.3) closes sound streams with 1002 ("control
 * frame is fragmented", "unsupported control frame", "unexpected opcode") or
 * 1011 ("Compression not implemented yet"), with or without permessage-deflate:
 * against Chrome, whose frames #613's relay checked one by one and found
 * well-formed (#623, #635), and against the core's own server (core tests on
 * macOS arm64, through `client.ts`). The relay read the same bytes through
 * `Bun.connect` without a fault, so this client parses them itself.
 *
 * RFC 6455 for text messages only: server frames must be unmasked, fragmented
 * messages are joined, pings are answered and a close is echoed. Reserved bits
 * stay clear unless `deflate` negotiated permessage-deflate (RFC 7692), and
 * then only without context takeover, so each message inflates on its own;
 * this side sends uncompressed.
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants as zlib, inflateRawSync } from 'node:zlib';
import { drainMicrotasks } from 'bun:jsc';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** A devtools reply carrying a screenshot is a few MB; past this the stream is taken as corrupt. */
const MAX_MESSAGE_BYTES = 256 << 20;
/** How long a closing socket waits for the server's close before it hangs up. */
const CLOSE_GRACE_MS = 1_000;

export type Frame =
  | { kind: 'text'; text: string }
  | { kind: 'ping'; payload: Uint8Array }
  | { kind: 'pong' }
  | { kind: 'close'; code: number; reason: string }
  /** The stream broke here: what came before it stands, nothing after it is read. 1007 for text that is not UTF-8, else 1002. */
  | { kind: 'invalid'; code: number; reason: string };

/** What permessage-deflate leaves off the end of each message (RFC 7692 section 7.2.1). */
const DEFLATE_TAIL = new Uint8Array([0x00, 0x00, 0xff, 0xff]);
/** Each message on its own: the server's compressor and this side's inflater keep no window between messages. */
const DEFLATE_OFFER = 'permessage-deflate; server_no_context_takeover; client_no_context_takeover';

/** Turns the bytes a server sent, cut anywhere, into messages; a malformed stream ends in one `invalid` frame. */
export class FrameReader {
  /** Bytes of a frame not complete yet, kept as they came, and how many the next parse needs. */
  #held: Uint8Array[] = [];
  #heldBytes = 0;
  #need = 2;
  /** The fragments of a text message still waiting for its final frame. */
  #parts: Uint8Array[] = [];
  #partBytes = 0;
  #fragmented = false;
  /** Whether the message being read set RSV1: its joined payload is deflated. */
  #compressed = false;
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #broken = false;
  /** Whether permessage-deflate was negotiated, so the first frame of a message may set RSV1. */
  readonly #inflate: boolean;

  constructor(options: { inflate?: boolean } = {}) { this.#inflate = options.inflate === true; }

  push(bytes: Uint8Array): Frame[] {
    if (this.#broken) return [];
    const frames: Frame[] = [];
    try {
      this.#read(bytes, frames);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.#broken = true;
      this.#held = []; this.#heldBytes = 0;
      frames.push({ kind: 'invalid', code: error.code, reason: error.message });
    }
    return frames;
  }

  #read(bytes: Uint8Array, frames: Frame[]): void {
    // The caller's buffer may be reused once this returns: what is held is a copy.
    if (this.#heldBytes + bytes.length < this.#need) {
      this.#held.push(bytes.slice());
      this.#heldBytes += bytes.length;
      return;
    }
    const joined = this.#held.length === 0 ? bytes : concat([...this.#held, bytes]);
    this.#held = []; this.#heldBytes = 0;
    let at = 0;
    for (;;) {
      const rest = joined.length - at;
      this.#need = 2;
      if (rest < 2) break;
      const first = joined[at]!, second = joined[at + 1]!;
      const fin = (first & 0x80) !== 0, opcode = first & 0x0f;
      const rsv = (first >> 4) & 7;
      if (rsv !== 0 && !(rsv === 4 && this.#inflate && (opcode === 0x1 || opcode === 0x2))) {
        throw new ProtocolError(`reserved bits ${rsv} set on opcode ${opcode}${this.#inflate ? '' : ' with no extension negotiated'}`);
      }
      if (second & 0x80) throw new ProtocolError('the server masked a frame');
      let length = second & 0x7f, header = 2;
      if (length === 126) {
        this.#need = 4;
        if (rest < 4) break;
        length = (joined[at + 2]! << 8) | joined[at + 3]!;
        header = 4;
      } else if (length === 127) {
        this.#need = 10;
        if (rest < 10) break;
        if (joined[at + 2]! & 0x80) throw new ProtocolError('a frame length with its top bit set');
        length = 0;
        for (let i = 2; i < 10; i++) length = length * 256 + joined[at + i]!;
        header = 10;
      }
      if (opcode >= 8 && (!fin || length > 125)) throw new ProtocolError(`a fragmented or ${length} B control frame (opcode ${opcode})`);
      if (length > MAX_MESSAGE_BYTES) throw new ProtocolError(`a ${length} B frame`);
      this.#need = header + length;
      if (rest < this.#need) break;
      const payload = joined.subarray(at + header, at + header + length);
      at += header + length;
      const frame = this.#frame(fin, opcode, payload, rsv === 4);
      if (frame !== null) frames.push(frame);
    }
    if (at < joined.length) { this.#held = [joined.slice(at)]; this.#heldBytes = joined.length - at; }
  }

  #frame(fin: boolean, opcode: number, payload: Uint8Array, compressed: boolean): Frame | null {
    switch (opcode) {
      case 0x0:
        if (!this.#fragmented) throw new ProtocolError('a continuation frame with no message to continue');
        return this.#data(fin, payload);
      case 0x1:
        if (this.#fragmented) throw new ProtocolError('a text frame inside a fragmented message');
        this.#compressed = compressed;
        return this.#data(fin, payload);
      case 0x2:
        throw new ProtocolError('a binary message on a text socket');
      case 0x8: {
        if (payload.length === 1) throw new ProtocolError('a close frame of 1 B');
        const code = payload.length >= 2 ? (payload[0]! << 8) | payload[1]! : 1005;
        if (payload.length >= 2 && !sendableCloseCode(code)) throw new ProtocolError(`a close frame with code ${code}`);
        return { kind: 'close', code, reason: this.#text(payload.subarray(2)) };
      }
      case 0x9:
        return { kind: 'ping', payload: payload.slice() };
      case 0xa:
        return { kind: 'pong' };
      default:
        throw new ProtocolError(`opcode ${opcode}`);
    }
  }

  #data(fin: boolean, payload: Uint8Array): Frame | null {
    if (this.#partBytes + payload.length > MAX_MESSAGE_BYTES) throw new ProtocolError(`a message over ${MAX_MESSAGE_BYTES} B`);
    if (!fin) {
      this.#fragmented = true;
      this.#parts.push(payload.slice());
      this.#partBytes += payload.length;
      return null;
    }
    const whole = this.#parts.length === 0 ? payload : concat([...this.#parts, payload]);
    this.#parts = []; this.#partBytes = 0; this.#fragmented = false;
    if (!this.#compressed) return { kind: 'text', text: this.#text(whole) };
    this.#compressed = false;
    return { kind: 'text', text: this.#text(inflated(whole)) };
  }

  #text(bytes: Uint8Array): string {
    try {
      return this.#decoder.decode(bytes);
    } catch {
      throw new ProtocolError('a text message that is not UTF-8', 1007);
    }
  }
}

class ProtocolError extends Error {
  /** The close code the stream ends with. */
  constructor(message: string, readonly code = 1002) { super(message); }
}

/** Whether a peer may send `code` in a close frame (RFC 6455 section 7.4 and the IANA registry). */
function sendableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

function inflated(deflated: Uint8Array): Uint8Array {
  try {
    // A message ends on a sync flush, not a final block: the stream is not over.
    return inflateRawSync(concat([deflated, DEFLATE_TAIL]), { finishFlush: zlib.Z_SYNC_FLUSH, maxOutputLength: MAX_MESSAGE_BYTES });
  } catch (error) {
    throw new ProtocolError(`a compressed message that does not inflate (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Why `TextSocket.connect` failed; `timedOut` when the server never answered the upgrade. */
export class UpgradeError extends Error {
  constructor(message: string, readonly timedOut = false) { super(message); }
}

export interface ConnectOptions {
  /** Upgrade request headers; a `Host` here replaces the URL's. */
  headers?: Record<string, string>;
  /** Offer permessage-deflate without context takeover, for a server that compresses what it sends. */
  deflate?: boolean;
}

/** One client frame, masked as RFC 6455 requires of a client. */
export function encodeFrame(opcode: number, payload: Uint8Array, mask: Uint8Array = randomBytes(4)): Uint8Array {
  const n = payload.length;
  const header = n < 126 ? 2 : n < 65_536 ? 4 : 10;
  const out = new Uint8Array(header + 4 + n);
  out[0] = 0x80 | opcode;
  if (n < 126) out[1] = 0x80 | n;
  else if (n < 65_536) { out[1] = 0x80 | 126; out[2] = n >> 8; out[3] = n & 0xff; }
  else {
    out[1] = 0x80 | 127;
    let rest = n;
    for (let i = 9; i >= 2; i--) { out[i] = rest % 256; rest = Math.floor(rest / 256); }
  }
  out.set(mask, header);
  for (let i = 0; i < n; i++) out[header + 4 + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

export interface CloseEvent { code: number; reason: string }

/** An open devtools socket: text in and out, one close event. */
export class TextSocket {
  #socket: Bun.Socket;
  #queue: Uint8Array[] = [];
  #open = true;
  #closed = false;
  #onMessage: ((text: string) => void) | null = null;
  /** Messages that came before the reader listened: those sent with the upgrade's answer. */
  #inbox: string[] = [];
  #onClose: Array<(event: CloseEvent) => void> = [];
  #closeEvent: CloseEvent | null = null;
  #graceTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(socket: Bun.Socket) { this.#socket = socket; }

  /** Whether `send` still reaches the server. */
  get open(): boolean { return this.#open; }

  /** Bytes written but not yet taken by the connection; none once it ended. */
  get bufferedAmount(): number {
    let bytes = 0;
    for (const chunk of this.#queue) bytes += chunk.length;
    return bytes;
  }

  /**
   * Only one listener: a devtools socket has one reader. It gets what arrived
   * before it first, each message's microtasks run before the next, as in a read.
   */
  onMessage(listener: (text: string) => void): void {
    this.#onMessage = listener;
    for (let first = true; this.#inbox.length > 0 && this.#onMessage === listener; first = false) {
      if (!first) drainMicrotasks();
      const text = this.#inbox.shift()!;
      reported(() => listener(text));
    }
  }

  /** Called once; at once when the socket already closed. */
  onClose(listener: (event: CloseEvent) => void): void {
    if (this.#closeEvent !== null) reported(() => listener(this.#closeEvent!));
    else this.#onClose.push(listener);
  }

  #deliver(text: string): void {
    const listener = this.#onMessage;
    if (listener === null) this.#inbox.push(text);
    else reported(() => listener(text));
  }

  send(text: string): void {
    if (!this.#open) return;
    this.#write(encodeFrame(0x1, new TextEncoder().encode(text)));
  }

  /** Sends a close and hangs up once the server answers, or after `CLOSE_GRACE_MS`. */
  close(code = 1000, reason = ''): void {
    if (!this.#open) return;
    this.#open = false;
    this.#write(encodeFrame(0x8, closePayload(code, reason)));
    this.#graceTimer = setTimeout(() => this.#ended({ code, reason: 'the server did not answer the close' }), CLOSE_GRACE_MS);
  }

  #write(bytes: Uint8Array): void {
    this.#queue.push(bytes);
    if (this.#queue.length === 1) this.#flush();
  }

  #flush(): void {
    while (this.#queue.length > 0) {
      const chunk = this.#queue[0]!, written = this.#socket.write(chunk);
      // Shut or failed for good (`-errno`): what waits would never leave.
      if (written < 0) { this.#queue.length = 0; this.#ended({ code: 1006, reason: `the connection failed (${written})` }); return; }
      if (written < chunk.length) { this.#queue[0] = chunk.subarray(written); return; }
      this.#queue.shift();
    }
  }

  #ended(event: CloseEvent): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeEvent = event;
    this.#open = false;
    clearTimeout(this.#graceTimer);
    // Nothing waiting leaves any more: a reader that stopped reading must not keep it alive.
    this.#queue = [];
    this.#socket.end();
    const listeners = this.#onClose;
    this.#onClose = [];
    this.#onMessage = null;
    for (const listener of listeners) reported(() => listener(event));
  }

  /**
   * Connects, upgrades and resolves once the server accepted. Rejects with the
   * server's answer when it refuses, and after `timeoutMs` when it says nothing.
   */
  static connect(url: string, timeoutMs: number, options: ConnectOptions = {}): Promise<TextSocket> {
    let target: URL, request: string;
    try {
      target = new URL(url);
      if (target.protocol !== 'ws:' && target.protocol !== 'wss:') throw new UpgradeError(`a WebSocket url starts with ws:// or wss://, got ${target.protocol}`);
      request = upgradeRequest(target, options);
    } catch (error) {
      return Promise.reject(error instanceof UpgradeError ? error : new UpgradeError(`not a WebSocket url: ${url}`));
    }
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    const secure = target.protocol === 'wss:';
    // `[::1]` in a URL is `::1` to connect to.
    const hostname = target.hostname.replace(/^\[(.*)\]$/, '$1');
    return new Promise<TextSocket>((resolve, reject) => {
      let client: TextSocket | null = null;
      let handshake: Uint8Array = new Uint8Array(0);
      let reader = new FrameReader();
      let settled = false;
      /** The connection before it upgraded: a failed upgrade ends it, including one that connects after the timeout. */
      let raw: Bun.Socket | null = null;
      const fail = (message: string, timedOut = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        raw?.end();
        reject(new UpgradeError(message, timedOut));
      };
      const receive = (bytes: Uint8Array) => {
        let delivered = false;
        for (const frame of reader.push(bytes)) {
          if (client!.#closed) return;
          // As with a WebSocket's message events: what the last message started, an awaited answer
          // included, runs before the next one arrives, though both came in one read.
          if (delivered) drainMicrotasks();
          if (client!.#closed) return;
          delivered = frame.kind === 'text';
          if (frame.kind === 'text') client!.#deliver(frame.text);
          else if (frame.kind === 'ping') { if (client!.#open) client!.#write(encodeFrame(0xa, frame.payload)); }
          else if (frame.kind === 'close') {
            // Echo the close unless this side sent one first, then hang up.
            if (client!.#open) {
              client!.#open = false;
              client!.#write(encodeFrame(0x8, frame.code === 1005 ? new Uint8Array(0) : new Uint8Array([frame.code >> 8, frame.code & 0xff])));
            }
            client!.#ended({ code: frame.code, reason: frame.reason });
          } else if (frame.kind === 'invalid') {
            client!.#write(encodeFrame(0x8, new Uint8Array([frame.code >> 8, frame.code & 0xff])));
            client!.#ended({ code: frame.code, reason: frame.reason });
          }
        }
      };
      const timer = setTimeout(() => fail(`no WebSocket upgrade from ${target.host} within ${timeoutMs} ms`, true), timeoutMs);
      Bun.connect({
        hostname,
        port: Number(target.port || (secure ? 443 : 80)),
        // Checked against the system's authorities, for the name the URL gives.
        ...(secure ? { tls: { serverName: hostname } } : {}),
        socket: {
          open(socket) {
            raw = socket;
            if (settled) { socket.end(); return; }
            // Over TLS this runs before the handshake, and a write here is dropped: the request goes once it succeeded.
            if (!secure) socket.write(`${request}Sec-WebSocket-Key: ${key}\r\n\r\n`);
          },
          data(socket, bytes) {
            if (client !== null) { receive(bytes); return; }
            if (settled) { socket.end(); return; }
            handshake = concat([handshake, bytes]);
            const end = headerEnd(handshake);
            if (end === -1) {
              if (handshake.length > 16_384) fail('the WebSocket upgrade answer has no end');
              return;
            }
            const head = new TextDecoder().decode(handshake.subarray(0, end));
            const status = head.split('\r\n', 1)[0] ?? '';
            if (!/^HTTP\/1\.1 101\b/.test(status)) { fail(`the server refused the WebSocket upgrade: ${status}`); return; }
            if (/^sec-websocket-accept:\s*(\S+)/im.exec(head)?.[1] !== accept) { fail('the server answered the upgrade with a wrong Sec-WebSocket-Accept'); return; }
            const refused = upgradeRefusal(head);
            if (refused !== null) { fail(refused); return; }
            const extensions = /^sec-websocket-extensions:\s*(.*)$/im.exec(head)?.[1]?.trim();
            if (extensions) {
              const refusal = deflateRefusal(extensions, options.deflate === true);
              if (refusal !== null) { fail(refusal); return; }
              reader = new FrameReader({ inflate: true });
            }
            settled = true;
            clearTimeout(timer);
            client = new TextSocket(socket);
            resolve(client);
            if (end < handshake.length) receive(handshake.subarray(end));
          },
          drain() { if (client !== null) client.#flush(); },
          handshake(socket, success, authorizationError) {
            if (!success || authorizationError) { fail(`the TLS certificate of ${target.host} was refused: ${authorizationError?.message ?? 'the handshake failed'}`); return; }
            if (settled) { socket.end(); return; }
            socket.write(`${request}Sec-WebSocket-Key: ${key}\r\n\r\n`);
          },
          end() { if (client) client.#ended({ code: 1006, reason: 'the server hung up' }); else fail('the server hung up during the WebSocket upgrade'); },
          close() { if (client) client.#ended({ code: 1006, reason: 'the connection closed' }); else fail('the connection closed during the WebSocket upgrade'); },
          error(_socket, error) { if (client) client.#ended({ code: 1006, reason: error.message }); else fail(`the WebSocket connection failed: ${error.message}`); },
          connectError(_socket, error) { fail(`could not connect to ${target.host}: ${error.message}`); },
        },
      }).catch((error: unknown) => fail(`could not connect to ${target.host}: ${error instanceof Error ? error.message : String(error)}`));
    });
  }
}

/** Null when an upgrade answer says `Upgrade: websocket` and `Connection: Upgrade` and picks no subprotocol; else why not. */
function upgradeRefusal(head: string): string | null {
  const tokens = (name: string) => [...head.matchAll(new RegExp(`^${name}:(.*)$`, 'gim'))].flatMap(match => match[1]!.split(',').map(token => token.trim().toLowerCase()));
  if (!tokens('upgrade').includes('websocket')) return 'the server answered the upgrade without Upgrade: websocket';
  if (!tokens('connection').includes('upgrade')) return 'the server answered the upgrade without Connection: Upgrade';
  // This client offers no subprotocol, so the server may not pick one.
  const protocol = /^sec-websocket-protocol:\s*(.*)$/im.exec(head)?.[1]?.trim();
  return protocol ? `the server picked a subprotocol nobody offered: ${protocol}` : null;
}

/** Runs a listener; what it throws goes where an uncaught error goes, as from a WebSocket's listener, and the reading goes on. */
function reported(listener: () => void): void {
  try {
    listener();
  } catch (error) {
    reportError(error);
  }
}

/** The request line and headers of the upgrade, up to the key. */
function upgradeRequest(target: URL, options: ConnectOptions): string {
  const headers = new Map<string, [string, string]>([['host', ['Host', target.host]]]);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!/^[!#$%&'*+.^`|~\w-]+$/.test(name) || /[\r\n]/.test(value)) throw new UpgradeError(`upgrade header ${JSON.stringify(name)} must be a token with a value on one line`);
    if (/^(upgrade|connection|sec-websocket-.*)$/i.test(name)) throw new UpgradeError(`upgrade header ${name} is the client's own`);
    headers.set(name.toLowerCase(), [name, value]);
  }
  if (options.deflate === true) headers.set('sec-websocket-extensions', ['Sec-WebSocket-Extensions', DEFLATE_OFFER]);
  const lines = [...headers.values()].map(([name, value]) => `${name}: ${value}\r\n`).join('');
  return `GET ${target.pathname}${target.search} HTTP/1.1\r\n${lines}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n`;
}

/**
 * Null when the server's extensions are the deflate this side offered, with
 * its compressor keeping no window between messages; else why not.
 */
function deflateRefusal(extensions: string, offered: boolean): string | null {
  if (!offered) return `the server turned on extensions nobody offered: ${extensions}`;
  const [name, ...params] = extensions.split(';').map(part => part.trim().toLowerCase());
  if (name !== 'permessage-deflate' || extensions.includes(',')) return `the server answered the deflate offer with ${extensions}`;
  if (!params.includes('server_no_context_takeover')) return `the server keeps a deflate window between messages, which this client did not offer: ${extensions}`;
  const unknown = params.find(param => !/^(server_no_context_takeover|client_no_context_takeover|(server|client)_max_window_bits(=\d+)?)$/.test(param));
  return unknown === undefined ? null : `the server set a deflate parameter this client does not know: ${unknown}`;
}

/** A close frame's payload: the code, then as much of the reason as fits in 125 bytes without splitting a character. */
function closePayload(code: number, reason: string): Uint8Array {
  let text = new TextEncoder().encode(reason);
  if (text.length > 123) text = new TextEncoder().encode(new TextDecoder().decode(text.subarray(0, 123)).replace(/\uFFFD$/, ''));
  return concat([new Uint8Array([code >> 8, code & 0xff]), text]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function headerEnd(bytes: Uint8Array): number {
  for (let i = 3; i < bytes.length; i++) if (bytes[i - 3] === 13 && bytes[i - 2] === 10 && bytes[i - 1] === 13 && bytes[i] === 10) return i + 1;
  return -1;
}
