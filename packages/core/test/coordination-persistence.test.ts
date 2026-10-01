import { afterEach, expect, test } from 'bun:test';
import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, type CoreClient } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const fixtures: TestCore[] = [];
const reopened: { core: Core; server: RunningServer; owner: CoreClient }[] = [];
afterEach(async () => {
  for (const fixture of reopened.splice(0)) { fixture.owner.close(); await fixture.server.stop(); await fixture.core.close(); }
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

async function restart(fixture: TestCore) {
  const port = Number(new URL(fixture.url).port);
  await fixture.server.stop(); await fixture.core.close();
  const core = new Core({ dataDir: fixture.dataDir, token: fixture.token });
  const server = startServer({ core, host: '127.0.0.1', port });
  const owner = await connect(server.url, fixture.token);
  const restarted = { core, server, owner };
  reopened.push(restarted);
  return restarted;
}

test('mutual trust and directional read grants survive a test restart, with list read and send in both directions', async () => {
  const server = await startTestCore(), pc = await startTestCore(); fixtures.push(server, pc);
  const ownerA = await server.connect(), ownerB = await pc.connect();
  const a = (await echoThread(server, ownerA, 'Server diagnostic')).threadId;
  const b = (await echoThread(pc, ownerB, 'Client diagnostic')).threadId;
  const cardA = server.core.coordination.identity(), cardB = pc.core.coordination.identity();
  await ownerA.call('collaboration.trust', { peer: { ...cardB, readThreads: true } });
  await ownerB.call('collaboration.trust', { peer: { ...cardA, readThreads: true } });
  for (const [core, id, text] of [[server.core, a, 'server history'], [pc.core, b, 'client history']] as const) {
    core.journal.putMessage({ id: crypto.randomUUID(), threadId: id, turnId: 'history', role: 'user', state: 'complete', createdAt: Date.now(), parts: [{ type: 'text', text }] });
  }

  async function exchange(one: { core: Core; owner: CoreClient }, two: { core: Core; owner: CoreClient }, stage: string) {
    for (const [source, target, fromId, targetId, targetCard, history] of [
      [one, two, a, b, cardB, 'client history'], [two, one, b, a, cardA, 'server history'],
    ] as const) {
      expect((await source.owner.call('collaboration.directory', { threadId: fromId })).agents.some(agent => agent.coreId === targetCard.coreId && agent.threadId === targetId)).toBe(true);
      const read = await source.owner.call('collaboration.read', { threadId: fromId, target: { coreId: targetCard.coreId, threadId: targetId } });
      expect(read.entries.some(entry => entry.text === history)).toBe(true);
      const letter = await source.owner.call('collaboration.send', { threadId: fromId, to: { coreId: targetCard.coreId, threadId: targetId }, text: `${stage} delivery`, requestId: crypto.randomUUID() });
      await waitFor(() => source.core.coordination.get(fromId).messages.find(entry => entry.id === letter.id)?.status === 'delivered');
      expect(target.core.coordination.get(targetId).messages.filter(entry => entry.id === letter.id)).toHaveLength(1);
    }
  }
  await exchange({ core: server.core, owner: ownerA }, { core: pc.core, owner: ownerB }, 'before restart');
  ownerA.close(); ownerB.close();
  const one = await restart(server), two = await restart(pc);
  expect(one.core.coordination.identity().coreId).toBe(cardA.coreId);
  expect(two.core.coordination.identity().coreId).toBe(cardB.coreId);
  expect(await one.owner.call('collaboration.peers', {})).toMatchObject([{ coreId: cardB.coreId, readThreads: true }]);
  expect(await two.owner.call('collaboration.peers', {})).toMatchObject([{ coreId: cardA.coreId, readThreads: true }]);
  await exchange(one, two, 'after restart');

  // An owner can persist a directional revocation without changing the reverse grant.
  await two.owner.call('collaboration.trust', { peer: { ...cardA, readThreads: false } });
  await expect(one.owner.call('collaboration.read', { threadId: a, target: { coreId: cardB.coreId, threadId: b } })).rejects.toThrow('not allowed to read');
  expect((await two.owner.call('collaboration.read', { threadId: b, target: { coreId: cardA.coreId, threadId: a } })).entries.some(entry => entry.text === 'server history')).toBe(true);
}, 20000);

test('an unknown core cannot check, register a relay or submit an authenticated directory request', async () => {
  const server = await startTestCore(), unknown = await startTestCore(); fixtures.push(server, unknown);
  const owner = await server.connect();
  const sender = unknown.core.coordination.identity(), destination = server.core.coordination.identity();
  await expect(owner.call('collaboration.check', { coreId: sender.coreId })).rejects.toThrow('not trusted');
  await expect(owner.call('collaboration.bridge.register', { coreId: sender.coreId, enabled: true })).rejects.toThrow('trusted');
  const body = JSON.stringify({ from: sender.coreId, to: destination.coreId, at: Date.now(), nonce: crypto.randomUUID(), operation: 'directory', payload: {} });
  const signature = sign(null, Buffer.from(body), readFileSync(join(unknown.dataDir, 'coordination-key.pem'))).toString('base64');
  const response = await fetch(`${server.url}/agent-messages`, { method: 'POST', body, headers: { 'x-boite-peer': sender.coreId, 'x-boite-signature': signature } });
  expect(response.status).toBe(403);
  expect(await response.text()).toBe('unknown peer');
  expect(await owner.call('collaboration.peers', {})).toEqual([]);
});
