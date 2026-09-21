import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAddress, CoordinationConfig } from '@boite/contracts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const core of cores.splice(0)) await core.stop();
});

const brief: CoordinationConfig = { mode: 'brief', resources: '', remote: false, paused: false };

async function setupQueued() {
  const h = await startTestCore({ settings: { maxConcurrentTurns: 1, perAccountConcurrency: 1 } });
  cores.push(h);
  const owner = await h.connect();
  const from = (await echoThread(h, owner, 'Sender')).threadId;
  const to = (await echoThread(h, owner, 'Recipient')).threadId;
  const blocker = (await echoThread(h, owner, 'Blocker')).threadId;
  h.core.coordination.configure(from, brief);
  h.core.coordination.configure(to, brief);
  let stopBlocker!: () => void;
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    if (ctx.thread.id !== blocker) throw new Error('only the blocker may start in this test');
    let finish!: (status: 'done' | 'stopped') => void;
    const done = new Promise<{ status: 'done' | 'stopped'; sessionId: null; usage: null }>(resolve => {
      finish = status => resolve({ status, sessionId: null, usage: null });
    });
    stopBlocker = () => finish('stopped');
    return { done, stop: stopBlocker };
  } }));
  h.core.threads.startTurn(blocker, 'Hold the account slot');
  await waitFor(() => h.core.threads.require(blocker).status === 'running');
  const destination = h.core.coordination.get(to).self;
  const letter = await h.core.coordination.send({ threadId: from, to: destination, text: 'Coordinate later', requestId: crypto.randomUUID() });
  await waitFor(() => h.core.coordination.get(to).messages.find(message => message.id === letter.id)?.error === 'Queued for provider delivery', 8000);
  return { h, owner, from, to, blocker, letter, stopBlocker };
}

test('stopping or archiving a queued coordination turn restores messages that never reached a provider', async () => {
  const first = await setupQueued();
  expect(first.h.core.threads.stopTurn(first.to)).toBe(true);
  expect(first.h.core.coordination.get(first.to).messages[0]?.status).toBe('received');
  expect(first.h.core.coordination.get(first.to).messages[0]?.error).toBeNull();
  first.stopBlocker();

  const second = await setupQueued();
  second.h.core.threads.archive(second.to, true);
  expect(second.h.core.coordination.get(second.to).messages[0]?.status).toBe('received');
  expect(second.h.core.coordination.get(second.to).messages[0]?.error).toBeNull();
  second.stopBlocker();
}, 20000);

test('turning coordination off cancels a queued wake before rejecting its message', async () => {
  const { h, to, letter, stopBlocker } = await setupQueued();
  h.core.coordination.configure(to, { ...brief, mode: 'off' });
  expect(h.core.coordination.get(to).messages.find(message => message.id === letter.id)).toMatchObject({ status: 'rejected', error: 'Coordination disabled' });
  expect(h.core.journal.listTurns(to).find(turn => turn.execution?.operation === 'coordination')?.status).toBe('stopped');
  stopBlocker();
}, 12000);

test('a sender revocation cancels the recipient wake that is still queued', async () => {
  const { h, from, to, letter, stopBlocker } = await setupQueued();
  h.core.coordination.configure(from, { ...brief, mode: 'off' });
  expect(h.core.coordination.get(to).messages.find(message => message.id === letter.id)).toMatchObject({ status: 'rejected', error: 'Coordination disabled' });
  expect(h.core.journal.listTurns(to).find(turn => turn.execution?.operation === 'coordination')?.status).toBe('stopped');
  stopBlocker();
}, 12000);

test('cross-project consent is rechecked and disabling it rejects a pending delivery', async () => {
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const account = (await owner.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
  const paths = [join(h.dataDir, 'project-one'), join(h.dataDir, 'project-two')];
  for (const path of paths) mkdirSync(path, { recursive: true });
  const projects = await Promise.all(paths.map((path, index) => owner.call('projects.add', { path, name: `Project ${index + 1}` })));
  const from = (await owner.call('threads.create', { projectId: projects[0]!.id, providerId: 'echo', accountId: account.id, title: 'Sender' })).id;
  const to = (await owner.call('threads.create', { projectId: projects[1]!.id, providerId: 'echo', accountId: account.id, title: 'Recipient' })).id;
  h.core.coordination.configure(from, { ...brief, remote: true });
  h.core.coordination.configure(to, { ...brief, remote: true, paused: true });
  const letter = await h.core.coordination.send({ threadId: from, to: h.core.coordination.get(to).self, text: 'Cross-project work', requestId: crypto.randomUUID() });
  expect(letter.status).toBe('received');
  h.core.coordination.configure(to, { ...brief, remote: false });
  expect(h.core.coordination.get(to).messages[0]).toMatchObject({ status: 'rejected', error: 'Cross-project or cross-machine coordination disabled' });
  expect(h.core.coordination.take(to, 'unused')).toBeNull();
});

test('revoking a peer cancels its queued wake before rejecting the incoming message', async () => {
  const one = await startTestCore(); const two = await startTestCore({ settings: { maxConcurrentTurns: 1, perAccountConcurrency: 1 } });
  cores.push(one, two);
  const ownerOne = await one.connect(); const ownerTwo = await two.connect();
  const from = (await echoThread(one, ownerOne, 'Remote sender')).threadId;
  const to = (await echoThread(two, ownerTwo, 'Remote recipient')).threadId;
  const blocker = (await echoThread(two, ownerTwo, 'Blocker')).threadId;
  one.core.coordination.configure(from, { ...brief, remote: true });
  two.core.coordination.configure(to, { ...brief, remote: true });
  const cardOne = one.core.coordination.identity(), cardTwo = two.core.coordination.identity();
  one.core.coordination.trust(cardTwo); two.core.coordination.trust(cardOne);
  let release!: () => void;
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    if (ctx.thread.id !== blocker) throw new Error('only the blocker may start in this test');
    const done = new Promise<{ status: 'stopped'; sessionId: null; usage: null }>(resolve => { release = () => resolve({ status: 'stopped', sessionId: null, usage: null }); });
    return { done, stop: release };
  } }));
  two.core.threads.startTurn(blocker, 'Hold the account slot');
  await waitFor(() => two.core.threads.require(blocker).status === 'running');
  const destination: AgentAddress = two.core.coordination.get(to).self;
  const sent = await one.core.coordination.send({ threadId: from, to: destination, text: 'Remote work', requestId: crypto.randomUUID() });
  await waitFor(() => two.core.coordination.get(to).messages.find(message => message.id === sent.id)?.error === 'Queued for provider delivery', 12000);
  two.core.coordination.untrust(cardOne.coreId);
  expect(two.core.coordination.get(to).messages.find(message => message.id === sent.id)).toMatchObject({ status: 'rejected', error: 'Machine permission revoked' });
  expect(two.core.journal.listTurns(to).find(turn => turn.execution?.operation === 'coordination')?.status).toBe('stopped');
  release();
}, 20000);

test('shutdown stops a driver before waiting for an in-flight coordination steer', async () => {
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const from = (await echoThread(h, owner, 'Sender')).threadId;
  const to = (await echoThread(h, owner, 'Recipient')).threadId;
  h.core.coordination.configure(from, brief); h.core.coordination.configure(to, brief);
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    if (ctx.thread.id !== to) throw new Error('unexpected thread');
    let finish!: () => void;
    let settleSteer!: (submitted: boolean) => void;
    const done = new Promise<{ status: 'stopped'; sessionId: null; usage: null }>(resolve => { finish = () => resolve({ status: 'stopped', sessionId: null, usage: null }); });
    const steering = new Promise<boolean>(resolve => { settleSteer = resolve; });
    const stop = () => { settleSteer(false); finish(); };
    return { done, stop, steer: () => steering };
  } }));
  h.core.threads.startTurn(to, 'Running work');
  await waitFor(() => h.core.threads.canSteer(to));
  const letter = await h.core.coordination.send({ threadId: from, to: h.core.coordination.get(to).self, text: 'Steer now', requestId: crypto.randomUUID() });
  await waitFor(() => h.core.coordination.get(to).messages.find(message => message.id === letter.id)?.status === 'uncertain', 8000);
  await h.server.stop();
  await Promise.race([
    h.core.close(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('core close deadlocked behind coordination steer')), 2000)),
  ]);
}, 12000);

test('a graceful restart leaves a never-submitted queued message received and paused', async () => {
  const { h, to, letter } = await setupQueued();
  await h.server.stop();
  await h.core.close();
  const reopened = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    expect(reopened.coordination.get(to).config.paused).toBe(true);
    expect(reopened.coordination.get(to).messages.find(message => message.id === letter.id)).toMatchObject({ status: 'received', error: null });
  } finally { await reopened.close(); }
}, 12000);

test('crash recovery restores a coordination message whose turn never left the queue', async () => {
  const { h, to, letter } = await setupQueued();
  h.core.coordination.beginClose();
  h.core.threads.recoverStuckTurns();
  expect(h.core.coordination.get(to).messages.find(message => message.id === letter.id)).toMatchObject({ status: 'received', error: null });
}, 12000);

test('pausing in settings cancels an already queued wake', async () => {
  const { h, to, letter, stopBlocker } = await setupQueued();
  h.core.coordination.configure(to, { ...brief, paused: true });
  expect(h.core.coordination.get(to).messages.find(message => message.id === letter.id)?.status).toBe('received');
  expect(h.core.journal.listTurns(to)[0]?.status).toBe('stopped');
  stopBlocker();
}, 12000);

test('a queued wake rechecks expiry before sending anything to the provider', async () => {
  const { h, to, letter, stopBlocker } = await setupQueued();
  h.core.journal.db.query("UPDATE coordination_letters SET data = json_set(data, '$.expiresAt', ?) WHERE id = ?").run(Date.now() - 1, letter.id);
  stopBlocker();
  await waitFor(() => h.core.journal.listTurns(to)[0]?.status === 'stopped');
  expect(h.core.coordination.get(to).messages[0]?.status).toBe('received');
}, 12000);

test('a later successful wake never acknowledges a previous failed submission', async () => {
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const from = (await echoThread(h, owner, 'Sender')).threadId;
  const to = (await echoThread(h, owner, 'Recipient')).threadId;
  for (const id of [from, to]) h.core.coordination.configure(id, brief);
  let attempts = 0;
  restores.push(setDriver('echo', { protocol: 'echo', startTurn() {
    const status = ++attempts === 1 ? 'error' as const : 'done' as const;
    return { done: Promise.resolve({ status, sessionId: null, usage: null, error: status === 'error' ? 'lost provider' : undefined }), stop() {} };
  } }));
  const first = await h.core.coordination.send({ threadId: from, to: h.core.coordination.get(to).self, text: 'First attempt', requestId: 'first' });
  await waitFor(() => h.core.threads.require(to).status === 'error', 5000);
  h.core.coordination.configure(to, brief);
  await owner.call('threads.update', { threadId: to, title: 'Recipient' });
  // A user turn clears the provider error before coordination resumes.
  h.core.threads.startTurn(to, 'Continue');
  await waitFor(() => h.core.threads.require(to).status === 'idle');
  const second = await h.core.coordination.send({ threadId: from, to: h.core.coordination.get(to).self, text: 'New question', requestId: 'second' });
  await waitFor(() => h.core.coordination.get(to).messages.find(m => m.id === second.id)?.status === 'delivered', 5000);
  expect(h.core.coordination.get(to).messages.find(m => m.id === first.id)?.status).toBe('uncertain');
}, 12000);
