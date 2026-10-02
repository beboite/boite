import { test as base, vi } from 'vitest';
import { FakeClient, type FakeClientOptions } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';

interface TestStore { store: Store; client: FakeClient }

export const test = base.extend<{
  createClient: (options: FakeClientOptions) => Promise<FakeClient>;
  createStore: (options?: FakeClientOptions) => TestStore;
  ready: (options?: FakeClientOptions) => Promise<TestStore>;
  seeded: TestStore;
  store: Store;
  client: FakeClient;
  resources: (() => void)[];
}>({
  resources: async ({}, use) => {
    const disposers: (() => void)[] = [];
    try {
      await use(disposers);
    } finally {
      // Reverse ownership order detaches a Store before closing its client.
      const errors: unknown[] = [];
      for (const dispose of disposers.reverse()) {
        try { dispose(); } catch (error) { errors.push(error); }
      }
      vi.useRealTimers();
      if (errors.length) throw new AggregateError(errors, 'Test resources failed to close');
    }
  },
  createClient: async ({ resources }, use) => {
    await use(async options => {
      const client = new FakeClient(options);
      resources.push(() => client.close());
      await client.connect();
      return client;
    });
  },
  createStore: async ({ resources }, use) => {
    await use((options = { delayMs: 0 }) => {
      const client = new FakeClient(options);
      resources.push(() => client.close());
      const store = new Store();
      resources.push(() => store.detach());
      return { store, client };
    });
  },
  ready: async ({ createStore }, use) => {
    await use(async options => {
      const owned = createStore(options);
      owned.store.attach(owned.client);
      await owned.store.connect();
      return owned;
    });
  },
  seeded: async ({ ready }, use) => {
    await use(await ready());
  },
  store: async ({ seeded }, use) => {
    await use(seeded.store);
  },
  client: async ({ seeded }, use) => {
    await use(seeded.client);
  },
});
