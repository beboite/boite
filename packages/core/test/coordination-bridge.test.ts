import { afterEach, expect, test } from 'bun:test';
import type { CoordinationBridgeResponse } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
afterEach(async () => { for (const core of cores.splice(0)) await core.stop(); });

test('an owner app carries signed list read and send in both directions without published addresses, and disconnect revokes the route', async () => {
  const server = await startTestCore(); const pc = await startTestCore(); cores.push(server, pc);
  const ownerA = await server.connect(), ownerB = await pc.connect();
  const a = (await echoThread(server, ownerA, 'Server task')).threadId;
  const b = (await echoThread(pc, ownerB, 'Client migration')).threadId;
  const cardA = server.core.coordination.identity(), cardB = pc.core.coordination.identity();
  server.core.coordination.trust({ ...cardB, url: 'http://127.0.0.1:1', viaClient: true, readThreads: true });
  pc.core.coordination.trust({ ...cardA, url: 'http://127.0.0.1:1', viaClient: true, readThreads: true });
  server.core.journal.putMessage({ id: 'server-message', threadId: a, turnId: 'history', role: 'assistant', state: 'complete', createdAt: Date.now(), parts: [{ type: 'text', text: 'Checking the destination' }] });
  pc.core.journal.putMessage({ id: 'client-message', threadId: b, turnId: 'history', role: 'assistant', state: 'complete', createdAt: Date.now(), parts: [{ type: 'text', text: 'Copying the guest filesystem' }] });
  const address = { coreId: cardB.coreId, threadId: b };
  await expect(server.core.coordination.read(a, address)).rejects.toThrow('did not answer');
  const forwarding: Promise<unknown>[] = [];
  ownerA.on('collaboration.bridge.request', request => {
    forwarding.push(ownerB.call('collaboration.bridge.forward', { coreId: request.fromCoreId, body: request.body, signature: request.signature })
      .then(response => ownerA.call('collaboration.bridge.reply', { requestId: request.requestId, response })));
  });
  ownerB.on('collaboration.bridge.request', request => {
    forwarding.push(ownerA.call('collaboration.bridge.forward', { coreId: request.fromCoreId, body: request.body, signature: request.signature })
      .then(response => ownerB.call('collaboration.bridge.reply', { requestId: request.requestId, response })));
  });
  await ownerA.call('collaboration.bridge.register', { coreId: cardB.coreId, enabled: true });
  await ownerB.call('collaboration.bridge.register', { coreId: cardA.coreId, enabled: true });
  expect((await server.core.coordination.read(a, address)).entries[0]?.text).toBe('Copying the guest filesystem');
  expect((await pc.core.coordination.read(b, { coreId: cardA.coreId, threadId: a })).entries[0]?.text).toBe('Checking the destination');
  expect((await server.core.coordination.directory(a)).agents.some(agent => agent.coreId === cardB.coreId && agent.threadId === b)).toBe(true);
  expect((await pc.core.coordination.directory(b)).agents.some(agent => agent.coreId === cardA.coreId && agent.threadId === a)).toBe(true);
  for (const [source, target, fromId, to] of [[server, pc, a, address], [pc, server, b, { coreId: cardA.coreId, threadId: a }]] as const) {
    const letter = await source.core.coordination.send({ threadId: fromId, to, text: 'Bridge diagnostic', requestId: crypto.randomUUID() });
    await waitFor(() => source.core.coordination.get(fromId).messages.find(entry => entry.id === letter.id)?.status === 'delivered');
    expect(target.core.coordination.get(to.threadId).messages.filter(entry => entry.id === letter.id)).toHaveLength(1);
  }
  await Promise.all(forwarding);
  const agent = await connect(server.url, server.core.agents.tokenFor(a));
  try {
    await expect(agent.call('collaboration.bridge.register', { coreId: cardB.coreId, enabled: true })).rejects.toThrow('agent');
    await expect(agent.call('collaboration.bridge.forward', { coreId: cardA.coreId, body: '{}', signature: '' })).rejects.toThrow('agent');
  } finally { agent.close(); }
  ownerA.close();
  // The websocket close is delivered before the next turn of the event loop.
  await new Promise(resolve => setTimeout(resolve, 30));
  await expect(server.core.coordination.read(a, address)).rejects.toThrow('did not answer');
}, 15000);

test('another owner connection cannot supply a bridge response, and a forged signature is rejected', async () => {
  const server = await startTestCore(); const pc = await startTestCore(); cores.push(server, pc);
  const owner = await server.connect(), other = await server.connect(), destination = await pc.connect();
  const a = (await echoThread(server, owner)).threadId, b = (await echoThread(pc, destination)).threadId;
  const cardA = server.core.coordination.identity(), cardB = pc.core.coordination.identity();
  server.core.coordination.trust({ ...cardB, viaClient: true }); pc.core.coordination.trust({ ...cardA, readThreads: true });
  const response: CoordinationBridgeResponse = { status: 200, body: '{}', signature: 'forged' };
  let refused = false;
  const answering: Promise<unknown>[] = [];
  owner.on('collaboration.bridge.request', request => {
    answering.push((async () => {
      try { await other.call('collaboration.bridge.reply', { requestId: request.requestId, response }); } catch { refused = true; }
      await owner.call('collaboration.bridge.reply', { requestId: request.requestId, response });
    })());
  });
  await owner.call('collaboration.bridge.register', { coreId: cardB.coreId, enabled: true });
  await expect(server.core.coordination.check(cardB.coreId)).rejects.toThrow('could not verify');
  await Promise.all(answering);
  expect(refused).toBe(true);
});
