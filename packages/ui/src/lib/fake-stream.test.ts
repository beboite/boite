import { afterEach, expect, test } from 'vitest';
import { FakeClient } from './fake-client';

/**
 * The fake streams an answer in five deltas by default, which hides any cost
 * paid per delta. `chunkSize` (or `?fake=1&stream=tokens`) streams it the way
 * the core's echo driver does, sixteen characters at a time.
 */

afterEach(() => window.history.replaceState(null, '', '/'));

async function deltas(client: FakeClient, prompt: string): Promise<string[]> {
  await client.connect();
  try {
    await client.call('threads.subscribe', { threadId: 't-trace' });
    const seen: string[] = [];
    client.on('message.delta', (event) => seen.push(event.text));
    await client.call('turns.start', { threadId: 't-trace', prompt });
    await client.settled();
    return seen;
  } finally {
    client.close();
  }
}

test('a chunk size streams the reasoning and the answer at token rate', async () => {
  const prompt = 'x'.repeat(800);
  const seen = await deltas(new FakeClient({ delayMs: 0, chunkSize: 16 }), prompt);
  expect(seen.every((text) => text.length <= 16)).toBe(true);
  // 800 characters of answer and as many of reasoning, sixteen at a time.
  expect(seen.length).toBeGreaterThanOrEqual(100);
  expect(seen.join('')).toContain(prompt);
});

test('stream=tokens in the address picks the same rate, and the default stays five deltas', async () => {
  const prompt = 'y'.repeat(800);
  expect((await deltas(new FakeClient({ delayMs: 0 }), prompt)).length).toBeLessThan(10);
  window.history.replaceState(null, '', '/?fake=1&stream=tokens');
  expect((await deltas(new FakeClient({ delayMs: 0 }), prompt)).length).toBeGreaterThanOrEqual(100);
});
