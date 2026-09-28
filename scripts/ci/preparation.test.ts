import { expect, test } from 'bun:test';
import { preparationStep } from '../../tests/e2e/lib/preparation.ts';

test('a stalled preparation step aborts and names the phase instead of hanging CI', async () => {
  let signal: AbortSignal | undefined;
  let failure: unknown;
  try {
    await preparationStep('optimized dependency', (current) => {
      signal = current;
      return new Promise(() => {});
    }, 20);
  } catch (error) {
    failure = error;
  }
  expect(signal?.aborted).toBe(true);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('optimized dependency');
  expect((failure as Error).message).toContain('20 ms');
});

test('a completed preparation step preserves its value and cancels its deadline', async () => {
  let signal: AbortSignal | undefined;
  expect(await preparationStep('complete', async (current) => {
    signal = current;
    return 42;
  }, 20)).toBe(42);
  await Bun.sleep(40);
  expect(signal?.aborted).toBe(false);
});

test('a failed preparation step preserves its cause and cancels its deadline', async () => {
  const cause = new Error('fixture build refused');
  let signal: AbortSignal | undefined;
  let failure: unknown;
  try {
    await preparationStep('fixture build', async (current) => {
      signal = current;
      throw cause;
    }, 20);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBe(cause);
  await Bun.sleep(40);
  expect(signal?.aborted).toBe(false);
});
