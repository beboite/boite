import { afterEach, expect, test } from 'vitest';
import { KNOWN_DIVERGENCES, SCENARIOS, type ContractEnv } from '../../../../tests/contract/scenarios.ts';
import { FakeClient } from './fake-client';

/*
 * The shared contract scenarios against the in-memory client.
 * `packages/core/test/contract.test.ts` runs the same list against the real
 * core, so a rule the fake stops following fails here by name.
 */

const clients: FakeClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function env(): Promise<ContractEnv> {
  const client = new FakeClient({ delayMs: 0 });
  clients.push(client);
  await client.connect();
  let folders = 0;
  return {
    call: (method, params) => client.call(method, params),
    on: (event, handler) => client.on(event, handler),
    // The fake has no disk: any folder exists, except under one named `missing`.
    newFolder: async () => `C:\\Users\\you\\contract\\folder-${++folders}`,
    missingFolder: () => 'C:\\Users\\you\\missing\\folder',
    // Its core runs on Windows, where a path's case does not matter.
    otherCase: (path) => path.toUpperCase(),
  };
}

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  const divergence = KNOWN_DIVERGENCES[name];
  test(name, async () => {
    if (divergence?.side !== 'fake') {
      await scenario(await env());
      return;
    }
    // A listed drift that no longer fails has been fixed: take it off the list.
    await expect(scenario(await env())).rejects.toThrow();
  });
}
