import { expect, test, vi } from 'vitest';
import { DisplayImages, KEPT_CHARS } from './store/display-images';
import type { StoreContext } from './store/context';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

test('originals of a few MB each stay within the character bound, the newest kept', async () => {
  const call = vi.fn(async () => ({ data: 'A'.repeat(1024 * 1024), mimeType: 'image/gif' }));
  const images = new DisplayImages({ client: { call } } as unknown as StoreContext);
  for (let index = 0; index < 30; index++) await images.load('t-1', `m-${index}`, 0, 'image/gif');
  expect(images.chars).toBeLessThanOrEqual(KEPT_CHARS);
  expect(images.chars).toBeGreaterThan(KEPT_CHARS - 2 * 1024 * 1024);
  await images.load('t-1', 'm-29', 0, 'image/gif');
  expect(call).toHaveBeenCalledTimes(30);
  await images.load('t-1', 'm-0', 0, 'image/gif');
  expect(call).toHaveBeenCalledTimes(31);
});

test('another machine never answers with a picture the previous one sent', async () => {
  const store = new Store();
  const clients = [new FakeClient({ delayMs: 0 }), new FakeClient({ delayMs: 0 })];
  try {
    for (const [index, client] of clients.entries()) {
      vi.spyOn(client, 'call').mockImplementation(async () => ({ data: `machine-${index}`, mimeType: 'image/webp' }) as never);
    }
    store.attach(clients[0]!);
    expect(await store.loadDisplayImage('t-1', 'm-1', 0, 'image/png')).toBe('data:image/webp;base64,machine-0');
    store.attach(clients[1]!);
    expect(await store.loadDisplayImage('t-1', 'm-1', 0, 'image/png')).toBe('data:image/webp;base64,machine-1');
  } finally {
    store.detach();
    for (const client of clients) client.close();
  }
});
