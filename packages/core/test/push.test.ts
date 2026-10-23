import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import { ATTENTION_LEASE_MS, notificationExcerpt, type RpcEvents, type Turn, type TurnExecution } from '@boite/contracts';
import { createECDH, randomBytes } from 'node:crypto';
import { connect } from '../src/client.ts';
import { validateSubscription } from '../src/push.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { PushStore } from '../src/push.ts';
import { thrown } from './settle.ts';

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
  expect(await thrown(owner.call('push.status', {}))).toThrow('paired device');
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
  expect(await thrown(harness.core.push.test(paired.id))).toThrow('Web Push delivery failed (410)');
  expect((await harness.core.push.status(paired.id)).subscribed).toBe(false);
});

test('revocation deletes the subscription and cannot deliver another test', async () => {
  const paired = session();
  harness.core.push.subscribe(paired.id, subscription());
  harness.core.sessions.revoke(paired.id);
  expect(harness.core.journal.getSetting('web-push.subscriptions')).toEqual({});
  expect(await thrown(harness.core.push.test(paired.id))).toThrow('paired device');
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
    expect(await restarted.status(paired.id)).toEqual({ ...before, subscribed: true, kinds: ['approvals', 'questions', 'finished', 'errors', 'limits'] });
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    // The body is the start of the reply, as one line of plain text cut at a word.
    await client.call('turns.start', { threadId, prompt: '## Build\n\nThe **build** passed: see [the log](https://example.test/log) and `bun test`.\n\n' + 'More details follow here. '.repeat(10) });
    await waitFor(() => deliveries.length > 0);
    const body = 'Build · The build passed: see the log and bun test. More details follow here. More details follow here. More details follow here. More…';
    expect(deliveries).toEqual([expect.objectContaining({ threadId, body })]);
    expect(deliveries[0]).not.toHaveProperty('label');
    harness.core.sessions.revoke(paired.id);
    expect(harness.core.journal.getSetting('web-push.subscriptions')).toEqual({});
  } finally { await restarted.close(); }
});

test('a phone hears of a team\'s final answer and a persistent agent\'s failures, not of every turn under them', async () => {
  const paired = session();
  harness.core.push.subscribe(paired.id, subscription());
  const deliveries: { threadId: string; body: string; label?: string }[] = [];
  harness.core.push.send = async (_target, payload) => { deliveries.push(JSON.parse(payload)); };
  const client = await harness.connect();
  const { threadId: rootId } = await echoThread(harness, client);
  const root = harness.core.journal.getThread(rootId)!;
  const child = { ...root, id: 'push_child', parentThreadId: rootId, status: 'running' as const };
  const agent = { ...root, id: 'push_agent', projectId: null, agentSessionId: 'push_session' };
  harness.core.journal.putThread(child);
  harness.core.journal.putThread(agent);
  const finish = (threadId: string, status: Turn['status'], operation?: TurnExecution['operation'], quiet = false) => {
    const execution = { providerId: root.providerId, accountId: root.accountId, model: null, effort: null, permissionMode: root.permissionMode, sessionId: null, sessionGeneration: 0, selectionVersion: 0, ...(operation ? { operation } : {}) };
    harness.core.bus.emit('turn.finished', { id: `turn_${deliveries.length}_${Math.random()}`, threadId, status, queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null, execution, ...(quiet ? { quiet: true as const } : {}) });
  };

  finish(child.id, 'done');
  finish(child.id, 'error');
  // The parent handed the work out and yields while its agents still run.
  finish(rootId, 'done');
  finish(rootId, 'done', 'compact');
  // A persistent agent's wake that had nothing to say.
  finish(agent.id, 'done', 'routine', true);
  // A child blocked on a question still reaches the phone.
  harness.core.bus.emit('question.asked', { id: 'push_question', threadId: child.id, text: 'Which `branch` should I use?' } as RpcEvents['question.asked']);
  await waitFor(() => deliveries.length === 1);

  harness.core.journal.putThread({ ...child, status: 'idle' });
  finish(rootId, 'done', 'delegation');
  finish(agent.id, 'error');
  await waitFor(() => deliveries.length === 3);
  await Bun.sleep(50);
  // A turn with no reply to quote, and a failure, say so through a label the phone translates.
  expect(deliveries.map(({ threadId, body, label }) => ({ threadId, body, label }))).toEqual([
    { threadId: child.id, body: 'Which branch should I use?', label: undefined },
    { threadId: rootId, body: 'Done', label: 'done' },
    { threadId: agent.id, body: 'The agent encountered an error', label: 'failed' },
  ]);
});

test('a reply that lands while its sender is on the thread reaches the phone once they leave', async () => {
  const paired = session();
  harness.core.push.subscribe(paired.id, subscription());
  const deliveries: { threadId: string; tag: string }[] = [];
  harness.core.push.send = async (_target, payload) => { deliveries.push(JSON.parse(payload)); };
  const desktop = await harness.connect();
  const phone = await connect(harness.url, paired.token);
  try {
    const { threadId } = await echoThread(harness, desktop);
    let n = 0;
    const thread = harness.core.journal.getThread(threadId)!;
    const finish = () => harness.core.bus.emit('turn.finished', { id: `walk_${++n}`, threadId, status: 'done', queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null, execution: { providerId: thread.providerId, accountId: thread.accountId, model: null, effort: null, permissionMode: thread.permissionMode, sessionId: null, sessionGeneration: 0, selectionVersion: 0 } });
    const delivered = async (count: number) => { await waitFor(() => deliveries.length === count); await Bun.sleep(30); expect(deliveries).toHaveLength(count); };

    // Sent from the PC, which then goes quiet: the reply came within seconds, and arrives once the PC says nobody is there.
    await desktop.call('threads.focus', { threadId, attentive: true, idleMs: 0 });
    finish();
    await delivered(0);
    await desktop.call('threads.focus', { threadId, attentive: false, idleMs: 46_000 });
    await delivered(1);
    // Sent from the phone, then locked before it could say so: the reply arrives when its lease runs out.
    await phone.call('threads.focus', { threadId, attentive: true, idleMs: 0 });
    finish();
    await delivered(1);
    setSystemTime(new Date(Date.now() + ATTENTION_LEASE_MS + 1));
    harness.core.push.releaseHeld();
    await delivered(2);
  } finally { setSystemTime(); phone.close(); }
});

test('no push about a thread someone is looking at and uses, on the PC or the phone', async () => {
  const paired = session();
  harness.core.push.subscribe(paired.id, subscription());
  const deliveries: { threadId: string; tag: string }[] = [];
  harness.core.push.send = async (_target, payload) => { deliveries.push(JSON.parse(payload)); };
  const desktop = await harness.connect();
  const phone = await connect(harness.url, paired.token);
  try {
    const { threadId } = await echoThread(harness, desktop);
    const other = { ...harness.core.journal.getThread(threadId)!, id: 'push_other' };
    harness.core.journal.putThread(other);
    let n = 0;
    const finish = (id: string) => harness.core.bus.emit('turn.finished', { id: `attention_${++n}`, threadId: id, status: 'done', queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null, execution: { providerId: other.providerId, accountId: other.accountId, model: null, effort: null, permissionMode: other.permissionMode, sessionId: null, sessionGeneration: 0, selectionVersion: 0 } });
    const delivered = async (count: number) => { await waitFor(() => deliveries.length === count); await Bun.sleep(30); expect(deliveries).toHaveLength(count); };

    // The phone in the foreground on the thread: news about it waits, news about another one goes.
    await phone.call('threads.focus', { threadId, attentive: true, idleMs: 0 });
    finish(threadId); finish(threadId); finish(other.id);
    await delivered(1);
    expect(deliveries[0]!.threadId).toBe(other.id);
    // A touch on that screen afterwards shows it was seen: locking the phone then sends nothing.
    await Bun.sleep(5);
    await phone.call('threads.focus', { threadId, attentive: true, idleMs: 0 });
    await phone.call('threads.focus', { threadId, attentive: false, idleMs: 1_000 });
    await delivered(1);
    // The desktop window in front and used: the same. Use of another thread is not use of this one.
    await desktop.call('threads.focus', { threadId, attentive: true, idleMs: 0 });
    finish(threadId);
    await Bun.sleep(5);
    await phone.call('threads.focus', { threadId: other.id, attentive: true, idleMs: 0 });
    await phone.call('threads.focus', { threadId: null });
    await desktop.call('threads.focus', { threadId, attentive: true, idleMs: 0 });
    await desktop.call('threads.focus', { threadId: other.id });
    await delivered(1);
    // A window in front that nobody used for a while is not believed; one with the thread merely open does not count.
    await desktop.call('threads.focus', { threadId, attentive: true, idleMs: 60_000 });
    finish(threadId);
    await desktop.call('threads.focus', { threadId });
    finish(threadId);
    await delivered(3);
    // Looking away without having used the thread since sends what waited.
    // The core dates a use at the report's arrival minus its idleMs, so any
    // margin the test picks loses to a slow enough trip to the core, which then
    // drops the news as seen. A still clock dates the use 1 ms before the news.
    setSystemTime(new Date());
    await desktop.call('threads.focus', { threadId, attentive: true, idleMs: 0 });
    finish(threadId);
    // The report takes its time to arrive, as on a loaded runner.
    await Bun.sleep(40);
    await desktop.call('threads.focus', { threadId, attentive: true, idleMs: 1 });
    setSystemTime();
    await delivered(3);
    desktop.close();
    await delivered(4);
    expect(await thrown(phone.call('threads.focus', { threadId, attentive: 'yes' as never }))).toThrow('attentive');
    expect(await thrown(phone.call('threads.focus', { threadId, idleMs: -1 }))).toThrow('idleMs');
  } finally { setSystemTime(); phone.close(); }
});
test('questions and permissions push immediately even when their thread is attended', async () => {
  const paired = session();
  harness.core.push.subscribe(paired.id, subscription());
  const deliveries: { threadId: string; tag: string }[] = [];
  harness.core.push.send = async (_target, payload) => { deliveries.push(JSON.parse(payload)); };
  const desktop = await harness.connect();
  const { threadId } = await echoThread(harness, desktop);
  await desktop.call('threads.focus', { threadId, attentive: true, idleMs: 0 });
  harness.core.bus.emit('question.asked', { id: 'focused_question', threadId, turnId: 'focused_turn', async: true, text: 'Subagents are paused. Continue?', options: [], allowText: true, multiple: false, createdAt: Date.now() });
  harness.core.bus.emit('permission.requested', { id: 'focused_permission', threadId, turnId: 'focused_turn', toolName: 'Edit', input: {}, description: 'Allow file edit?', createdAt: Date.now() });
  await waitFor(() => deliveries.length === 2);
  expect(deliveries.map(row => row.tag).sort()).toEqual(['request-focused_permission', 'request-focused_question']);
  expect(deliveries.every(row => row.threadId === threadId)).toBe(true);
  await desktop.call('threads.focus', { threadId: null });
  await Bun.sleep(30);
  expect(deliveries).toHaveLength(2);
});

test('a notification carries the icon badge: the threads waiting on the user, the notified one included', async () => {
  const paired = session();
  harness.core.push.subscribe(paired.id, subscription());
  const deliveries: { threadId: string; badge?: number }[] = [];
  harness.core.push.send = async (_target, payload) => { deliveries.push(JSON.parse(payload)); };
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const base = harness.core.journal.getThread(threadId)!;
  harness.core.journal.putThread({ ...base, unread: false, status: 'idle' });
  harness.core.journal.putThread({ ...base, id: 'badge_waiting', unread: false, status: 'waiting' });
  harness.core.journal.putThread({ ...base, id: 'badge_unread', unread: true, status: 'idle' });
  harness.core.journal.putThread({ ...base, id: 'badge_archived', unread: true, status: 'waiting', archived: true });
  expect(harness.core.push.badge()).toBe(2);
  expect(harness.core.push.badge(threadId)).toBe(3);
  expect(harness.core.push.badge('badge_waiting')).toBe(2);
  expect(harness.core.push.badge('badge_archived')).toBe(2);

  harness.core.bus.emit('question.asked', { id: 'badge_question', threadId } as RpcEvents['question.asked']);
  await waitFor(() => deliveries.length === 1);
  expect(deliveries[0]).toMatchObject({ threadId, badge: 3 });

  // The test notification leaves the badge as it is.
  const sent: Record<string, unknown>[] = [];
  harness.core.push.send = async (_target, payload) => { sent.push(JSON.parse(payload)); };
  await harness.core.push.test(paired.id);
  expect(sent[0]).not.toHaveProperty('badge');

  // A question asked without stopping leaves the row idle; its thread still counts.
  harness.core.threads.cards.askQuestion(harness.core.journal.getThread(threadId)!, { id: 'turn_badge' } as Turn, { text: 'Which file?', options: [], allowText: true, multiple: false, async: true });
  expect(harness.core.journal.getThread(threadId)!.status).toBe('idle');
  expect(harness.core.push.badge()).toBe(3);
});
test('public HTTPS origin is validated, used for QR links and accepted by the socket', async () => {
  const owner = await harness.connect();
  for (const publicUrl of ['http://phone.test', 'https://phone.test/path', 'https://user:pass@phone.test', 'https://phone.test?token=x']) {
    expect(await thrown(owner.call('settings.set', { publicUrl }))).toThrow('publicUrl');
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

test('a notification reads code fences as their content, in linear time on many fences', () => {
  expect(notificationExcerpt('Done:\n```ts\nconst x = 1;\n```\nThen `y`.')).toBe('Done: const x = 1; Then y.');
  expect(notificationExcerpt('Run ```sh\nbun test')).toBe('Run bun test');
  const started = performance.now();
  notificationExcerpt('```'.repeat(50_000));
  expect(performance.now() - started).toBeLessThan(500);
});

test('a notification of one very long line is read in bounded time', () => {
  // Emphasis and link patterns backtrack on these: 120 000 characters took seconds.
  for (const line of [' *a'.repeat(40_000), '[a'.repeat(40_000)]) {
    const started = performance.now();
    expect(notificationExcerpt(line).length).toBeLessThanOrEqual(141);
    expect(performance.now() - started).toBeLessThan(500);
  }
});

test('with no subscription and no other member, a finished turn prepares no push at all', async () => {
  const sent: string[] = [];
  harness.core.push.send = async (_target, payload) => { sent.push(payload); };
  const forwarded: unknown[] = [];
  harness.core.push.forward = async (_home, payload) => { forwarded.push(payload); };
  const walk = spyOn(harness.core.journal, 'walkAgentMessagesBackwards');
  const badge = spyOn(harness.core.push, 'badge');
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const thread = harness.core.journal.getThread(threadId)!;
    const finish = (id: string) => harness.core.bus.emit('turn.finished', { id, threadId, status: 'done', queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null,
      execution: { providerId: thread.providerId, accountId: thread.accountId, model: null, effort: null, permissionMode: thread.permissionMode, sessionId: null, sessionGeneration: 0, selectionVersion: 0 } });
    walk.mockClear(); badge.mockClear();
    finish('quiet_1');
    harness.core.bus.emit('question.asked', { id: 'quiet_question', threadId, text: 'Which branch?' } as RpcEvents['question.asked']);
    await Bun.sleep(30);
    expect([walk.mock.calls.length, badge.mock.calls.length, sent.length, forwarded.length]).toEqual([0, 0, 0, 0]);
    // Subscribed mid-thread: the next turn reaches the phone.
    harness.core.push.subscribe(session().id, subscription());
    finish('quiet_2');
    await waitFor(() => sent.length === 1);
    expect(walk.mock.calls.length).toBeGreaterThan(0);
    expect(forwarded).toEqual([]);
  } finally { walk.mockRestore(); badge.mockRestore(); }
});

test('a device that kept only approvals gets the permission push and not the finished turn, and changes its kinds without subscribing again', async () => {
  const paired = session();
  const phone = await connect(harness.url, paired.token);
  const deliveries: { tag: string; kind?: string }[] = [];
  harness.core.push.send = async (_target, payload) => { deliveries.push(JSON.parse(payload)); };
  try {
    await phone.call('push.subscribe', { ...subscription(), kinds: ['approvals'] });
    expect(await phone.call('push.status', {})).toMatchObject({ subscribed: true, kinds: ['approvals'] });
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const thread = harness.core.journal.getThread(threadId)!;
    const finish = (id: string, status: 'done' | 'error') => harness.core.bus.emit('turn.finished', { id, threadId, status, queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null, execution: { providerId: thread.providerId, accountId: thread.accountId, model: null, effort: null, permissionMode: thread.permissionMode, sessionId: null, sessionGeneration: 0, selectionVersion: 0 } });
    const ask = (id: string, extra: Partial<RpcEvents['question.asked']> = {}) => harness.core.bus.emit('question.asked', { id, threadId, turnId: 'kind_turn', text: 'Which branch?', options: [], allowText: true, multiple: false, createdAt: Date.now(), ...extra });
    finish('kind_done', 'done');
    finish('kind_failed', 'error');
    ask('kind_question');
    ask('kind_setting', { async: true, setting: { kind: 'change', key: 'shortAnswers', value: false, previous: true, page: 'general', section: 'conversations', sensitive: false } });
    harness.core.bus.emit('permission.requested', { id: 'kind_permission', threadId, turnId: 'kind_turn', toolName: 'ExitPlanMode', input: { plan: 'Ship it' }, description: null, createdAt: Date.now() });
    await waitFor(() => deliveries.length === 2);
    await Bun.sleep(30);
    expect(deliveries.map(row => [row.tag, row.kind]).sort()).toEqual([['request-kind_permission', 'approvals'], ['request-kind_setting', 'approvals']]);

    // The same subscription, other kinds: what reaches it changes, nothing else.
    await phone.call('push.kinds', { kinds: ['errors', 'questions'] });
    expect(await phone.call('push.status', {})).toMatchObject({ subscribed: true, kinds: ['questions', 'errors'] });
    finish('kind_done_2', 'done');
    finish('kind_failed_2', 'error');
    ask('kind_question_2');
    await waitFor(() => deliveries.length === 4);
    await Bun.sleep(30);
    expect(deliveries.slice(2).map(row => [row.tag, row.kind]).sort()).toEqual([['request-kind_question_2', 'questions'], ['turn-kind_failed_2', 'errors']]);
    // Nothing chosen is nothing received; the test notification still goes.
    await phone.call('push.kinds', { kinds: [] });
    ask('kind_question_3');
    await Bun.sleep(50);
    expect(deliveries).toHaveLength(4);
    await phone.call('push.test', {});
    expect(deliveries).toHaveLength(5);
    expect(await thrown(phone.call('push.kinds', { kinds: ['everything'] as never }))).toThrow('kinds must be a list');
    await phone.call('push.unsubscribe', {});
    expect(await thrown(phone.call('push.kinds', { kinds: ['approvals'] }))).toThrow('Enable notifications');
    owner.close();
  } finally { phone.close(); }
});

test('a subscription stored before kinds existed receives every kind', async () => {
  const paired = session();
  harness.core.push.subscribe(paired.id, subscription());
  expect((await harness.core.push.status(paired.id)).kinds).toEqual(['approvals', 'questions', 'finished', 'errors', 'limits']);
  const deliveries: { kind?: string }[] = [];
  harness.core.push.send = async (_target, payload) => { deliveries.push(JSON.parse(payload)); };
  const owner = await harness.connect();
  const { threadId } = await echoThread(harness, owner);
  harness.core.bus.emit('question.asked', { id: 'old_question', threadId, turnId: 't', text: 'Which branch?', options: [], allowText: true, multiple: false, createdAt: Date.now() });
  harness.core.bus.emit('permission.requested', { id: 'old_permission', threadId, turnId: 't', toolName: 'Edit', input: {}, description: null, createdAt: Date.now() });
  await waitFor(() => deliveries.length === 2);
  expect(deliveries.map(row => row.kind).sort()).toEqual(['approvals', 'questions']);
  owner.close();
});
