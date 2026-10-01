import { afterEach, expect, test } from 'bun:test';
import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
afterEach(async () => { for (const core of cores.splice(0)) await core.stop(); });

test('the destination owner grants conversation reads per machine without exposing chat through search', async () => {
  const server = await startTestCore(); const pc = await startTestCore(); cores.push(server, pc);
  const a = (await echoThread(server, await server.connect(), 'Server task')).threadId;
  const b = (await echoThread(pc, await pc.connect(), 'Client migration')).threadId;
  const cardA = server.core.coordination.identity(), cardB = pc.core.coordination.identity();
  server.core.coordination.trust(cardB); pc.core.coordination.trust(cardA);
  pc.core.journal.putMessage({ id: 'private-message', threadId: b, turnId: 'history', role: 'user', state: 'complete', createdAt: Date.now(), parts: [{ type: 'text', text: 'private backup details' }] });
  const address = { coreId: cardB.coreId, threadId: b };
  expect((await server.core.coordination.directory(a)).agents.some(t => t.threadId === b)).toBe(true);
  expect((await server.core.coordination.search(a, 'private backup')).matches).toEqual([]);
  expect((await server.core.coordination.search(a, 'client migration')).matches[0]?.excerpts).toEqual([]);
  await expect(server.core.coordination.read(a, address)).rejects.toThrow('not allowed to read');
  pc.core.coordination.trust({ ...cardA, readThreads: true });
  expect((await server.core.coordination.search(a, 'private backup')).matches[0]?.matched).toContain('chat');
  expect((await server.core.coordination.read(a, address)).entries[0]?.text).toBe('private backup details');
  // An identity refresh and an app reconnect must preserve the owner's grant.
  pc.core.coordination.trust(cardA);
  expect(pc.core.coordination.peers()[0]?.readThreads).toBe(true);
  // Permission is directional: the client cannot read the server's conversations.
  await expect(pc.core.coordination.read(b, { coreId: cardA.coreId, threadId: a })).rejects.toThrow('not allowed to read');
  pc.core.coordination.trust({ ...cardA, readThreads: false });
  expect((await server.core.coordination.search(a, 'private backup')).matches).toEqual([]);
  await expect(server.core.coordination.read(a, address)).rejects.toThrow('not allowed to read');
  pc.core.coordination.untrust(cardA.coreId);
  pc.core.coordination.trust(cardA);
  expect(pc.core.coordination.peers()[0]?.readThreads).toBe(false);
});

test('revoking reads while a signed request body streams prevents disclosure', async () => {
  const server = await startTestCore(), pc = await startTestCore(); cores.push(server, pc);
  const b = (await echoThread(pc, await pc.connect())).threadId;
  const cardA = server.core.coordination.identity(), cardB = pc.core.coordination.identity();
  pc.core.coordination.trust({ ...cardA, readThreads: true });
  const body = JSON.stringify({ from: cardA.coreId, to: cardB.coreId, at: Date.now(), nonce: crypto.randomUUID(), operation: 'read', payload: { threadId: b } });
  const signature = sign(null, Buffer.from(body), readFileSync(join(server.dataDir, 'coordination-key.pem'))).toString('base64');
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const response = pc.core.coordination.http(new Request(`${pc.url}/agent-messages`, {
    method: 'POST', body: stream, headers: { 'x-boite-peer': cardA.coreId, 'x-boite-signature': signature },
  }));
  controller.enqueue(new TextEncoder().encode(body.slice(0, 10)));
  pc.core.coordination.trust({ ...cardA, readThreads: false });
  controller.enqueue(new TextEncoder().encode(body.slice(10))); controller.close();
  const denied = await response;
  expect(denied.status).toBe(400);
  expect(await denied.json()).toMatchObject({ error: expect.stringContaining('not allowed to read') });
});
