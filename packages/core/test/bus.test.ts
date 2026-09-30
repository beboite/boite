import { expect, test } from 'bun:test';
import { Bus } from '../src/bus.ts';

test('a throwing listener neither stops the others nor escapes the delta timer', async () => {
  const bus = new Bus();
  const errors: string[] = [];
  bus.onError = (message) => errors.push(message);
  const seen: string[] = [];
  bus.onAny(() => {
    throw new Error('listener broke');
  });
  bus.onAny((name) => seen.push(name));
  bus.emit('message.delta', { threadId: 't', messageId: 'm', partIndex: 0, text: 'hi' });
  // The delta goes out from a 16 ms timer, where a throw would end the process.
  await Bun.sleep(40);
  expect(seen).toEqual(['message.delta']);
  expect(errors).toEqual(['event listener failed on message.delta: listener broke']);
  bus.dispose();
});

test('a report that throws again does not loop', () => {
  const bus = new Bus();
  let reports = 0;
  bus.onAny(() => {
    throw new Error('always');
  });
  bus.onError = (message) => {
    reports += 1;
    // A core reports through the bus itself, and the same listener throws on that too.
    bus.emit('core.log', { level: 'error', message, at: 0 });
  };
  bus.emit('core.log', { level: 'info', message: 'first', at: 0 });
  expect(reports).toBe(1);
  bus.dispose();
});

test('committed observers wait for the write while internal listeners remain synchronous', () => {
  const bus = new Bus();
  const internal: string[] = [], committed: string[] = [];
  bus.onAny((_, payload) => internal.push((payload as { message: string }).message));
  bus.onCommitted((_, payload) => committed.push((payload as { message: string }).message));
  const result = bus.afterCommit(() => {
    bus.emit('core.log', { level: 'info', message: 'first', at: 0 });
    expect(internal).toEqual(['first']);
    expect(committed).toEqual([]);
    bus.afterCommit(() => bus.emit('core.log', { level: 'info', message: 'second', at: 0 }));
    expect(committed).toEqual([]);
    return 42;
  });
  expect(result).toBe(42);
  expect(committed).toEqual(['first', 'second']);
  bus.dispose();
});

test('rollback discards nested notifications and new deltas, preserving earlier deltas', () => {
  const bus = new Bus();
  const committed: string[] = [];
  bus.onCommitted((name, payload) => committed.push(name === 'message.delta' ? (payload as { text: string }).text : name));
  const delta = { threadId: 't', messageId: 'm', partIndex: 0, text: 'before' };
  bus.emit('message.delta', delta);
  expect(() => bus.afterCommit(() => {
    bus.afterCommit(() => bus.emit('core.log', { level: 'info', message: 'nested', at: 0 }));
    bus.emit('message.delta', { ...delta, text: 'rolled back' });
    throw new Error('write failed');
  })).toThrow('write failed');
  bus.flush();
  expect(committed).toEqual(['before']);
  bus.afterCommit(() => {
    bus.emit('core.log', { level: 'info', message: 'outer', at: 0 });
    try {
      bus.afterCommit(() => {
        bus.emit('message.delta', { ...delta, text: 'nested failure' });
        throw new Error('nested failed');
      });
    } catch { /* The enclosing write can still commit. */ }
    bus.emit('message.delta', { ...delta, text: 'after' });
  });
  bus.flush();
  expect(committed).toEqual(['before', 'core.log', 'after']);
  bus.dispose();
});
