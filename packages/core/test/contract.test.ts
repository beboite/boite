import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreClient } from '../src/client.ts';
import { KNOWN_DIVERGENCES, SCENARIOS, type ContractEnv } from '../../../tests/contract/scenarios.ts';
import { startTestCore, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

/*
 * The shared contract scenarios against the real core over WebSocket, with the
 * echo driver. `packages/ui/src/lib/fake-client.contract.test.ts` runs the same
 * list against the in-memory client. One core serves the whole file: every
 * scenario makes its own project, threads and accounts.
 */

let harness: TestCore;
let client: CoreClient;
const peers:TestCore[]=[];

beforeAll(async () => {
  harness = await startTestCore();
  client = await harness.connect();
});

afterAll(async () => {
  for (const peer of peers.splice(0)) await peer.stop();
  await harness.stop();
});

function env(host=harness, owner=client): ContractEnv {
  host.core.contacts.selfUrl=async()=>host.url;
  return {
    newContact:async()=>{const peer=await startTestCore();peers.push(peer);return env(peer,await peer.connect());},
    call: (method, params) => owner.call(method, params),
    on: (event, handler) => owner.on(event, handler),
    newFolder: async () => mkdtempSync(join(host.dataDir, 'project-')),
    missingFolder: () => join(host.dataDir, 'missing', 'folder'),
    removeFolder: async (path) => rmSync(path, { recursive: true, force: true }),
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
    expect(await thrown(scenario(env()))).toThrow();
  });
}
