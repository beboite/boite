/*
 * `BOITE_E2E_TRACE=1` (CI flake loops): a loopback relay between the test's
 * devtools WebSocket and the browser. It checks every frame the browser sends
 * against RFC 6455 as the bytes pass, so a socket Bun closes with 1002
 * ("control frame is fragmented", "unexpected opcode") can be told apart: a
 * malformed stream from the browser, or a well-formed one Bun misread.
 */

import { writeFileSync } from 'node:fs';

/** A devtools stream past this stops being kept for a replay; the check goes on. */
const KEEP_BYTES = 64 << 20;

interface Frame { at: number; opcode: number; fin: boolean; compressed: boolean; length: number }

/** Reads frame headers as bytes arrive and skips payloads; keeps the first error and the last frames and reads. */
export class FrameCheck {
  #buffer = new Uint8Array(0);
  #skip = 0;
  /** Stream bytes before the buffer, skipped payloads included, and all bytes seen. */
  #offset = 0;
  #total = 0;
  #handshake = true;
  /** The `Sec-WebSocket-Extensions` the browser accepted; `permessage-deflate` lets a message's first frame set RSV1. */
  #extensions = '';
  #frames = 0;
  /** Complete data messages, to compare with what the test's socket delivered. */
  #messages = 0;
  #recent: Frame[] = [];
  #chunks: Array<{ at: number; length: number; ms: number }> = [];
  #error: string | null = null;
  #started = performance.now();
  /** Every read as it arrived, up to `KEEP_BYTES`, for `dump` to replay. */
  #kept: Uint8Array[] = [];
  #keptBytes = 0;

  push(bytes: Uint8Array): void {
    this.#chunks.push({ at: this.#total, length: bytes.length, ms: Math.round(performance.now() - this.#started) });
    this.#total += bytes.length;
    if (this.#keptBytes + bytes.length <= KEEP_BYTES) { this.#kept.push(bytes); this.#keptBytes += bytes.length; }
    if (this.#chunks.length > 12) this.#chunks.shift();
    if (this.#error) return;
    let data = bytes;
    if (this.#skip > 0) {
      const used = Math.min(this.#skip, data.length);
      this.#skip -= used; this.#offset += used; data = data.subarray(used);
    }
    const joined = new Uint8Array(this.#buffer.length + data.length);
    joined.set(this.#buffer); joined.set(data, this.#buffer.length);
    let at = 0;
    if (this.#handshake) {
      const end = indexOfHeaderEnd(joined);
      if (end === -1) { this.#buffer = joined; return; }
      at = end; this.#handshake = false;
      this.#extensions = /^sec-websocket-extensions:\s*(.*)$/im.exec(new TextDecoder().decode(joined.subarray(0, end)))?.[1]?.trim() ?? '';
    }
    while (!this.#error) {
      const rest = joined.length - at;
      if (rest < 2) break;
      const first = joined[at]!, second = joined[at + 1]!;
      let length = second & 0x7f, header = 2;
      if (length === 126) { if (rest < 4) break; length = (joined[at + 2]! << 8) | joined[at + 3]!; header = 4; }
      else if (length === 127) {
        if (rest < 10) break;
        length = 0;
        for (let i = 2; i < 10; i++) length = length * 256 + joined[at + i]!;
        header = 10;
      }
      const frame = { at: this.#offset + at, opcode: first & 0x0f, fin: (first & 0x80) !== 0, compressed: (first & 0x40) !== 0, length };
      this.#error = problem(first, second, frame, this.#extensions.includes('permessage-deflate'));
      this.#frames++;
      if (frame.fin && frame.opcode <= 2) this.#messages++;
      this.#recent.push(frame);
      if (this.#recent.length > 12) this.#recent.shift();
      const payload = Math.min(length, rest - header);
      at += header + payload;
      if (payload < length) { this.#skip = length - payload; break; }
    }
    this.#offset += at;
    this.#buffer = joined.slice(at);
  }

  /** What the browser sent, as one file of bytes and one of read lengths, so a replay cuts it the same way. */
  dump(path: string): string {
    const whole = new Uint8Array(this.#keptBytes);
    let at = 0;
    for (const part of this.#kept) { whole.set(part, at); at += part.length; }
    writeFileSync(`${path}.bin`, whole);
    writeFileSync(`${path}.reads.json`, JSON.stringify(this.#kept.map(part => part.length)));
    return `${path}.bin (${whole.length} of ${this.#total} bytes)`;
  }

  report(): string {
    const frames = this.#recent.map(frame => `${frame.at}:op${frame.opcode}${frame.compressed ? ' deflated' : ''}${frame.fin ? '' : ' unfinished'} ${frame.length} B`).join(', ');
    const reads = this.#chunks.map(chunk => `${chunk.at}+${chunk.length} at ${chunk.ms} ms`).join(', ');
    return `browser stream (extensions ${this.#extensions || 'none'}) ${this.#error ? `malformed: ${this.#error}` : 'well-formed'} over ${this.#frames} frames, ${this.#messages} messages and ${this.#total} bytes; last frames ${frames || 'none'}; last reads ${reads}`;
  }
}

function problem(first: number, second: number, frame: Frame, deflate: boolean): string | null {
  if (first & (deflate && (frame.opcode === 1 || frame.opcode === 2) ? 0x30 : 0x70)) return `reserved bits set at byte ${frame.at}`;
  if (second & 0x80) return `a masked server frame at byte ${frame.at}`;
  if (![0, 1, 2, 8, 9, 10].includes(frame.opcode)) return `opcode ${frame.opcode} at byte ${frame.at}`;
  if (frame.opcode >= 8 && (!frame.fin || frame.length > 125)) return `a fragmented or long control frame at byte ${frame.at}`;
  return null;
}

function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let i = 3; i < bytes.length; i++) if (bytes[i - 3] === 13 && bytes[i - 2] === 10 && bytes[i - 1] === 13 && bytes[i] === 10) return i + 1;
  return -1;
}

/** Each side writes what fits now and the rest once it drains, in order. */
function sender(): { write(socket: { write(bytes: Uint8Array): number }, bytes: Uint8Array): void; drain(socket: { write(bytes: Uint8Array): number }): void } {
  const queue: Uint8Array[] = [];
  const drain = (socket: { write(bytes: Uint8Array): number }) => {
    while (queue.length) {
      const chunk = queue[0]!, written = socket.write(chunk);
      if (written < 0) { queue.length = 0; return; }
      if (written < chunk.length) { queue[0] = chunk.subarray(written); return; }
      queue.shift();
    }
  };
  return { write: (socket, bytes) => { queue.push(bytes); if (queue.length === 1) drain(socket); }, drain };
}

/** A `ws://` url on a loopback relay to `url`, and the check of what the browser sent through it. */
export async function relay(url: string): Promise<{ url: string; report(): string; dump(path: string): string; close(): void }> {
  const target = new URL(url);
  const check = new FrameCheck();
  const toBrowser = sender(), toTest = sender();
  let upstream: Bun.Socket | null = null;
  let early: Uint8Array[] = [];
  let test: Bun.Socket | null = null;
  const server = Bun.listen({
    hostname: '127.0.0.1', port: 0,
    socket: {
      async open(socket) {
        test = socket;
        upstream = await Bun.connect({
          hostname: target.hostname, port: Number(target.port),
          socket: {
            data(_upstream, bytes) { const copy = bytes.slice(); check.push(copy); toTest.write(socket, copy); },
            drain(own) { toBrowser.drain(own); },
            close() { socket.end(); },
            error() { socket.end(); },
          },
        });
        for (const bytes of early) toBrowser.write(upstream, bytes);
        early = [];
      },
      data(_socket, bytes) { const copy = bytes.slice(); if (upstream) toBrowser.write(upstream, copy); else early.push(copy); },
      drain(socket) { toTest.drain(socket); },
      close() { upstream?.end(); },
      error() { upstream?.end(); },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}${target.pathname}`,
    report: () => check.report(),
    dump: path => check.dump(path),
    close: () => { test?.end(); upstream?.end(); server.stop(true); },
  };
}
