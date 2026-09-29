import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreClient } from '../src/client.ts';
import { KNOWN_DIVERGENCES, SCENARIOS, type ContractEnv } from '../../../tests/contract/scenarios.ts';
import { startTestCore, type TestCore } from './harness.ts';

/*
 * The shared contract scenarios against the real core over WebSocket, with the
 * echo driver. `packages/ui/src/lib/fake-client.contract.test.ts` runs the same
 * list against the in-memory client. One core serves the whole file: every
 * scenario makes its own project, threads and accounts.
 */

let harness: TestCore;
let client: CoreClient;

beforeAll(async () => {
  harness = await startTestCore();
  client = await harness.connect();
});

afterAll(async () => {
  await harness.stop();
});

function env(): ContractEnv {
  return {
    call: (method, params) => client.call(method, params),
    on: (event, handler) => client.on(event, handler),
    newFolder: async () => mkdtempSync(join(harness.dataDir, 'project-')),
    missingFolder: () => join(harness.dataDir, 'missing', 'folder'),
    otherCase: (path) => (process.platform === 'win32' ? path.toUpperCase() : null),
  };
}

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  const divergence = KNOWN_DIVERGENCES[name];
  test(name, async () => {
    if (divergence?.side !== 'core') {
      await scenario(env());
      return;
    }
    // A listed drift that no longer fails has been fixed: take it off the list.
    await expect(scenario(env())).rejects.toThrow();
  });
}
