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

function env(host=harness, owner=client, slowBoard?: {queued: number}): ContractEnv {
  host.core.contacts.selfUrl=async()=>host.url;
  return {
    newContact:async()=>{
      const peer=await startTestCore();peers.push(peer);
      if(slowBoard){
        const request=peer.core.coordination.request.bind(peer.core.coordination);
        peer.core.coordination.request=async(target,operation,payload)=>{
          const p=payload as {method?:string};
          if(operation==='contact.project'&&p?.method==='board.apply')
            await new Promise(resolve=>setTimeout(resolve,200));
          return request(target,operation,payload);
        };
      }
      return env(peer,await peer.connect(),slowBoard);
    },
    call: (method, params) => owner.call(method, params).then(result=>{
      if(slowBoard&&method==='sharedBoard.apply'&&(result as {outcome?:string}).outcome==='queued')slowBoard.queued++;
      return result;
    }),
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
test('shared board contract awaits terminal receipts from a slow signed authority',async()=>{
  const slowBoard={queued:0};
  await SCENARIOS['shared projects, board receipts, human provenance and host-only protection agree across transports']!(env(harness,client,slowBoard));
  expect(slowBoard.queued).toBeGreaterThan(0);
});
