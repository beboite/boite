import { test as base, vi } from 'vitest';
import { FakeClient, type FakeClientOptions } from '../lib/fake-client';

export const test = base.extend<{
  createClient: (options: FakeClientOptions) => Promise<FakeClient>;
}>({
  createClient: async ({}, use) => {
    const clients: FakeClient[] = [];
    try {
      await use(async options => {
        const client = new FakeClient(options);
        clients.push(client);
        await client.connect();
        return client;
      });
    } finally {
      // Close before restoring the case's timer mode, including on assertion failure.
      try {
        for (const client of clients) client.close();
      } finally {
        vi.useRealTimers();
      }
    }
  }
});
