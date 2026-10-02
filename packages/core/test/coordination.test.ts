import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign } from 'node:crypto';
import { RpcErrorCode, type AgentAddress, type CoordinationConfig } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { Coordination, coordinationUrl, LETTER_RETENTION_MS, letterPrompt, SWEEP_PROBES } from '../src/coordination.ts';
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

test('agents communicate by default, respect explicit restrictions and cannot change permissions', async () => {
  const { h, owner, a, b } = await setup();
  expect(h.core.coordination.get(a).config).toEqual({ mode: 'brief', resources: '', remote: true, paused: false });
  expect((await h.core.coordination.directory(a)).agents.map(t => t.threadId)).toEqual([b]);
  h.core.coordination.configure(a, { ...brief, mode: 'off' });
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
    const project = h.core.journal.getProject(h.core.threads.require(a).projectId!)!;
    expect(directory.agents[0]?.project).toBe(project.name);
    expect(letter.from.project).toBe(project.name);
    expect(letter.toProject).toBe(project.name);
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

test('default discovery excludes archived threads and persistent agent sessions', async () => {
  const { h, owner, a, b } = await setup();
  h.core.threads.archive(b, true);
  const resident = (await echoThread(h, owner, 'Persistent session')).threadId;
  h.core.journal.putThread({ ...h.core.threads.require(resident), projectId: null, agentSessionId: 'resident-test' });
  expect((await h.core.coordination.directory(a)).agents).toEqual([]);
  expect(h.core.coordination.get(resident).config.mode).toBe('off');
  await expect(send(h, a, dest(h, resident))).rejects.toThrow('across projects');
  await expect(send(h, resident, dest(h, a))).rejects.toThrow('disabled');
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

test('idempotency, size limits and reply provenance are enforced in the core, with no hourly budget', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  h.core.coordination.pause(b);
  const first = await send(h, a, dest(h, b), 'One', 'same');
  expect((await send(h, a, dest(h, b), 'One', 'same')).id).toBe(first.id);
  await expect(send(h, a, dest(h, b), 'Changed', 'same')).rejects.toThrow('different content');
  await expect(send(h, a, dest(h, b), 'x'.repeat(4001))).rejects.toThrow('4000');
  await expect(h.core.coordination.send({ threadId: a, to: dest(h, b), text: 'Fake reply', replyTo: first.id, requestId: 'bad-reply' })).rejects.toThrow('incoming');
  // More than the old Brief budgets allowed (6 sent, 20 received an hour).
  for (let i = 0; i < 24; i++) await send(h, a, dest(h, b), `Message ${i}`);
  expect(h.core.coordination.get(b).messages).toHaveLength(25);
  expect(h.core.coordination.get(a)).toMatchObject({ sent: 25, sendLimit: null, wakeLimit: null });
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
  const cardA = one.h.core.coordination.identity(), cardB = two.h.core.coordination.identity();
  expect(JSON.stringify(cardA)).not.toContain(one.h.token);
  await expect(send(one.h, one.a, dest(two.h, two.b))).rejects.toThrow('not trusted');
  one.h.core.coordination.trust(cardB); two.h.core.coordination.trust(cardA);
  const directory = await one.h.core.coordination.directory(one.a);
  expect(directory.unavailable).toHaveLength(0);
  const remoteProject = two.h.core.journal.getProject(two.h.core.threads.require(two.b).projectId!)!.name;
  expect(directory.agents.find(a => a.coreId === cardB.coreId && a.threadId === two.b)?.project).toBe(remoteProject);
  const letter = await send(one.h, one.a, dest(two.h, two.b));
  expect(letter.status).toBe('queued');
  await waitFor(() => one.h.core.coordination.get(one.a).messages[0]?.status === 'delivered', 12000);
  expect(one.h.core.coordination.get(one.a).messages[0]?.toProject).toBe(remoteProject);
  expect(one.h.core.coordination.get(one.a).messages[0]?.toMachine).toBe(cardB.name);
  expect(two.h.core.coordination.get(two.b).messages[0]?.from.project).toBe(one.h.core.journal.getProject(one.h.core.threads.require(one.a).projectId!)!.name);
  const reply = await two.h.core.coordination.send({ threadId: two.b, to: dest(one.h, one.a), text: 'Ready now.', replyTo: letter.id, requestId: 'remote-reply' });
  await waitFor(() => one.h.core.coordination.get(one.a).messages.some(m => m.id === reply.id && m.status === 'delivered'), 10000);
  two.h.core.coordination.untrust(cardA.coreId);
  expect((await one.h.core.coordination.directory(one.a)).unavailable).toEqual([cardB.name]);
}, 25000);

test('an unreachable coordination check names the destination without broadcasting an internal error', async () => {
  const one = await setup(); const two = await setup();
  const peer = { ...two.h.core.coordination.identity(), name: 'Remote test machine', url: 'http://127.0.0.1:1' };
  one.h.core.coordination.trust(peer);
  const log = spyOn(one.h.core, 'log');
  try {
    await expect(one.owner.call('collaboration.check', { coreId: peer.coreId })).rejects.toMatchObject({
      rpc: {
        code: RpcErrorCode.Unavailable,
        message: expect.stringContaining('Remote test machine at http://127.0.0.1:1'),
      },
    });
    expect(log.mock.calls.some(([level]) => level === 'error')).toBe(false);
  } finally { log.mockRestore(); }
});

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
  expect(await invalid.json()).toMatchObject({ error: 'operation: expected directory, deliver, receipt, search or read' });
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
    expect((await phone.call('collaboration.get', { threadId: one.a })).config.mode).toBe('brief');
  } finally { phone.close(); }
});

test('restart pauses pending work while existing idle threads stay reachable and explicit opt-outs survive', async () => {
  const { h, owner, a, b } = await setup(); enable(h, a, b);
  h.core.coordination.pause(b);
  const c = (await echoThread(h, owner, 'Existing idle sender')).threadId;
  const d = (await echoThread(h, owner, 'Disabled')).threadId;
  const e = (await echoThread(h, owner, 'Existing idle recipient')).threadId;
  h.core.coordination.configure(d, { ...brief, mode: 'off' });
  h.core.coordination.configure(e, { ...brief, remote: true });
  const id = h.core.coordination.identity().coreId;
  const letterBeforeRestart = await send(h, a, dest(h, b));
  const recovering = [];
  for (const status of ['queued', 'running', 'waiting'] as const) {
    const threadId = (await echoThread(h, owner, `Interrupted ${status}`)).threadId;
    h.core.journal.putThread({ ...h.core.threads.require(threadId), status });
    recovering.push(threadId);
  }
  const archived = (await echoThread(h, owner, 'Archived interrupted')).threadId;
  h.core.journal.putThread({ ...h.core.threads.require(archived), status: 'waiting', archived: true });
  const resident = (await echoThread(h, owner, 'Persistent identity')).threadId;
  h.core.journal.putThread({ ...h.core.threads.require(resident), status: 'waiting', agentSessionId: 'restart-resident' });
  const deleted = (await echoThread(h, owner, 'Deleted interrupted')).threadId;
  h.core.journal.putThread({ ...h.core.threads.require(deleted), status: 'waiting' });
  h.core.journal.db.query('INSERT INTO thread_deletions (thread_id, root_id, archived, deleted_at) VALUES (?, ?, ?, ?)').run(deleted, deleted, 0, Date.now());
  const pending = [];
  for (const status of ['queued', 'uncertain'] as const) {
    const threadId = (await echoThread(h, owner, `Pending ${status}`)).threadId;
    h.core.coordination.pause(threadId);
    const letter = await send(h, a, dest(h, threadId));
    h.core.journal.db.query("UPDATE coordination_letters SET status = ?, data = json_set(data, '$.status', ?, '$.error', ?) WHERE id = ?")
      .run(status, status, status === 'uncertain' ? 'Queued for provider delivery' : null, letter.id);
    pending.push({ threadId, letterId: letter.id, status });
  }
  for (let i = 0; i < 32; i++) await echoThread(h, owner, `Unrelated idle ${i}`);
  const deep = '['.repeat(1100) + '0' + ']'.repeat(1100);
  const deepConfig = JSON.stringify(brief).slice(0, -1) + ',"extension":' + deep + '}';
  h.core.journal.db.query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`coordination:${a}`, deepConfig);
  await h.server.stop(); await h.core.close();
  const configReads = spyOn(Coordination.prototype, 'config');
  restores.push(() => configReads.mockRestore());
  const reopened = new Core({ dataDir: h.dataDir, token: h.token });
  const restartConfigIds = configReads.mock.calls.map(([threadId]) => threadId);
  configReads.mockRestore();
  try {
    expect(restartConfigIds).toEqual([a, b, ...recovering, archived, resident, ...pending.map(item => item.threadId)]);
    expect(reopened.coordination.config(archived).paused).toBe(true);
    expect(reopened.coordination.config(resident)).toEqual({ mode: 'off', resources: '', remote: false, paused: false });
    expect(reopened.journal.getSetting(`coordination:${deleted}`)).toBeUndefined();
    for (const item of pending) {
      expect(reopened.coordination.get(item.threadId).config.paused).toBe(true);
      expect(reopened.coordination.get(item.threadId).messages).toContainEqual(expect.objectContaining({ id: item.letterId, status: item.status }));
      expect(reopened.coordination.get(item.threadId).wakes).toBe(0);
    }
    for (const threadId of recovering) {
      expect(reopened.coordination.get(threadId).config.paused).toBe(true);
      expect(reopened.coordination.get(threadId).wakes).toBe(0);
    }
    expect(reopened.coordination.get(b).messages[0]?.id).toBe(letterBeforeRestart.id);
    expect(reopened.coordination.get(b).messages[0]?.status).toBe('received');
    expect(reopened.coordination.get(b).self.coreId).toBe(id);
    expect(reopened.coordination.get(b).config.paused).toBe(true);
    expect(reopened.coordination.get(b).messages).toHaveLength(1);
    expect(reopened.coordination.get(b).wakes).toBe(0);
    expect(reopened.coordination.get(c).config).toEqual({ mode: 'brief', resources: '', remote: true, paused: false });
    expect(reopened.coordination.get(d).config.mode).toBe('off');
    expect((await reopened.coordination.directory(c)).agents.map(t => t.threadId)).not.toContain(d);
    const letter = await reopened.coordination.send({ threadId: c, to: reopened.coordination.get(e).self, text: 'Resume monitoring', requestId: 'after-restart' });
    await waitFor(() => reopened.coordination.get(e).messages.find(m => m.id === letter.id)?.status === 'delivered');
    expect(reopened.coordination.get(e).wakes).toBe(1);
  } finally { await reopened.close(); }
});

test('restart selection refuses corrupt visible thread state and saved coordination config', async () => {
  const { h, a, b } = await setup();
  for (const field of ['context', 'prompt_cache', 'title_state']) {
    const saved = h.core.journal.db.query(`SELECT ${field} AS value FROM threads WHERE id = ?`).get(a) as { value: string | null };
    try {
      h.core.journal.db.query(`UPDATE threads SET ${field} = ? WHERE id = ?`).run('{', a);
      expect(() => new Coordination(h.core)).toThrow(`invalid JSON in threads.${field} of ${a}`);
    } finally { h.core.journal.db.query(`UPDATE threads SET ${field} = ? WHERE id = ?`).run(saved.value, a); }
  }
  enable(h, a);
  h.core.journal.db.query("UPDATE threads SET status = 'waiting' WHERE id = ?").run(a);
  const deepConfig = JSON.stringify(brief).slice(0, -1) + ',"extension":' + '['.repeat(1100) + '0' + ']'.repeat(1100) + '}';
  for (const invalid of ['{', new TextEncoder().encode('{}')]) {
    const saved = typeof invalid === 'string' ? deepConfig : JSON.stringify(brief);
    h.core.journal.db.query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`coordination:${a}`, saved);
    h.core.journal.db.query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`coordination:${b}`, invalid);
    let unexpected: Coordination | undefined;
    try {
      expect(() => { unexpected = new Coordination(h.core); }).toThrow(`invalid JSON in settings.value row coordination:${b}`);
      expect(h.core.journal.getSetting(`coordination:${a}`)).toEqual({ ...JSON.parse(saved), paused: true });
    } finally { await unexpected?.close(); }
  }
});

test.each(['deleted', 'orphan'])('restart ignores malformed letters belonging to %s threads', async kind => {
  const { h, a, b } = await setup(); enable(h, a, b);
  h.core.coordination.pause(b);
  const letter = await send(h, a, dest(h, b));
  h.core.journal.db.query("UPDATE coordination_letters SET status = 'uncertain', data = '{' WHERE id = ? AND direction = 'in'").run(letter.id);
  if (kind === 'deleted') h.core.journal.db.query('INSERT INTO thread_deletions (thread_id, root_id, archived, deleted_at) VALUES (?, ?, ?, ?)').run(b, b, 0, Date.now());
  else h.core.journal.db.query("UPDATE coordination_letters SET thread_id = 'orphan' WHERE id = ? AND direction = 'in'").run(letter.id);
  const recovered = new Coordination(h.core);
  try {
    expect(h.core.journal.getSetting(`coordination:${a}`)).toEqual({ ...brief, paused: true });
    expect(h.core.journal.db.query("SELECT status, data FROM coordination_letters WHERE id = ? AND direction = 'in'").get(letter.id)).toEqual({ status: 'uncertain', data: '{' });
  } finally { await recovered.close(); }
});

test('a paused recipient keeps messages pending, and expired messages never wake a provider', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  h.core.coordination.pause(b);
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

test('a pause left by Stop ends with the user\'s next message, the owner\'s pause does not', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  h.core.threads.stopTurn(b);
  await send(h, a, dest(h, b));
  expect(h.core.coordination.get(b).config.paused).toBe(true);
  h.core.threads.startTurn(b, 'Carry on');
  expect(h.core.coordination.get(b).config.paused).toBe(false);
  // The waiting letter reaches the agent, inside his turn or in a wake right after it.
  await waitFor(() => h.core.coordination.get(b).messages[0]?.status === 'delivered', 8000);
  await waitFor(() => h.core.threads.require(b).status === 'idle', 8000);

  h.core.coordination.configure(b, { ...brief, paused: true });
  h.core.threads.stopTurn(b);
  h.core.threads.startTurn(b, 'Carry on again');
  expect(h.core.coordination.get(b).config.paused).toBe(true);
}, 20000);

test('a letter wakes an idle recipient at once, without waiting for the sweep', async () => {
  const { h, a, b } = await setup();
  await send(h, a, dest(h, b));
  // The sweep runs every 2 s: 100 ms leaves it a 5 % chance to be the one that delivered.
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(h.core.journal.listTurns(b).map(turn => turn.execution?.operation)).toEqual(['coordination']);
});

test('an idle monitoring thread accepts a default wake and keeps its background work', async () => {
  const { h, a, b } = await setup();
  let starts = 0;
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    expect(ctx.thread.id).toBe(b);
    if (++starts === 1) ctx.background?.([{ id: 'monitor-1', kind: 'monitor', description: 'Watch CI', toolId: null, startedAt: Date.now() }]);
    return { done: Promise.resolve({ status: 'done', sessionId: 'monitor-session', usage: null }), stop() {} };
  } }));
  const initial = h.core.threads.startTurn(b, 'Monitor CI');
  await waitFor(() => h.core.journal.getTurn(initial.id)?.status === 'done');
  expect(h.core.threads.get(b).backgroundWork?.kinds).toEqual(['monitor']);
  const letter = await send(h, a, dest(h, b), 'The deployment is ready');
  await waitFor(() => h.core.coordination.get(b).messages.find(m => m.id === letter.id)?.status === 'delivered');
  expect(starts).toBe(2);
  expect(h.core.coordination.get(b).wakes).toBe(1);
  expect(h.core.threads.get(b).backgroundWork?.kinds).toEqual(['monitor']);
});

test('the sweep reads pending letters through the status index and prunes settled old ones', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  h.core.coordination.pause(b);
  const kept = await send(h, a, dest(h, b), 'Still waiting');
  const old = await send(h, a, dest(h, b), 'Long settled');
  const db = h.core.journal.db;
  db.query("UPDATE coordination_letters SET status = 'delivered', created_at = ? WHERE id = ?").run(Date.now() - LETTER_RETENTION_MS - 1, old.id);
  const plan = (sql: string, ...params: (string | number)[]) => (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(row => row.detail).join(' | ');
  for (const sql of [
    ...SWEEP_PROBES.map(probe => probe.replaceAll('?', '1')),
    "SELECT data FROM coordination_letters WHERE status IN ('queued', 'received') AND json_extract(data, '$.expiresAt') <= 1",
    "SELECT DISTINCT thread_id FROM coordination_letters WHERE direction = 'in' AND status = 'received'",
    "SELECT data FROM coordination_letters WHERE direction = 'out' AND status IN ('queued', 'received', 'uncertain') AND json_extract(data, '$.expiresAt') > 1",
  ]) expect(plan(sql)).toContain('coordination_status');
  await (h.core.coordination as unknown as { tick(): Promise<void> }).tick();
  const ids = (db.query('SELECT id FROM coordination_letters').all() as { id: string }[]).map(row => row.id);
  expect(ids).toContain(kept.id);
  expect(ids).not.toContain(old.id);
});

test('an uncertain letter does not keep the sweep awake, and leaves the journal after 30 days', async () => {
  const { h, a, b } = await setup(); enable(h, a, b);
  h.core.coordination.pause(b);
  const stuck = await send(h, a, dest(h, b), 'Steer failed');
  const old = await send(h, a, dest(h, b), 'Long uncertain');
  const db = h.core.journal.db;
  // A steer that threw leaves its letters uncertain, and nothing moves them on.
  db.query("UPDATE coordination_letters SET status = 'uncertain', data = json_set(data, '$.status', 'uncertain', '$.error', 'steer failed', '$.expiresAt', ?) WHERE id = ?").run(Date.now() - 1, stuck.id);
  db.query("UPDATE coordination_letters SET status = 'uncertain', created_at = ? WHERE id = ?").run(Date.now() - LETTER_RETENTION_MS - 1, old.id);
  const coordination = h.core.coordination as unknown as { tick(): Promise<void>; swept: number; rows(where: string): unknown[] };
  coordination.swept = 0;
  const rows = spyOn(coordination, 'rows');
  restores.push(() => rows.mockRestore());
  await coordination.tick();
  // The idle probes found nothing to do: no scan of the letters followed them.
  expect(rows).not.toHaveBeenCalled();
  const ids = (db.query('SELECT id FROM coordination_letters').all() as { id: string }[]).map(row => row.id);
  expect(ids).toContain(stuck.id);
  expect(ids).not.toContain(old.id);
});

function say(h: TestCore, threadId: string, role: 'user' | 'assistant', text: string, at = Date.now()) {
  h.core.journal.putMessage({ id: crypto.randomUUID(), threadId, turnId: 'history', role, state: 'complete', createdAt: at, parts: [{ type: 'text', text }, ...(role === 'assistant' ? [{ type: 'tool' as const, toolId: 't1', name: 'Bash', input: {}, status: 'done' as const, output: 'secret tool output' }] : [])] as never });
}

test('directory lists the most recently active first and describes each contact', async () => {
  const { h, a, b } = await setup();
  const c = (await echoThread(h, await h.connect(), 'Newest')).threadId;
  h.core.journal.putThread({ ...h.core.threads.require(b), updatedAt: Date.now() + 60_000 });
  const agents = (await h.core.coordination.directory(a)).agents;
  expect(agents.map(t => t.threadId)).toEqual([b, c]);
  expect(agents[0]).toMatchObject({ title: 'Deployment', agent: expect.stringContaining('echo'), branch: null });
  expect(typeof agents[0]?.project).toBe('string');
});

test('search finds a contact by words of its chat, fields or both, and reading returns text and tool names only', async () => {
  const { h, a, b } = await setup();
  say(h, b, 'user', 'the login page shows a blank screen after the redirect', 1000);
  say(h, b, 'assistant', 'I changed the OAuth callback in auth.ts', 2000);
  const found = await h.core.coordination.search(a, 'blank deployment');
  expect(found.matches.map(m => m.threadId)).toEqual([b]);
  expect(found.matches[0]?.matched).toEqual(['title', 'chat']);
  expect(found.matches[0]?.excerpts[0]).toContain('blank screen');
  expect((await h.core.coordination.search(a, 'blank nowhere')).matches).toEqual([]);
  // A tool's output is not chat.
  expect((await h.core.coordination.search(a, 'secret')).matches).toEqual([]);
  const read = await h.core.coordination.read(a, dest(h, b), 1);
  expect(read.entries.map(e => [e.role, e.text, e.tools])).toEqual([['assistant', 'I changed the OAuth callback in auth.ts', ['Bash']]]);
  expect(read.more).toBe(true);
  const older = await h.core.coordination.read(a, dest(h, b), 5, read.entries[0]!.at);
  expect(older.entries.map(e => e.text)).toEqual(['the login page shows a blank screen after the redirect']);
  expect(older.more).toBe(false);
  expect(JSON.stringify(read)).not.toContain('secret tool output');
  h.core.coordination.configure(b, { ...brief, mode: 'off' });
  await expect(h.core.coordination.read(a, dest(h, b))).rejects.toThrow('not a contact');
});

test('a waiting agent takes its answer directly, and the recipient is not woken for it', async () => {
  const { h, a, b } = await setup();
  const waiting = h.core.coordination.wait(a, dest(h, b), 5000);
  const answer = await send(h, b, dest(h, a), 'Done, you can restart.');
  const { letters } = await waiting;
  expect(letters.map(l => [l.id, l.status])).toEqual([[answer.id, 'delivered']]);
  await new Promise(resolve => setTimeout(resolve, 300));
  // The answer reached the agent through its tool output only: no wake turn, no injected copy.
  expect(h.core.journal.listTurns(a)).toHaveLength(0);
  const prompts = h.core.journal.listMessages(a).filter(m => m.role === 'system').map(m => JSON.stringify(m.parts));
  expect(prompts.some(p => p.includes('Done, you can restart.'))).toBe(false);
  expect((await h.core.coordination.wait(a, undefined, 0)).letters).toEqual([]);
});

test('two linked cores search and read each other\'s agents through signed requests', async () => {
  const one = await setup(); const two = await setup();
  const cardA = one.h.core.coordination.identity(), cardB = two.h.core.coordination.identity();
  one.h.core.coordination.trust(cardB); two.h.core.coordination.trust({ ...cardA, readThreads: true });
  say(two.h, two.b, 'user', 'the nightly backup to the NAS failed again');
  const found = await one.h.core.coordination.search(one.a, 'nas backup');
  expect(found.unavailable).toEqual([]);
  const remote = found.matches.find(m => m.coreId === cardB.coreId);
  expect(remote).toMatchObject({ threadId: two.b, machine: cardB.name, matched: ['chat'] });
  const read = await one.h.core.coordination.read(one.a, { coreId: cardB.coreId, threadId: two.b });
  expect(read.contact.threadId).toBe(two.b);
  expect(read.entries.map(e => e.text)).toEqual(['the nightly backup to the NAS failed again']);
  two.h.core.coordination.configure(two.b, { ...brief, remote: false });
  await expect(one.h.core.coordination.read(one.a, { coreId: cardB.coreId, threadId: two.b })).rejects.toThrow('not a thread open to other machines');
}, 25000);


test('old local letters gain project names without requiring enabled contacts', async () => {
  const { h, a, b } = await setup();
  h.core.coordination.pause(b);
  const letter = await send(h, a, dest(h, b));
  h.core.journal.db.query("UPDATE coordination_letters SET data = json_remove(data, '$.from.project', '$.toProject') WHERE id = ?").run(letter.id);
  h.core.coordination.configure(a, { ...brief, mode: 'off' });
  const project = h.core.journal.getProject(h.core.threads.require(a).projectId!)!.name;
  const old = h.core.coordination.get(b).messages[0]!;
  expect(old.from.project).toBe(project);
  expect(old.toProject).toBe(project);
});
