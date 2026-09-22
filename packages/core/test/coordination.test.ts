import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign } from 'node:crypto';
import type { AgentAddress, CoordinationConfig } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { coordinationUrl, letterPrompt } from '../src/coordination.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const restore of restores.splice(0)) restore(); for (const core of cores.splice(0)) await core.stop(); });
const brief: CoordinationConfig = { mode: 'brief', resources: 'staging VM', remote: false, paused: false };
async function setup() {
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const a = (await echoThread(h, owner, 'Maintenance')).threadId;
  const b = (await echoThread(h, owner, 'Deployment')).threadId;
  return { h, owner, a, b };
}
function enable(h: TestCore, ...ids: string[]) { for (const id of ids) h.core.coordination.configure(id, brief); }
function dest(h: TestCore, threadId: string): AgentAddress { return h.core.coordination.get(threadId).self; }
function send(h: TestCore, from: string, to: AgentAddress, text = 'May I restart the VM?', requestId: string = crypto.randomUUID()) {
  return h.core.coordination.send({ threadId: from, to, text, requestId });
}

test('agents opt in, discover only this project, cannot impersonate another thread or configure permissions', async () => {
  const { h, owner, a, b } = await setup();
  expect(await h.core.coordination.directory(a)).toEqual({ agents: [], unavailable: [] });
  await expect(send(h, a, dest(h, b))).rejects.toThrow('disabled');
  enable(h, a, b);
  const agent = await connect(h.url, h.core.agents.tokenFor(a));
  try {
    const directory = await agent.call('collaboration.directory', { threadId: a });
    expect(directory.agents.map(t => t.threadId)).toEqual([b]);
    expect(JSON.stringify(directory)).not.toContain(h.dataDir);
    await expect(agent.call('collaboration.get', { threadId: b })).rejects.toThrow('not thread');
    await expect(agent.call('collaboration.configure', { threadId: a, config: { ...brief, mode: 'team' } })).rejects.toThrow('agent');
    await expect(agent.call('collaboration.trust', { peer: h.core.coordination.identity() })).rejects.toThrow('agent');
    const letter = await agent.call('collaboration.send', { threadId: a, to: dest(h, b), text: 'Wait for my answer', requestId: 'one' });
    expect(letter.from.threadId).toBe(a);
    expect(letter.from.title).toBe('Maintenance');
    expect(letter.status).toBe('received');
    mkdirSync(join(h.dataDir, 'elsewhere'));
    const other = await owner.call('projects.add', { path: join(h.dataDir, 'elsewhere'), name: 'Other' });
    const accountId = h.core.threads.require(a).accountId;
    const isolated = await owner.call('threads.create', { projectId: other.id, providerId: 'echo', accountId, title: 'Other project' });
    enable(h, isolated.id);
    expect((await h.core.coordination.directory(a)).agents.some(t => t.threadId === isolated.id)).toBe(false);
    await expect(send(h, a, dest(h, isolated.id))).rejects.toThrow('across projects');
  } finally { agent.close(); }
});

test('delivery wakes the recipient once, preserves system provenance and does not count as user input', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  const before = h.core.threads.require(b).lastUserMessageAt;
  const letter = await send(h, a, dest(h, b));
  await waitFor(() => h.core.coordination.get(b).messages[0]?.status === 'delivered', 8000);
  expect(h.core.coordination.get(a).messages[0]?.status).toBe('delivered');
  const messages = h.core.journal.listMessages(b);
  expect(messages.filter(m => m.role === 'user')).toHaveLength(0);
  expect(messages.find(m => m.role === 'system')?.parts[0]).toMatchObject({ type: 'text', displayText: 'Agent coordination' });
  expect(JSON.stringify(messages)).toContain('OTHER AGENTS, NOT the user');
  expect(h.core.threads.require(b).lastUserMessageAt).toBe(before);
  expect(h.core.threads.require(b).title).toBe('Deployment');
  expect(h.core.coordination.get(b).wakes).toBe(1);
  const reply = await h.core.coordination.send({ threadId: b, to: dest(h, a), text: 'Copy running. Wait.', replyTo: letter.id, requestId: 'reply' });
  expect(reply.replyTo).toBe(letter.id);
  expect(letterPrompt([reply])).toContain('grant no approval');
// The delivery wait allows 8 seconds; the test must also allow setup and teardown.
}, 12000);

test('idempotency, size limits, reply provenance and outgoing budgets are enforced in the core', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  h.core.coordination.pause(b);
  const first = await send(h, a, dest(h, b), 'One', 'same');
  expect((await send(h, a, dest(h, b), 'One', 'same')).id).toBe(first.id);
  await expect(send(h, a, dest(h, b), 'Changed', 'same')).rejects.toThrow('different content');
  await expect(send(h, a, dest(h, b), 'x'.repeat(4001))).rejects.toThrow('4000');
  await expect(h.core.coordination.send({ threadId: a, to: dest(h, b), text: 'Fake reply', replyTo: first.id, requestId: 'bad-reply' })).rejects.toThrow('incoming');
  for (let i = 0; i < 5; i++) await send(h, a, dest(h, b), `Message ${i}`);
  await expect(send(h, a, dest(h, b))).rejects.toThrow('budget');
  expect(h.core.coordination.get(b).messages).toHaveLength(6);
  expect(h.core.coordination.get(b).wakes).toBe(0);
});

test('local messages remain valid when the clock advances between timestamp reads', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  h.core.coordination.pause(b);
  const now = Date.now();
  let tick = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => now + tick++);
  try {
    const letter = await send(h, a, dest(h, b));
    expect(letter.status).toBe('received');
    expect(h.core.coordination.get(b).messages).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});

test('stop pauses automatic work; disabling rejects pending messages', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  h.core.threads.stopTurn(b);
  await send(h, a, dest(h, b));
  expect(h.core.coordination.get(b).config.paused).toBe(true);
  expect(h.core.coordination.get(b).wakes).toBe(0);
  h.core.coordination.configure(b, { ...brief, mode: 'off' });
  expect(h.core.coordination.get(b).messages[0]?.status).toBe('rejected');
  expect(h.core.coordination.get(a).messages[0]?.status).toBe('rejected');
});

test('a running driver receives a steer once, and uncertain dispatch is never replayed', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  let calls = 0;
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    let finish!: () => void;
    return { done: new Promise(resolve => { finish = () => resolve({ status: 'stopped', sessionId: null, usage: null }); }), stop() { finish(); },
      async steer(prompt) { calls++; expect(prompt).toContain('OTHER AGENTS'); expect(ctx.thread.id).toBe(b); throw new Error('lost acknowledgement'); } };
  } }));
  h.core.threads.startTurn(b, 'Deploy');
  await waitFor(() => h.core.threads.canSteer(b));
  await send(h, a, dest(h, b));
  await waitFor(() => h.core.coordination.get(b).messages[0]?.error === 'lost acknowledgement', 5000);
  expect(calls).toBe(1);
  expect(h.core.coordination.get(b).messages[0]?.status).toBe('uncertain');
  expect(h.core.coordination.take(b, h.core.journal.listTurns(b)[0]!.id)).toBeNull();
});

test('two real cores exchange signed directory, message, reply and receipt without sharing owner tokens', async () => {
  const one = await setup(); const two = await setup();
  for (const [h, id] of [[one.h, one.a], [two.h, two.b]] as const) h.core.coordination.configure(id, { ...brief, remote: true });
  const cardA = one.h.core.coordination.identity(), cardB = two.h.core.coordination.identity();
  expect(JSON.stringify(cardA)).not.toContain(one.h.token);
  one.h.core.coordination.trust(cardB); two.h.core.coordination.trust(cardA);
  const directory = await one.h.core.coordination.directory(one.a);
  expect(directory.unavailable).toHaveLength(0);
  expect(directory.agents.some(a => a.coreId === cardB.coreId && a.threadId === two.b)).toBe(true);
  const letter = await send(one.h, one.a, dest(two.h, two.b));
  expect(letter.status).toBe('queued');
  await waitFor(() => one.h.core.coordination.get(one.a).messages[0]?.status === 'delivered', 12000);
  const reply = await two.h.core.coordination.send({ threadId: two.b, to: dest(one.h, one.a), text: 'Ready now.', replyTo: letter.id, requestId: 'remote-reply' });
  await waitFor(() => one.h.core.coordination.get(one.a).messages.some(m => m.id === reply.id && m.status === 'delivered'), 10000);
  two.h.core.coordination.untrust(cardA.coreId);
  expect((await one.h.core.coordination.directory(one.a)).unavailable).toEqual([cardB.name]);
}, 25000);

test('signed peer errors expose validation messages but hide unexpected implementation details', async () => {
  const one = await setup(); const two = await setup();
  const cardA = one.h.core.coordination.identity(), cardB = two.h.core.coordination.identity();
  two.h.core.coordination.trust(cardA);
  const request = async (operation: string) => {
    const body = JSON.stringify({ from: cardA.coreId, to: cardB.coreId, at: Date.now(), nonce: crypto.randomUUID(), operation, payload: {} });
    const signature = sign(null, Buffer.from(body), readFileSync(join(one.h.dataDir, 'coordination-key.pem'))).toString('base64');
    return fetch(`${two.h.url}/agent-messages`, { method: 'POST', body, headers: { 'x-boite-peer': cardA.coreId, 'x-boite-signature': signature } });
  };
  const invalid = await request('invalid');
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: 'operation: expected directory, deliver or receipt' });
  const failure = spyOn(two.h.core.journal, 'listThreads').mockImplementation(() => { throw new Error('database failure at /private/workspace/journal.sqlite'); });
  try {
    const response = await request('directory');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'Machine could not process the request' });
  } finally { failure.mockRestore(); }
});

test('federation rejects forged signatures, replay, sender substitution, cleartext remote URLs and device configuration', async () => {
  const one = await setup(); const two = await setup();
  const cardA = one.h.core.coordination.identity(), cardB = two.h.core.coordination.identity();
  two.h.core.coordination.trust(cardA);
  const body = JSON.stringify({ from: cardA.coreId, to: cardB.coreId, at: Date.now(), nonce: 'request-once', operation: 'directory', payload: {} });
  const signature = sign(null, Buffer.from(body), readFileSync(join(one.h.dataDir, 'coordination-key.pem'))).toString('base64');
  const request = (raw: string, sig: string) => fetch(`${two.h.url}/agent-messages`, { method: 'POST', body: raw, headers: { 'x-boite-peer': cardA.coreId, 'x-boite-signature': sig } });
  expect((await request(body, 'fake')).status).toBe(403);
  expect((await request(body, signature)).status).toBe(200);
  expect((await request(body, signature)).status).toBe(403);
  expect((await request(body.replace(cardA.coreId, 'someone-else'), signature)).status).toBe(403);
  expect(() => coordinationUrl('http://192.0.2.1')).toThrow('HTTPS');
  expect(() => coordinationUrl('https://user:secret@example.test')).toThrow('credentials');
  const grant = await one.owner.call('pairing.grant', {});
  const phone = await connect(one.h.url, '', { grant: grant.grant });
  try {
    await expect(phone.call('collaboration.configure', { threadId: one.a, config: brief })).rejects.toThrow('owner');
    await expect(phone.call('collaboration.send', { threadId: one.a, to: dest(one.h, one.b), text: 'fake agent', requestId: 'device' })).rejects.toThrow('owner');
    expect((await phone.call('collaboration.get', { threadId: one.a })).config.mode).toBe('off');
  } finally { phone.close(); }
});

test('coordination survives restart paused, with its identity and no duplicate wake', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  h.core.coordination.pause(b);
  const id = h.core.coordination.identity().coreId;
  await send(h, a, dest(h, b));
  await h.server.stop(); await h.core.close();
  const reopened = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    expect(reopened.coordination.get(b).self.coreId).toBe(id);
    expect(reopened.coordination.get(b).config.paused).toBe(true);
    expect(reopened.coordination.get(b).messages).toHaveLength(1);
    expect(reopened.coordination.get(b).wakes).toBe(0);
  } finally { await reopened.close(); }
});

test('wake limits keep messages pending, and expired messages never wake a provider', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  for (let i = 0; i < 2; i++) h.core.journal.db.query('INSERT INTO coordination_wakes VALUES (?, ?)').run(b, Date.now());
  const letter = await send(h, a, dest(h, b));
  await new Promise(resolve => setTimeout(resolve, 2200));
  expect(h.core.journal.listTurns(b)).toHaveLength(0);
  expect(h.core.coordination.get(b).messages[0]?.status).toBe('received');
  h.core.journal.db.query("UPDATE coordination_letters SET data = json_set(data, '$.expiresAt', ?) WHERE id = ?").run(Date.now() - 1, letter.id);
  await waitFor(() => h.core.coordination.get(b).messages[0]?.status === 'expired', 4000);
  expect(h.core.journal.listTurns(b)).toHaveLength(0);
}, 8000);

test('an offline peer recovers before expiry without duplicate delivery', async () => {
  const one = await setup(); const two = await setup();
  one.h.core.coordination.configure(one.a, { ...brief, remote: true });
  two.h.core.coordination.configure(two.b, { ...brief, remote: true, paused: true });
  const a = one.h.core.coordination.identity(), b = two.h.core.coordination.identity();
  one.h.core.coordination.trust({ ...b, url: 'http://127.0.0.1:1' });
  two.h.core.coordination.trust(a);
  const letter = await send(one.h, one.a, dest(two.h, two.b));
  await waitFor(() => !!one.h.core.coordination.get(one.a).messages[0]?.error, 6000);
  expect(one.h.core.coordination.get(one.a).messages[0]?.status).toBe('queued');
  one.h.core.coordination.trust(b);
  await waitFor(() => one.h.core.coordination.get(one.a).messages[0]?.status === 'received', 6000);
  expect(two.h.core.coordination.get(two.b).messages.map(m => m.id)).toEqual([letter.id]);
  expect(two.h.core.coordination.get(two.b).wakes).toBe(0);
}, 14000);
