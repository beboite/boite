/*
 * A WebSocket client for devtools sockets, on `Bun.connect`. Bun's own client
 * (1.4.2 and 1.4.3) closes sound devtools streams with 1002 ("control frame is
 * fragmented", "unsupported control frame", "unexpected opcode") or 1011
 * ("Compression not implemented yet"), with or without permessage-deflate:
 * #613's relay checked every frame Chrome sent on those runs and found them
 * well-formed (#623, #635). The relay read the same bytes through
 * `Bun.connect` without a fault, so this client parses them itself.
 *
 * RFC 6455 for text messages only: no extension is offered, server frames
 * must be unmasked with their reserved bits clear, fragmented messages are
 * joined, pings are answered and a close is echoed.
 */

import { createHash, randomBytes } from 'node:crypto';

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
  /** The stream broke here: what came before it stands, nothing after it is read. */
  | { kind: 'invalid'; reason: string };

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
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #broken = false;

  push(bytes: Uint8Array): Frame[] {
    if (this.#broken) return [];
    const frames: Frame[] = [];
    try {
      this.#read(bytes, frames);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.#broken = true;
      this.#held = []; this.#heldBytes = 0;
      frames.push({ kind: 'invalid', reason: error.message });
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
      if (first & 0x70) throw new ProtocolError(`reserved bits ${(first >> 4) & 7} set on opcode ${opcode} with no extension negotiated`);
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
      const frame = this.#frame(fin, opcode, payload);
      if (frame !== null) frames.push(frame);
    }
    if (at < joined.length) { this.#held = [joined.slice(at)]; this.#heldBytes = joined.length - at; }
  }

  #frame(fin: boolean, opcode: number, payload: Uint8Array): Frame | null {
    switch (opcode) {
      case 0x0:
        if (!this.#fragmented) throw new ProtocolError('a continuation frame with no message to continue');
        return this.#data(fin, payload);
      case 0x1:
        if (this.#fragmented) throw new ProtocolError('a text frame inside a fragmented message');
        return this.#data(fin, payload);
      case 0x2:
        throw new ProtocolError('a binary message on a devtools socket');
      case 0x8: {
        if (payload.length === 1) throw new ProtocolError('a close frame of 1 B');
        const code = payload.length >= 2 ? (payload[0]! << 8) | payload[1]! : 1005;
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
    return { kind: 'text', text: this.#text(whole) };
  }

  #text(bytes: Uint8Array): string {
    try {
      return this.#decoder.decode(bytes);
    } catch {
      throw new ProtocolError('a text message that is not UTF-8');
    }
  }
}

class ProtocolError extends Error {}

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

  /** Only one listener: a devtools socket has one reader. It gets what arrived before it first. */
  onMessage(listener: (text: string) => void): void {
    this.#onMessage = listener;
    for (const text of this.#inbox.splice(0)) listener(text);
  }

  /** Called once; at once when the socket already closed. */
  onClose(listener: (event: CloseEvent) => void): void {
    if (this.#closeEvent !== null) listener(this.#closeEvent);
    else this.#onClose.push(listener);
  }

  #deliver(text: string): void {
    if (this.#onMessage === null) this.#inbox.push(text);
    else this.#onMessage(text);
  }

  send(text: string): void {
    if (!this.#open) return;
    this.#write(encodeFrame(0x1, new TextEncoder().encode(text)));
  }

  /** Sends a close and hangs up once the server answers, or after `CLOSE_GRACE_MS`. */
  close(code = 1000): void {
    if (!this.#open) return;
    this.#open = false;
    this.#write(encodeFrame(0x8, new Uint8Array([code >> 8, code & 0xff])));
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
    this.#socket.end();
    for (const listener of this.#onClose) listener(event);
  }

  /**
   * Connects, upgrades and resolves once the server accepted. Rejects with the
   * server's answer when it refuses, and after `timeoutMs` when it says nothing.
   */
  static connect(url: string, timeoutMs: number): Promise<TextSocket> {
    const target = new URL(url);
    if (target.protocol !== 'ws:') return Promise.reject(new Error(`only ws:// devtools urls are supported, got ${target.protocol}`));
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    return new Promise<TextSocket>((resolve, reject) => {
      let client: TextSocket | null = null;
      let handshake: Uint8Array = new Uint8Array(0);
      const reader = new FrameReader();
      let settled = false;
      /** The connection before it upgraded: a failed upgrade ends it, including one that connects after the timeout. */
      let raw: Bun.Socket | null = null;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        raw?.end();
        reject(new Error(message));
      };
      const receive = (bytes: Uint8Array) => {
        for (const frame of reader.push(bytes)) {
          if (client!.#closed) return;
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
            client!.#write(encodeFrame(0x8, new Uint8Array([1002 >> 8, 1002 & 0xff])));
            client!.#ended({ code: 1002, reason: frame.reason });
          }
        }
      };
      const timer = setTimeout(() => fail(`no WebSocket upgrade from ${target.host} within ${timeoutMs} ms`), timeoutMs);
      Bun.connect({
        hostname: target.hostname,
        port: Number(target.port || 80),
        socket: {
          open(socket) {
            raw = socket;
            if (settled) { socket.end(); return; }
            socket.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
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
            const extensions = /^sec-websocket-extensions:\s*(.*)$/im.exec(head)?.[1]?.trim();
            if (extensions) { fail(`the server turned on extensions nobody offered: ${extensions}`); return; }
            settled = true;
            clearTimeout(timer);
            client = new TextSocket(socket);
            resolve(client);
            if (end < handshake.length) receive(handshake.subarray(end));
          },
          drain() { if (client !== null) client.#flush(); },
          end() { if (client) client.#ended({ code: 1006, reason: 'the server hung up' }); else fail('the server hung up during the WebSocket upgrade'); },
          close() { if (client) client.#ended({ code: 1006, reason: 'the connection closed' }); else fail('the connection closed during the WebSocket upgrade'); },
          error(_socket, error) { if (client) client.#ended({ code: 1006, reason: error.message }); else fail(`the WebSocket connection failed: ${error.message}`); },
          connectError(_socket, error) { fail(`could not connect to ${target.host}: ${error.message}`); },
        },
      }).catch((error: unknown) => fail(`could not connect to ${target.host}: ${error instanceof Error ? error.message : String(error)}`));
    });
  }
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
