import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAddress, AgentLetter, CoordinationConfig } from '@boite/contracts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import { refused } from '../src/errors.ts';
import { holdAccountTurns, echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const core of cores.splice(0)) await core.stop();
});

const brief: CoordinationConfig = { mode: 'brief', resources: '', remote: false, paused: false };

async function setupQueued(texts = ['Coordinate later']) {
  const h = await startTestCore();
  cores.push(h);
  const owner = await h.connect();
  const from = (await echoThread(h, owner, 'Sender')).threadId;
  const to = (await echoThread(h, owner, 'Recipient')).threadId;
  const blocker = (await echoThread(h, owner, 'Blocker')).threadId;
  h.core.coordination.configure(from, brief);
  h.core.coordination.configure(to, { ...brief, paused: true });
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
  h.core.threads.startTurn(blocker, 'Keep existing work running');
  const releaseAdmission = holdAccountTurns(h);
  await waitFor(() => h.core.threads.require(blocker).status === 'running');
  const destination = h.core.coordination.get(to).self;
  const letters: AgentLetter[] = [];
  for (const text of texts) letters.push(await h.core.coordination.send({ threadId: from, to: destination, text, requestId: crypto.randomUUID() }));
  const letter = letters[0]!;
  h.core.coordination.configure(to, brief);
  await waitFor(() => h.core.coordination.get(to).messages.find(message => message.id === letter.id)?.error === 'Queued for provider delivery', 8000);
  return { h, owner, from, to, blocker, letter, letters, stopBlocker, releaseAdmission };
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

for (const phase of ['queued', 'claimed'] as const) test(`stopping a ${phase} wake commits its terminal state and entire inbox batch together`, async () => {
  const { h, to, letters } = await setupQueued(['First letter', 'Second letter']);
  const turn = h.core.journal.listTurns(to)[0]!;
  if (phase === 'claimed') expect(h.core.coordination.prepareWake(to, turn.id)).toBe(true);
  h.core.coordination.beginClose();
  const marker = phase === 'queued' ? 'Queued for provider delivery' : `Awaiting provider turn ${turn.id}`;
  const inbox = () => h.core.coordination.get(to).messages.filter(entry => letters.some(letter => letter.id === entry.id));
  expect(inbox().map(entry => entry.error)).toEqual([marker, marker]);

  const events: string[] = [];
  const finishedInboxes: string[][] = [];
  restores.push(h.core.bus.onCommitted((name, payload) => {
    if (!('threadId' in payload) || payload.threadId !== to) return;
    if (name === 'turn.finished' || name === 'thread.updated' || name === 'collaboration.changed') events.push(name);
    if (name === 'turn.finished') finishedInboxes.push(inbox().map(entry => entry.status));
  }));
  const desk = h.core.coordination as unknown as { update(letter: AgentLetter, status: string, error?: string): void };
  const original = desk.update.bind(desk);
  let returned = 0;
  const update = spyOn(desk, 'update').mockImplementation((entry, status, error) => {
    original(entry, status, error);
    if (status === 'received' && ++returned === 2) throw new Error('second inbox write failed');
  });
  restores.push(() => update.mockRestore());

  expect(() => h.core.scheduler.stop(to)).toThrow('second inbox write failed');
  expect(returned).toBe(2);
  expect(h.core.journal.getTurn(turn.id)).toMatchObject({ status: 'queued', startedAt: null, finishedAt: null });
  expect(h.core.threads.require(to).status).toBe('queued');
  expect(inbox().map(entry => ({ status: entry.status, error: entry.error }))).toEqual([
    { status: 'uncertain', error: marker }, { status: 'uncertain', error: marker },
  ]);
  expect(events).toEqual([]);

  update.mockRestore();
  expect(h.core.scheduler.stop(to)).toBe(true);
  expect(h.core.journal.getTurn(turn.id)).toMatchObject({ status: 'stopped', startedAt: null });
  expect(h.core.threads.require(to).status).toBe('idle');
  expect(inbox().map(entry => ({ status: entry.status, error: entry.error }))).toEqual([
    { status: 'received', error: null }, { status: 'received', error: null },
  ]);
  expect(finishedInboxes).toEqual([['received', 'received']]);
  await h.server.stop();
  await h.core.close();
  const reopened = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    expect(reopened.journal.getTurn(turn.id)).toMatchObject({ status: 'stopped', startedAt: null });
    expect(reopened.coordination.get(to).messages.map(entry => ({ status: entry.status, error: entry.error }))).toEqual([
      { status: 'received', error: null }, { status: 'received', error: null },
    ]);
  } finally { await reopened.close(); }
}, 12000);

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
  const one = await startTestCore(); const two = await startTestCore();
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
  two.core.threads.startTurn(blocker, 'Keep existing work running');
  holdAccountTurns(two);
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

for (const outcome of ['shutdown', 'late-resolution', 'late-rejection'] as const) test(`shutdown releases a completed warm turn with ${outcome} steering acknowledgement`, async () => {
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const from = (await echoThread(h, owner, 'Sender')).threadId;
  const to = (await echoThread(h, owner, 'Recipient')).threadId;
  h.core.coordination.configure(from, brief); h.core.coordination.configure(to, brief);
  let finish!: () => void;
  let acknowledge!: (submitted: boolean) => void;
  let rejectSteer!: (error: Error) => void;
  let shutdowns = 0;
  restores.push(setDriver('echo', { protocol: 'echo', startTurn() {
    const done = new Promise<{ status: 'done'; sessionId: null; usage: null }>(resolve => { finish = () => resolve({ status: 'done', sessionId: null, usage: null }); });
    const steering = new Promise<boolean>((resolve, reject) => { acknowledge = resolve; rejectSteer = reject; });
    return { done, stop() {}, steer: () => steering };
  }, shutdown() { shutdowns += 1; if (outcome === 'shutdown') acknowledge(true); } }));
  let closing: Promise<void> | undefined;
  try {
    h.core.threads.startTurn(to, 'Warm running work');
    await waitFor(() => h.core.threads.canSteer(to));
    const letter = await h.core.coordination.send({ threadId: from, to: h.core.coordination.get(to).self, text: 'Missing acknowledgement', requestId: 'completed-warm' });
    await waitFor(() => h.core.coordination.get(to).messages.find(message => message.id === letter.id)?.status === 'uncertain');
    finish();
    await waitFor(() => h.core.threads.require(to).status === 'idle');
    await h.server.stop();
    closing = h.core.close();
    // The acknowledgement stays pending until close has settled, so settling at all is the proof.
    // The deadline only turns a close that waits on it forever into a readable failure: close's own
    // work is bounded but not fast. A WAL checkpoint in the journal's close blocks the loop for up to
    // 335 ms on a loaded desktop and the native Workers each get a 1 s fallback, so a 500 ms race
    // failed on Windows runners while nothing waited on the acknowledgement.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closing,
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('core close waited on the steering acknowledgement')), 5000); }),
    ]).finally(() => clearTimeout(deadline));
    expect(shutdowns).toBe(1);
    expect(h.core.journal.isClosed()).toBe(true);
    if (outcome === 'late-resolution') acknowledge(true);
    else if (outcome === 'late-rejection') rejectSteer(new Error('synthetic acknowledgement failure after journal close'));
    await Bun.sleep(0);
    const reopened = new Core({ dataDir: h.dataDir, token: h.token });
    try {
      expect(reopened.coordination.get(to).messages.find(message => message.id === letter.id)).toMatchObject({ status: 'uncertain', error: 'Awaiting provider acknowledgement' });
      expect(reopened.scheduler.state().queued).toHaveLength(0);
    } finally { await reopened.close(); }
  } finally {
    acknowledge?.(false);
    finish?.();
    await closing;
  }
}, 10000);

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

for (const phase of ['queued', 'claimed'] as const) test(`crash recovery restores the batch of a ${phase} coordination wake that never reached its provider`, async () => {
  const { h, to, letters } = await setupQueued(['First letter', 'Second letter']);
  const turn = h.core.journal.listTurns(to)[0]!;
  if (phase === 'claimed') expect(h.core.coordination.prepareWake(to, turn.id)).toBe(true);
  h.core.coordination.beginClose();
  h.core.threads.recoverStuckTurns();
  for (const letter of letters) expect(h.core.coordination.get(to).messages.find(message => message.id === letter.id)).toMatchObject({ status: 'received', error: null });
}, 12000);

test('pausing in settings cancels an already queued wake', async () => {
  const { h, to, letter, stopBlocker } = await setupQueued();
  h.core.coordination.configure(to, { ...brief, paused: true });
  expect(h.core.coordination.get(to).messages.find(message => message.id === letter.id)?.status).toBe('received');
  expect(h.core.journal.listTurns(to)[0]?.status).toBe('stopped');
  stopBlocker();
}, 12000);

test('a queued wake whose protection refuses at the provider boundary stops and puts its letters back', async () => {
  const { h, to, letter, stopBlocker, releaseAdmission } = await setupQueued();
  const turnId = h.core.journal.listTurns(to)[0]!.id;
  const prepare = spyOn(h.core.coordination, 'prepareWake').mockImplementationOnce(() => { throw refused('this route cannot protect the letter'); });
  // The letter's status the moment the stopped wake gives it back, before any later delivery takes it again.
  const statuses: (string | undefined)[] = [];
  const restore = h.core.coordination.queuedCancelled.bind(h.core.coordination);
  const cancelled = spyOn(h.core.coordination, 'queuedCancelled').mockImplementation((threadId, turn) => {
    restore(threadId, turn);
    statuses.push(h.core.coordination.get(to).messages.find(message => message.id === letter.id)?.status);
  });
  // The refusal is an ordinary stop: the scheduler's run of the turn ends without an error.
  let ran: Promise<void> | undefined;
  const run = h.core.threads.runTurn.bind(h.core.threads);
  const runs = spyOn(h.core.threads, 'runTurn').mockImplementation((id, threadId) => {
    const result = run(id, threadId);
    if (id === turnId) ran = result;
    return result;
  });
  restores.push(() => { prepare.mockRestore(); cancelled.mockRestore(); runs.mockRestore(); });
  stopBlocker();
  releaseAdmission();
  await waitFor(() => h.core.journal.getTurn(turnId)?.status === 'stopped', 8000);
  expect(statuses).toEqual(['received']);
  expect(await ran!.then(() => 'resolved', () => 'rejected')).toBe('resolved');
}, 12000);

test('a wake that faults after claiming part of its batch puts the claimed letters back too', async () => {
  const { h, to, letter, stopBlocker, releaseAdmission } = await setupQueued();
  const turnId = h.core.journal.listTurns(to)[0]!.id;
  const desk = h.core.coordination as unknown as { update(letter: AgentLetter, status: string, error?: string): void };
  const original = desk.update.bind(desk);
  let faulted = false;
  // The batch's first letter is claimed for the turn, then the journal fails before the rest.
  const update = spyOn(desk, 'update').mockImplementation((entry, status, error) => {
    original(entry, status, error);
    if (!faulted && error?.startsWith('Awaiting provider turn')) { faulted = true; throw new Error('journal write failed'); }
  });
  // As above: the status at the moment the stopped wake gives the batch back, before a later wake claims it again.
  const statuses: (string | undefined)[] = [];
  const restore = h.core.coordination.queuedCancelled.bind(h.core.coordination);
  const cancelled = spyOn(h.core.coordination, 'queuedCancelled').mockImplementation((threadId, turn) => {
    restore(threadId, turn);
    statuses.push(h.core.coordination.get(to).messages.find(message => message.id === letter.id)?.status);
  });
  restores.push(() => { update.mockRestore(); cancelled.mockRestore(); });
  stopBlocker();
  releaseAdmission();
  await waitFor(() => h.core.journal.getTurn(turnId)?.status === 'stopped', 8000);
  expect(faulted).toBe(true);
  expect(statuses).toEqual(['received']);
}, 12000);

test('a queued wake rechecks expiry before sending anything to the provider', async () => {
  const { h, to, letter, stopBlocker, releaseAdmission } = await setupQueued();
  const projectId = h.core.threads.require(to).projectId!;
  h.core.projects.archive(projectId, true);
  h.core.journal.db.query("UPDATE coordination_letters SET data = json_set(data, '$.expiresAt', ?) WHERE id = ?").run(Date.now() - 1, letter.id);
  stopBlocker();
  releaseAdmission();
  await waitFor(() => h.core.journal.listTurns(to)[0]?.status === 'stopped');
  expect(h.core.coordination.get(to).messages[0]?.status).toBe('received');
  expect(h.core.journal.getProject(projectId)?.archived).toBe(true);
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
