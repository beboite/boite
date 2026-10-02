import { afterEach, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentContact, CoordinationPeer } from '@boite/contracts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
afterEach(async () => { for (const core of cores.splice(0)) await core.stop(); });

type Lookup = 'directory' | 'search' | 'read';

/** Signed synthetic replies stay deferred at the transport, with no external machine or transcript. */
function deferredPeer(name: string) {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const card: CoordinationPeer = { coreId: createHash('sha256').update(publicKey).digest('hex'), name, url: 'http://127.0.0.1:1', publicKey, viaClient: true };
  const contact: AgentContact = { coreId: card.coreId, threadId: `synthetic-${name}`, title: 'Synthetic transcript', machine: name, resources: '', status: 'idle', mode: 'brief' };
  const started = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  return { card, contact, started, released, async answer(body: string) {
    const request = JSON.parse(body) as { nonce: string; operation: Lookup };
    started.resolve();
    await released.promise;
    const result = request.operation === 'directory' ? [contact] : request.operation === 'search'
      ? [{ ...contact, matched: ['chat'], excerpts: ['synthetic test data'] }]
      : { contact, entries: [{ id: 'synthetic-entry', role: 'user', at: 1, text: 'synthetic test data', tools: [] }], more: false };
    const response = JSON.stringify({ nonce: request.nonce, result });
    return { status: 200, body: response, signature: sign(null, Buffer.from(response), pair.privateKey).toString('base64') };
  } };
}

function useDeferredPeers(source: TestCore, peers: ReturnType<typeof deferredPeer>[]): void {
  for (const peer of peers) source.core.coordination.trust(peer.card);
  source.core.coordination.bridge.request = (coreId, envelope) => {
    const peer = peers.find(candidate => candidate.card.coreId === coreId);
    if (!peer) throw new Error('unexpected synthetic peer');
    return peer.answer(envelope.body);
  };
}

function lookup(source: TestCore, threadId: string, operation: Lookup, peer: ReturnType<typeof deferredPeer>) {
  const coordination = source.core.coordination;
  return operation === 'directory' ? coordination.directory(threadId) : operation === 'search'
    ? coordination.search(threadId, 'synthetic') : coordination.read(threadId, peer.contact);
}

const revocationCases = (['directory', 'search', 'read'] as const).flatMap(operation =>
  (operation === 'directory' ? ['archived', 'removed'] as const : ['remote disabled', 'mode off', 'archived', 'removed'] as const)
    .map(change => ({ operation, change })));

test.each(revocationCases)('$operation withholds a deferred reply when the source is $change', async ({ operation, change }) => {
  const source = await startTestCore(); cores.push(source);
  const { threadId } = await echoThread(source, await source.connect());
  const peer = deferredPeer('remote'); useDeferredPeers(source, [peer]);
  const pending = lookup(source, threadId, operation, peer).then(value => ({ value, error: null }), error => ({ value: null, error }));
  await peer.started.promise;
  const config = source.core.coordination.config(threadId);
  if (change === 'remote disabled') source.core.coordination.configure(threadId, { ...config, remote: false });
  else if (change === 'mode off') source.core.coordination.configure(threadId, { ...config, mode: 'off' });
  else if (change === 'archived') source.core.threads.archive(threadId, true);
  else await source.core.threads.remove(threadId);
  peer.released.resolve();
  const outcome = await pending;
  expect(outcome.value).toBeNull();
  expect(outcome.error).toBeInstanceOf(Error);
  expect(outcome.error.message).toContain(change === 'removed' ? `unknown thread ${threadId}` : 'coordination permissions changed');
});

test.each(['directory', 'search'] as const)('%s drops revoked local contacts and an answered peer while another peer is pending', async operation => {
  const source = await startTestCore(); cores.push(source);
  const owner = await source.connect();
  const { threadId } = await echoThread(source, owner);
  const locals = [];
  for (const state of ['archived', 'off', 'active']) {
    const local = (await echoThread(source, owner, `Local ${state}`)).threadId;
    source.core.journal.putMessage({ id: `synthetic-${state}`, threadId: local, turnId: 'history', role: 'user', state: 'complete', createdAt: 1, parts: [{ type: 'text', text: `synthetic local test data for ${state}` }] });
    locals.push(local);
  }
  const [archived, off, active] = locals;
  const first = deferredPeer('first'), second = deferredPeer('second'); useDeferredPeers(source, [first, second]);
  const pending = lookup(source, threadId, operation, first);
  await Promise.all([first.started.promise, second.started.promise]);
  first.released.resolve();
  // Finish the first reply's queued continuations while the other transport stays held.
  await new Promise<void>(resolve => setImmediate(resolve));
  source.core.coordination.untrust(first.card.coreId);
  source.core.threads.archive(archived!, true);
  source.core.coordination.configure(off!, { ...source.core.coordination.config(off!), mode: 'off' });
  second.released.resolve();
  const outcome = await pending;
  const contacts = 'agents' in outcome ? outcome.agents : 'matches' in outcome ? outcome.matches : [];
  expect(contacts.map(contact => contact.threadId).sort()).toEqual([active!, second.contact.threadId].sort());
  if ('matches' in outcome) expect(outcome.matches.find(match => match.threadId === active)?.excerpts).toEqual(['synthetic local test data for active']);
  expect('unavailable' in outcome && outcome.unavailable).toEqual([first.card.name]);
});

test.each(['search', 'read'] as const)('%s withholds a deferred reply from a revoked peer', async operation => {
  const source = await startTestCore(); cores.push(source);
  const { threadId } = await echoThread(source, await source.connect());
  const peer = deferredPeer('remote'); useDeferredPeers(source, [peer]);
  const pending = lookup(source, threadId, operation, peer).then(value => ({ value, error: null }), error => ({ value: null, error }));
  await peer.started.promise;
  source.core.coordination.untrust(peer.card.coreId);
  peer.released.resolve();
  const outcome = await pending;
  if (operation === 'search') expect(outcome.value).toEqual({ matches: [], unavailable: [peer.card.name] });
  else {
    expect(outcome.value).toBeNull();
    expect(outcome.error?.message).toContain('machine permission revoked');
  }
});

test('pausing delivery and editing resources preserves pending lookups that remain authorized', async () => {
  const source = await startTestCore(); cores.push(source);
  const { threadId } = await echoThread(source, await source.connect());
  const peer = deferredPeer('remote'); useDeferredPeers(source, [peer]);
  const pending = Promise.all((['directory', 'search', 'read'] as const).map(operation => lookup(source, threadId, operation, peer)));
  await peer.started.promise;
  source.core.coordination.configure(threadId, { ...source.core.coordination.config(threadId), paused: true, resources: 'updated resources' });
  peer.released.resolve();
  const [directory, search, read] = await pending;
  expect(directory).toMatchObject({ agents: [peer.contact], unavailable: [] });
  expect(search).toMatchObject({ matches: [{ coreId: peer.card.coreId }], unavailable: [] });
  expect(read).toMatchObject({ contact: peer.contact, entries: [{ text: 'synthetic test data' }] });
});

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
