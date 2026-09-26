import { afterEach, expect, test, vi } from 'vitest';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

afterEach(() => {
  vi.restoreAllMocks();
});

test('the draft the boot lands on reuses the project list of the boot, and a draft the user opens asks again', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  const asked = vi.spyOn(client, 'call');
  store.attach(client);
  try {
    await store.connect();
    const lists = () => asked.mock.calls.filter(([method]) => method === 'projects.list').length;
    expect(lists()).toBe(1);

    await store.openLanding();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.draft).not.toBeNull();
    expect(lists()).toBe(1);

    // New thread pressed right away still asks, so a `git init` done meanwhile shows.
    store.startDraft();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lists()).toBe(2);
  } finally {
    store.detach();
    client.close();
  }
});
