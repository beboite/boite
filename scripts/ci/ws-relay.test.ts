import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { FrameCheck } from '../../tests/e2e/lib/ws-relay.ts';

const handshake = new TextEncoder().encode('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
function frame(opcode: number, length: number, fin = true): Uint8Array {
  const head = length < 126 ? [length] : length < 65536 ? [126, length >> 8, length & 255] : [127, 0, 0, 0, 0, (length >>> 24) & 255, (length >> 16) & 255, (length >> 8) & 255, length & 255];
  const out = new Uint8Array(1 + head.length + length).fill(0x78);
  out[0] = (fin ? 0x80 : 0) | opcode; out.set(head, 1);
  return out;
}
function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

test('the relay check reads a well-formed browser stream however the reads cut it', () => {
  const stream = join([handshake, frame(1, 5), frame(1, 126), frame(1, 70_000), frame(9, 0), frame(1, 0, false), frame(0, 3)]);
  for (const cut of [1, 2, 3, 7, 125, 4096, stream.length]) {
    const check = new FrameCheck();
    for (let at = 0; at < stream.length; at += cut) check.push(stream.subarray(at, at + cut));
    expect(check.report()).toStartWith(`browser stream (extensions none) well-formed over 6 frames, 4 messages and ${stream.length} bytes`);
  }
});

test('the relay check names the first byte a malformed stream breaks at', () => {
  const fragmented = new FrameCheck();
  fragmented.push(join([handshake, frame(1, 10), frame(9, 2, false)]));
  expect(fragmented.report()).toStartWith(`browser stream (extensions none) malformed: a fragmented or long control frame at byte ${handshake.length + 12}`);
  const opcode = new FrameCheck();
  opcode.push(join([handshake, frame(3, 1)]));
  expect(opcode.report()).toStartWith(`browser stream (extensions none) malformed: opcode 3 at byte ${handshake.length}`);
});

test('the relay check lets a deflated message set RSV1 only once the browser accepted permessage-deflate', () => {
  const deflated = frame(1, 4); deflated[0] = deflated[0]! | 0x40;
  const accepted = new FrameCheck();
  accepted.push(join([new TextEncoder().encode('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits=15\r\n\r\n'), deflated]));
  expect(accepted.report()).toContain('well-formed over 1 frames');
  const refused = new FrameCheck();
  refused.push(join([handshake, deflated]));
  expect(refused.report()).toContain(`malformed: reserved bits set at byte ${handshake.length}`);
});

test('the relay check keeps the browser bytes and read lengths for a replay', () => {
  const dir = mkdtempSync(joinPath(tmpdir(), 'ws-relay-'));
  try {
    const check = new FrameCheck();
    const stream = join([handshake, frame(1, 300)]);
    check.push(stream.subarray(0, 40)); check.push(stream.subarray(40));
    expect(check.dump(joinPath(dir, 'devtools'))).toEndWith(`(${stream.length} of ${stream.length} bytes)`);
    expect(new Uint8Array(readFileSync(joinPath(dir, 'devtools.bin')))).toEqual(stream);
    expect(JSON.parse(readFileSync(joinPath(dir, 'devtools.reads.json'), 'utf8'))).toEqual([40, stream.length - 40]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
