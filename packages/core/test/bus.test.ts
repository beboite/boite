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
