import { expect, mock, test } from 'bun:test';
import { getDriver, setDriver, writesTitles } from '../src/drivers/index.ts';
import { lazyDriver } from '../src/drivers/lazy.ts';
import type { Driver, ProbeContext, SideQuestionContext, TitleContext, TurnContext, TurnHandle, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';

const result: TurnResult = { status: 'done', sessionId: 'native-session', usage: null };
const context: TurnContext = {
  thread: {
    id: 'thread', projectId: 'project', title: 'Fixture', titleSource: 'user',
    providerId: 'fixture', accountId: 'account', model: 'default', effort: null,
    cwd: '/fixture', branch: null, permissionMode: 'default', status: 'running',
    unread: false, archived: false, pinned: false, sessionId: 'previous-session',
    load: null, context: null, createdAt: 1, updatedAt: 1,
  },
  account: { id: 'account', providerId: 'fixture', label: 'Fixture', isolationDir: null, status: 'ok', identity: null, createdAt: 1 },
  provider: {
    id: 'fixture', schemaVersion: 1, name: 'Fixture', shortName: 'Fixture', protocol: 'claude-sdk',
    roots: [], profiles: {}, auth: { kind: 'none' }, models: [{ id: 'default', name: 'Default' }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: true, resume: true },
  },
  turn: { id: 'turn', threadId: 'thread', status: 'running', queuedAt: 1, startedAt: 1, finishedAt: null, usage: null, error: null },
  prompt: 'Fixture prompt', attachments: [], sessionId: 'previous-session', accountEnv: {}, warmProcessMinutes: 5,
  emit: { startMessage: () => 'message', delta() {}, part() {}, complete() {} },
  log() {}, commands() {}, context() {},
  requestPermission() { throw new Error('Unexpected permission request'); },
  askQuestion() { throw new Error('Unexpected question'); },
  spawn() { throw new Error('Unexpected process'); },
  spawnChild() { throw new Error('Unexpected child process'); },
};
const title: TitleContext = { ...context, prompt: 'Title prompt', answer: 'Fixture answer', model: null };
const probe: ProbeContext = { ...context, accountId: 'account', cwd: '/fixture', killTree() {} };
const side = (signal = new AbortController().signal): SideQuestionContext => ({ ...context, question: 'Side question', signal });

function fixture(overrides: Partial<Driver> = {}): Driver {
  return { protocol: 'claude-sdk', startTurn: mock(() => ({ done: Promise.resolve(result), stop: mock() })), ...overrides };
}

test('registered protocols retain their capabilities before the first module load', () => {
  expect(writesTitles('claude-sdk')).toBe(true);
  expect(writesTitles('codex-appserver')).toBe(true);
  expect(writesTitles('acp')).toBe(false);
  expect(getDriver('claude-sdk').sideQuestion).toBeFunction();
  expect(getDriver('claude-sdk').prepare).toBeFunction();
  expect(getDriver('acp').sideQuestion).toBeUndefined();
  expect(getDriver('acp').prepare).toBeUndefined();
});

test('viewed state, cache reads, invalidation, release and shutdown keep a cold module unloaded', () => {
  const load = mock(async () => fixture());
  const driver = lazyDriver('claude-sdk', load, { titles: true, prepare: true, sideQuestion: true });
  driver.setViewed?.('thread', true);
  driver.setViewed?.('thread', false);
  expect(driver.probedModels?.('fixture', 'account')).toBeNull();
  driver.forgetProbes?.({ accountId: 'account' });
  driver.releaseThread?.('thread');
  driver.shutdown?.();
  expect(load).not.toHaveBeenCalled();
});

test('concurrent first turns, title, side question, preparation and probe share one driver', async () => {
  const gate = Promise.withResolvers<Driver>();
  const load = mock(() => gate.promise);
  const inner = fixture({
    title: mock(async () => 'Title'), sideQuestion: mock(async () => 'Side answer'),
    prepare: mock(async () => undefined), setViewed: mock(),
    probe: mock(async () => ({ models: context.provider.models, probedAt: 1 })),
  });
  const driver = lazyDriver('claude-sdk', load, { titles: true, prepare: true, sideQuestion: true });
  driver.setViewed?.('thread', true);
  const first = driver.startTurn(context);
  const second = driver.startTurn({ ...context, thread: { ...context.thread, id: 'second' } });
  const operations = [driver.title!(title), driver.sideQuestion!(side()), driver.prepare!(context), driver.probe!(probe)];
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  gate.resolve(inner);
  expect(await Promise.all([first.done, second.done, ...operations])).toEqual([
    result, result, 'Title', 'Side answer', undefined, { models: context.provider.models, probedAt: 1 },
  ]);
  expect(inner.startTurn).toHaveBeenCalledTimes(2);
  expect(inner.title).toHaveBeenCalledWith(title);
  expect(inner.sideQuestion).toHaveBeenCalledWith(expect.objectContaining({ question: 'Side question' }));
  expect(inner.prepare).toHaveBeenCalledWith(context);
  expect(inner.setViewed).toHaveBeenCalledWith('thread', true);
});

for (const synchronous of [false, true]) test(`concurrent ${synchronous ? 'synchronous' : 'asynchronous'} import failure reaches every caller and the next request retries`, async () => {
  const failure = new Error('Import failed');
  let attempts = 0;
  const load = mock(() => {
    if (++attempts === 1) {
      if (synchronous) throw failure;
      return Promise.reject(failure);
    }
    return Promise.resolve(fixture());
  });
  const driver = lazyDriver('claude-sdk', load, { titles: true });
  const outcomes = await Promise.allSettled([driver.startTurn(context).done, driver.title!(title), driver.probe!(probe)]);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.reason).toBe(failure);
  }
  expect(load).toHaveBeenCalledTimes(1);
  expect(await driver.startTurn(context).done).toEqual(result);
  expect(load).toHaveBeenCalledTimes(2);
});

test('a stopped pending turn settles immediately and never starts after the import resolves', async () => {
  const gate = Promise.withResolvers<Driver>();
  const inner = fixture();
  const driver = lazyDriver('claude-sdk', () => gate.promise);
  const handle = driver.startTurn(context);
  handle.stop();
  handle.stop();
  expect(await handle.done).toEqual({ status: 'stopped', sessionId: 'previous-session', usage: null });
  gate.resolve(inner);
  await driver.probe!(probe);
  expect(inner.startTurn).not.toHaveBeenCalled();
  expect(await driver.startTurn(context).done).toEqual(result);
});

test('a released pending thread cannot resurrect its turn or preparation while another thread continues', async () => {
  const gate = Promise.withResolvers<Driver>();
  const inner = fixture({ prepare: mock(async () => undefined), setViewed: mock(), releaseThread: mock() });
  const driver = lazyDriver('claude-sdk', () => gate.promise, { prepare: true });
  driver.setViewed?.('thread', true);
  const turn = driver.startTurn(context);
  const prepared = driver.prepare!(context);
  const other = driver.startTurn({ ...context, thread: { ...context.thread, id: 'other' } });
  driver.releaseThread?.('thread');
  driver.setViewed?.('thread', true);
  const replacementPreparation = driver.prepare!(context);
  expect(await turn.done).toMatchObject({ status: 'stopped' });
  await prepared;
  gate.resolve(inner);
  await Promise.all([other.done, replacementPreparation]);
  expect(inner.startTurn).toHaveBeenCalledTimes(1);
  expect(inner.startTurn).toHaveBeenCalledWith(expect.objectContaining({ thread: expect.objectContaining({ id: 'other' }) }));
  expect(inner.prepare).toHaveBeenCalledTimes(1);
});

test('a stop issued synchronously by native startup reaches the handle once it is returned', async () => {
  const done = Promise.withResolvers<TurnResult>();
  const stop = mock(() => done.resolve({ status: 'stopped', sessionId: null, usage: null }));
  let handle: TurnHandle;
  const driver = lazyDriver('claude-sdk', async () => fixture({ startTurn() {
    handle.stop();
    return { done: done.promise, stop };
  } }));
  handle = driver.startTurn(context);
  expect(await handle.done).toMatchObject({ status: 'stopped' });
  expect(stop).toHaveBeenCalledTimes(1);
});

test('shutdown cancels pending work before loading and a new core can reuse the completed module', async () => {
  const gate = Promise.withResolvers<Driver>();
  const events: string[] = [];
  const inner = fixture({
    startTurn: mock(() => { events.push('turn'); return { done: Promise.resolve(result), stop() {} }; }),
    shutdown: mock(() => { events.push('shutdown'); }),
    prepare: mock(async () => { events.push('prepare'); }),
    title: mock(async () => 'Title'), sideQuestion: mock(async () => 'Side answer'),
    setViewed: mock((id, viewed) => { events.push(`${id}:${viewed}`); }),
  });
  const load = mock(() => gate.promise);
  const driver = lazyDriver('claude-sdk', load, { titles: true, prepare: true, sideQuestion: true });
  driver.setViewed?.('thread', true);
  const turn = driver.startTurn(context);
  const prepared = driver.prepare!(context);
  const titled = driver.title!(title);
  const questioned = driver.sideQuestion!(side());
  const probed = driver.probe!(probe);
  const rejected = Promise.allSettled([questioned, probed]);
  driver.shutdown?.();
  expect(await turn.done).toMatchObject({ status: 'stopped' });
  expect(await prepared).toBeUndefined();
  expect(await titled).toBeNull();
  expect((await rejected).every(outcome => outcome.status === 'rejected' && outcome.reason.name === 'AbortError')).toBe(true);
  driver.setViewed?.('replacement', true);
  const replacement = driver.startTurn({ ...context, thread: { ...context.thread, id: 'replacement' } });
  gate.resolve(inner);
  expect(await replacement.done).toEqual(result);
  expect(events).toEqual(['shutdown', 'replacement:true', 'turn']);
  expect(load).toHaveBeenCalledTimes(1);
  expect(inner.prepare).not.toHaveBeenCalled();
  expect(inner.title).not.toHaveBeenCalled();
  expect(inner.sideQuestion).not.toHaveBeenCalled();
});

test('loading preserves permission changes and both steering methods, including receiver, attachments and rejection', async () => {
  const gate = Promise.withResolvers<Driver>();
  const done = Promise.withResolvers<TurnResult>();
  const failure = new Error('Uncertain steering dispatch');
  const innerHandle: TurnHandle = {
    done: done.promise,
    stop: mock(() => done.resolve(result)),
    setPermissionMode: mock(async function(this: TurnHandle, mode) { expect(this).toBe(innerHandle); return mode === 'plan'; }),
    steer: mock(async function(this: TurnHandle) { expect(this).toBe(innerHandle); throw failure; }),
    steerUser: mock(async function(this: TurnHandle) { expect(this).toBe(innerHandle); return true; }),
  };
  const inner = fixture({ startTurn: mock(() => innerHandle) });
  const driver = lazyDriver('claude-sdk', () => gate.promise);
  const handle = driver.startTurn(context);
  expect(handle.steer).toBeUndefined();
  gate.resolve(inner);
  await driver.probe!(probe);
  const attachments = [{ kind: 'image' as const, mimeType: 'image/png' as const, data: 'fixture', name: null }];
  expect(await handle.setPermissionMode!('plan')).toBe(true);
  expect(await handle.setPermissionMode!('default')).toBe(false);
  await expect(handle.steer!('coordination', attachments)).rejects.toBe(failure);
  expect(innerHandle.steer).toHaveBeenCalledTimes(1);
  expect(await handle.steerUser!('user input', attachments)).toBe(true);
  expect(innerHandle.steerUser).toHaveBeenCalledWith('user input', attachments);
  handle.stop();
  expect(await handle.done).toEqual(result);
  expect(innerHandle.stop).toHaveBeenCalledTimes(1);
  expect(driver.startTurn(context)).toBe(innerHandle);
});

test('unsupported turn methods remain absent after loading', async () => {
  const driver = lazyDriver('acp', async () => fixture());
  const handle = driver.startTurn(context);
  await handle.done;
  expect(handle.setPermissionMode).toBeUndefined();
  expect(handle.steer).toBeUndefined();
  expect(handle.steerUser).toBeUndefined();
});

test('a permission change while the module is loading restarts only the pending attempt with the new mode', async () => {
  const harness = await startTestCore();
  const gate = Promise.withResolvers<Driver>();
  const load = mock(() => gate.promise);
  const seen: TurnContext[] = [];
  const restore = setDriver('echo', lazyDriver('echo', load));
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const turn = await client.call('turns.start', { threadId, prompt: 'Keep the pending permissions current' });
    await waitFor(() => load.mock.calls.length === 1);
    const previous = harness.core.threads.runner.handles.get(threadId);
    await client.call('threads.update', { threadId, permissionMode: 'plan' });
    await waitFor(() => {
      const current = harness.core.threads.runner.handles.get(threadId);
      return current !== undefined && current !== previous;
    });
    gate.resolve(fixture({ startTurn(ctx) { seen.push(ctx); return { done: Promise.resolve(result), stop() {} }; } }));
    await waitFor(() => harness.core.journal.getTurn(turn.id)?.status === 'done');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.thread.permissionMode).toBe('plan');
    expect(seen[0]!.turn.execution?.permissionMode).toBe('plan');
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve(fixture());
    restore();
    await harness.stop();
  }
});

test('a view removed during loading is not pinned or prepared and release forwards the removal when loaded', async () => {
  const gate = Promise.withResolvers<Driver>();
  const inner = fixture({ setViewed: mock(), prepare: mock(async () => undefined), releaseThread: mock() });
  const driver = lazyDriver('claude-sdk', () => gate.promise, { prepare: true });
  driver.setViewed?.('thread', true);
  const prepared = driver.prepare!(context);
  driver.setViewed?.('thread', false);
  gate.resolve(inner);
  await prepared;
  expect(inner.prepare).not.toHaveBeenCalled();
  expect(inner.setViewed).not.toHaveBeenCalled();
  driver.setViewed?.('thread', true);
  driver.releaseThread?.('thread');
  expect(inner.setViewed).toHaveBeenLastCalledWith('thread', false);
  expect(inner.releaseThread).toHaveBeenCalledWith('thread');
  driver.shutdown?.();
});

for (const beforeLoading of [false, true]) test(`a side question aborted ${beforeLoading ? 'before' : 'during'} module loading never reaches the native query`, async () => {
  const gate = Promise.withResolvers<Driver>();
  const inner = fixture({ sideQuestion: mock(async () => 'Side answer') });
  const load = mock(() => gate.promise);
  const driver = lazyDriver('claude-sdk', load, { sideQuestion: true });
  const abort = new AbortController();
  if (beforeLoading) abort.abort();
  const answer = driver.sideQuestion!(side(abort.signal));
  abort.abort();
  await expect(answer).rejects.toHaveProperty('name', 'AbortError');
  if (beforeLoading) expect(load).not.toHaveBeenCalled();
  gate.resolve(inner);
  await driver.probe!(probe);
  expect(inner.sideQuestion).not.toHaveBeenCalled();
});

test('probe invalidation during module loading rejects only the matching account and cache methods forward afterward', async () => {
  const gate = Promise.withResolvers<Driver>();
  const reading = { models: context.provider.models, probedAt: 1 };
  const inner = fixture({
    probe: mock(async () => reading), probedModels: mock(() => reading.models), forgetProbes: mock(), shutdown: mock(),
  });
  const driver = lazyDriver('claude-sdk', () => gate.promise);
  const stale = driver.probe!(probe);
  const other = driver.probe!({ ...probe, accountId: 'other' });
  driver.forgetProbes?.({ providerId: 'unrelated' });
  driver.forgetProbes?.({ providerId: 'fixture', accountId: 'account' });
  await expect(stale).rejects.toHaveProperty('name', 'AbortError');
  gate.resolve(inner);
  expect(await other).toEqual(reading);
  expect(inner.probe).toHaveBeenCalledTimes(1);
  expect(driver.probedModels?.('fixture', 'other')).toEqual(reading.models);
  expect(inner.probedModels).toHaveBeenCalledWith('fixture', 'other');
  driver.forgetProbes?.({ accountId: 'other' });
  expect(inner.forgetProbes).toHaveBeenCalledWith({ accountId: 'other' });
  driver.shutdown?.();
  expect(inner.shutdown).toHaveBeenCalledTimes(1);
});
