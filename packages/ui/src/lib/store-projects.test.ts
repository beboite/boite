import { afterEach, expect, test, vi } from 'vitest';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

afterEach(() => {
  vi.restoreAllMocks();
});

test('a draft opened right after the boot reuses the project list the boot fetched', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  const asked = vi.spyOn(client, 'call');
  store.attach(client);
  try {
    await store.connect();
    const lists = () => asked.mock.calls.filter(([method]) => method === 'projects.list').length;
    expect(lists()).toBe(1);

    store.startDraft();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lists()).toBe(1);

    // A draft opened later asks again, so a `git init` done meanwhile shows.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6_000);
    store.startDraft();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lists()).toBe(2);
  } finally {
    store.detach();
    client.close();
  }
});
