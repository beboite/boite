import { expect, test } from 'bun:test';
import { FrameQueue } from '../src/server/frame-queue.ts';
import type { ServerConnection } from '../src/server/connection.ts';

test('pending asynchronous requests leave room for a second connection', async () => {
  const sender = { close: () => undefined } as unknown as ServerConnection;
  const reader = { close: () => undefined } as unknown as ServerConnection;
  const gate = Promise.withResolvers<void>();
  let active = 0, maximum = 0, observed = 0;
  const queue = new FrameQueue(async connection => {
    if (connection === reader) { observed = active; return; }
    active++; maximum = Math.max(maximum, active);
    await gate.promise;
    active--;
  });
  try {
    const burst = Array.from({ length: 64 }, () => queue.enqueue(sender, 'slow'));
    await queue.enqueue(reader, 'read');
    expect(observed).toBeGreaterThan(0);
    expect(observed).toBeLessThanOrEqual(8);
    gate.resolve();
    await Promise.all(burst);
    expect(maximum).toBeLessThanOrEqual(8);
  } finally { gate.resolve(); queue.close(); }
});

test('asynchronous floods across connections keep the total active work bounded', async () => {
  const connections = Array.from({ length: 10 }, () => ({ close: () => undefined }) as unknown as ServerConnection);
  const gate = Promise.withResolvers<void>(), filled = Promise.withResolvers<void>();
  let active = 0, maximum = 0;
  const queue = new FrameQueue(async () => {
    active++; maximum = Math.max(maximum, active);
    if (active === 64) filled.resolve();
    await gate.promise;
    active--;
  });
  try {
    const pending = connections.flatMap(connection => Array.from({ length: 8 }, () => queue.enqueue(connection, 'slow')));
    await filled.promise;
    expect(maximum).toBe(64);
    gate.resolve();
    await Promise.all(pending);
    expect(maximum).toBe(64);
  } finally { gate.resolve(); queue.close(); }
});

test('an incoming flood closes its connection and never executes its abandoned requests', async () => {
  const closed: { code: number; reason?: string }[] = [];
  const connection = { close: (code: number, reason?: string) => closed.push({ code, reason }) } as unknown as ServerConnection;
  let calls = 0;
  const queue = new FrameQueue(async () => { calls++; });
  try {
    const pending = Array.from({ length: 4097 }, () => queue.enqueue(connection, '{}'));
    pending.push(queue.enqueue(connection, 'after close'));
    await Promise.all(pending);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.code).toBe(1013);
    expect(closed[0]?.reason).toContain('1024 frames');
    expect(calls).toBe(0);
  } finally { queue.close(); }
});

test('large queued frames are bounded by bytes and shutdown releases accepted work', async () => {
  const closed: number[] = [];
  const connection = { close: (code: number) => closed.push(code) } as unknown as ServerConnection;
  let calls = 0;
  const queue = new FrameQueue(async () => { calls++; });
  const raw = 'x'.repeat(16 * 1024 * 1024);
  try {
    await Promise.all([queue.enqueue(connection, raw), queue.enqueue(connection, raw), queue.enqueue(connection, raw)]);
    expect(closed).toEqual([1013]);
    expect(calls).toBe(0);
    const other = { close: () => undefined } as unknown as ServerConnection;
    const accepted = queue.enqueue(other, 'accepted');
    queue.close();
    await accepted;
    await queue.enqueue(other, 'after shutdown');
    expect(calls).toBe(0);
  } finally { queue.close(); }
});

test('a shared backlog evicts a flooding sender instead of an incoming reader', async () => {
  const closed: number[] = [];
  const senders = Array.from({ length: 4 }, (_, index) => ({ close: () => closed.push(index) }) as unknown as ServerConnection);
  let readerClosed = false, reads = 0;
  const reader = { close: () => { readerClosed = true; } } as unknown as ServerConnection;
  const queue = new FrameQueue(async connection => { if (connection === reader) reads++; });
  try {
    const backlog = senders.flatMap(sender => Array.from({ length: 1024 }, () => queue.enqueue(sender, '{}')));
    await queue.enqueue(reader, 'read');
    await Promise.all(backlog);
    expect(readerClosed).toBe(false);
    expect(reads).toBe(1);
    expect(closed).toHaveLength(1);
  } finally { queue.close(); }
});

test('one sender cannot spend another connection\'s byte capacity', async () => {
  let senderClosed = false, readerClosed = false, reads = 0;
  const sender = { close: () => { senderClosed = true; } } as unknown as ServerConnection;
  const reader = { close: () => { readerClosed = true; } } as unknown as ServerConnection;
  const queue = new FrameQueue(async connection => { if (connection === reader) reads++; });
  const raw = 'x'.repeat(16 * 1024 * 1024);
  try {
    const backlog = [queue.enqueue(sender, raw), queue.enqueue(sender, raw)];
    await queue.enqueue(reader, 'read');
    await Promise.all(backlog);
    expect(senderClosed).toBe(true);
    expect(readerClosed).toBe(false);
    expect(reads).toBe(1);
  } finally { queue.close(); }
});
