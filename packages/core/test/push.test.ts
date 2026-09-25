import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { RpcEvents, Turn, TurnExecution } from '@boite/contracts';
import { createECDH, randomBytes } from 'node:crypto';
import { connect } from '../src/client.ts';
import { validateSubscription } from '../src/push.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { PushStore } from '../src/push.ts';

let harness: TestCore;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { await harness.stop(); });
function subscription() {
  const ecdh = createECDH('prime256v1');
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`, keys: {
    p256dh: ecdh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url')
  } };
}
function session() {
  const grant = harness.core.sessions.grant();
  return harness.core.sessions.exchange(grant.grant, { name: 'pwa', version: 'test' });
}

test('only a real pairing can manage its own push subscription over RPC', async () => {
  const owner = await harness.connect();
  await expect(owner.call('push.status', {})).rejects.toThrow('paired device');
  const paired = session();
  const phone = await connect(harness.url, paired.token);
  try {
    const before = await phone.call('push.status', {});
    expect(before.subscribed).toBe(false);
    expect(Buffer.from(before.publicKey, 'base64url').length).toBe(65);
    await phone.call('push.subscribe', subscription());
    expect((await phone.call('push.status', {})).subscribed).toBe(true);
    const other = session();
    expect((await harness.core.push.status(other.id)).subscribed).toBe(false);
    await phone.call('push.unsubscribe', {});
    expect((await phone.call('push.status', {})).subscribed).toBe(false);
  } finally { phone.close(); }
});

test('invalid endpoints and encryption keys are refused before any network call', () => {
  const valid = subscription();
  for (const endpoint of ['http://fcm.googleapis.com/send', 'https://127.0.0.1/', 'https://fcm.googleapis.com.evil.test/', 'https://fcm.googleapis.com:444/', 'https://user@fcm.googleapis.com/send']) {
    expect(() => validateSubscription({ ...valid, endpoint })).toThrow('endpoint');
  }
  expect(() => validateSubscription({ ...valid, keys: { ...valid.keys, auth: 'short' } })).toThrow('keys.auth');
  expect(() => validateSubscription({ ...valid, keys: { ...valid.keys, p256dh: Buffer.alloc(65).toString('base64url') } })).toThrow('keys.p256dh');
});

test('test delivery uses the device subscription and drops an expired destination', async () => {
  const paired = session();
  const sub = subscription();
  harness.core.push.subscribe(paired.id, sub);
  const sent: string[] = [];
  harness.core.push.send = async (target, payload, keys) => {
    expect(target).toEqual(sub);
    expect(keys.privateKey).toBeTruthy();
    sent.push(JSON.parse(payload).body);
  };
  await harness.core.push.test(paired.id);
  expect(sent).toEqual(['Notifications are connected']);
  harness.core.push.send = async () => { throw Object.assign(new Error('private endpoint material'), { statusCode: 410 }); };
  await expect(harness.core.push.test(paired.id)).rejects.toThrow('Web Push delivery failed (410)');
  expect((await harness.core.push.status(paired.id)).subscribed).toBe(false);
});

test('revocation deletes the subscription and cannot deliver another test', async () => {
  const paired = session();
  harness.core.push.subscribe(paired.id, subscription());
  harness.core.sessions.revoke(paired.id);
  expect(harness.core.journal.getSetting('web-push.subscriptions')).toEqual({});
  await expect(harness.core.push.test(paired.id)).rejects.toThrow('paired device');
});

test('a recreated push store retains its keys and delivers completed turns to the paired phone', async () => {
  const paired = session();
  const before = await harness.core.push.status(paired.id);
  harness.core.push.subscribe(paired.id, subscription());
  await harness.core.push.close();
  const restarted = new PushStore(harness.core);
  const deliveries: { threadId: string; body: string }[] = [];
  restarted.send = async (_target, payload) => { deliveries.push(JSON.parse(payload)); };
  try {
    expect(await restarted.status(paired.id)).toEqual({ ...before, subscribed: true });
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('turns.start', { threadId, prompt: 'Notify the phone' });
    await waitFor(() => deliveries.length > 0);
    expect(deliveries).toEqual([expect.objectContaining({ threadId, body: 'Done' })]);
    harness.core.sessions.revoke(paired.id);
    expect(harness.core.journal.getSetting('web-push.subscriptions')).toEqual({});
  } finally { await restarted.close(); }
});

test('a phone hears of a team\'s final answer and a persistent agent\'s failures, not of every turn under them', async () => {
  const paired = session();
  harness.core.push.subscribe(paired.id, subscription());
  const deliveries: { threadId: string; body: string }[] = [];
  harness.core.push.send = async (_target, payload) => { deliveries.push(JSON.parse(payload)); };
  const client = await harness.connect();
  const { threadId: rootId } = await echoThread(harness, client);
  const root = harness.core.journal.getThread(rootId)!;
  const child = { ...root, id: 'push_child', parentThreadId: rootId, status: 'running' as const };
  const agent = { ...root, id: 'push_agent', projectId: null, agentSessionId: 'push_session' };
  harness.core.journal.putThread(child);
  harness.core.journal.putThread(agent);
  const finish = (threadId: string, status: Turn['status'], operation?: TurnExecution['operation']) => {
    const execution = { providerId: root.providerId, accountId: root.accountId, model: null, effort: null, permissionMode: root.permissionMode, sessionId: null, sessionGeneration: 0, selectionVersion: 0, ...(operation ? { operation } : {}) };
    harness.core.bus.emit('turn.finished', { id: `turn_${deliveries.length}_${Math.random()}`, threadId, status, queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null, execution });
  };

  finish(child.id, 'done');
  finish(child.id, 'error');
  // The parent handed the work out and yields while its agents still run.
  finish(rootId, 'done');
  finish(rootId, 'done', 'compact');
  finish(agent.id, 'done');
  // A child blocked on a question still reaches the phone.
  harness.core.bus.emit('question.asked', { id: 'push_question', threadId: child.id } as RpcEvents['question.asked']);
  await waitFor(() => deliveries.length === 1);

  harness.core.journal.putThread({ ...child, status: 'idle' });
  finish(rootId, 'done', 'delegation');
  finish(agent.id, 'error');
  await waitFor(() => deliveries.length === 3);
  await Bun.sleep(50);
  expect(deliveries.map(({ threadId, body }) => ({ threadId, body }))).toEqual([
    { threadId: child.id, body: 'Needs your answer' },
    { threadId: rootId, body: 'Done' },
    { threadId: agent.id, body: 'The agent encountered an error' },
  ]);
});

test('public HTTPS origin is validated, used for QR links and accepted by the socket', async () => {
  const owner = await harness.connect();
  for (const publicUrl of ['http://phone.test', 'https://phone.test/path', 'https://user:pass@phone.test', 'https://phone.test?token=x']) {
    await expect(owner.call('settings.set', { publicUrl })).rejects.toThrow('publicUrl');
  }
  // A copy from the address bar ends in a slash: the same origin, stored bare.
  expect((await owner.call('settings.set', { publicUrl: 'https://phone.test/' })).publicUrl).toBe('https://phone.test');
  expect(harness.core.settings.get().publicUrl).toBe('https://phone.test');
  const grant = await owner.call('pairing.grant', {});
  expect(new URL(grant.url).origin).toBe('https://phone.test');
  const socket = new WebSocket(harness.url.replace('http:', 'ws:') + '/rpc', { headers: { Origin: 'https://phone.test' } });
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  socket.close();
  await owner.call('settings.set', { publicUrl: null });
  expect(new URL((await owner.call('pairing.grant', {})).url).origin).toBe(harness.url);
});
