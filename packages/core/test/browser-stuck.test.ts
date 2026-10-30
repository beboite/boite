import { afterEach, beforeEach, expect, test } from 'bun:test';
import { connect, type CoreClient } from '../src/client.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

// A desktop app that hosts the agent browser and never answers it: the open
// waits on its start, as a lost bridge reply would leave it. No Chromium runs.
let harness: TestCore, owner: CoreClient, agent: CoreClient, app: CoreClient, threadId: string;
let problems: { level: string; message: string; event: unknown; data: unknown }[];

beforeEach(async () => {
  harness = await startTestCore();
  problems = [];
  const record = harness.core.logs.record.bind(harness.core.logs);
  harness.core.logs.record = (level, message, context = {}, at) => {
    if (level === 'warn' || level === 'error') problems.push({ level, message, event: context.event, data: context.data });
    record(level, message, context, at);
  };
  owner = await harness.connect();
  ({ threadId } = await echoThread(harness, owner));
  agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
  app = await connect(harness.url, harness.token, { client: { name: 'shell', version: 'test' } });
  await app.call('browser.hostAttach', {});
});

afterEach(async () => {
  app.close(); agent.close(); owner.close();
  await harness.stop();
});

/** What `promise` settles to within `ms`, or `'pending'`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<'pending'>(resolve => { timer = setTimeout(() => resolve('pending'), ms); })]); }
  finally { clearTimeout(timer); }
}

test('status answers while a command of its conversation is stuck, and names that command', async () => {
  const opening = agent.call('browser.command', { threadId, action: { kind: 'open', url: 'http://127.0.0.1:1/' } }).catch((error: unknown) => error);
  await Bun.sleep(100);
  const status = await within(agent.call('browser.command', { threadId, action: { kind: 'status' } }), 2000);
  expect(status).not.toBe('pending');
  const value = (status as { value: { hosted: boolean; tabs: unknown[]; blocking?: { action: string; step: string; startedAt: number } } }).value;
  expect(value.hosted).toBe(true);
  expect(value.tabs).toEqual([]);
  expect(value.blocking).toMatchObject({ action: 'open', step: 'start' });
  expect(Date.now() - value.blocking!.startedAt).toBeLessThan(5000);
  // The owner's status goes past the queue too.
  expect(await within(owner.call('browser.command', { threadId, action: { kind: 'status' } }), 2000)).not.toBe('pending');
  // A caller that leaves while its command waits its turn: the command never runs.
  const leaving = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
  const left = leaving.call('browser.command', { threadId, action: { kind: 'profile-add', name: 'Left' } }).catch((error: unknown) => error);
  await Bun.sleep(100);
  leaving.close();
  await left;
  app.close();
  await opening;
  await agent.call('browser.command', { threadId, action: { kind: 'profile-add', name: 'Stayed' } });
  expect((harness.core.settings.get().browserProfiles ?? []).map(profile => profile.name)).toEqual(['Stayed']);
}, 15_000);

test('a step that passes its bound fails its command with the step named, logs who waited, and lets the next command run', async () => {
  harness.core.browser.stepMs = { ...harness.core.browser.stepMs, start: 300 };
  const at = Date.now();
  const failed = await within(thrown(agent.call('browser.command', { threadId, action: { kind: 'open', url: 'http://127.0.0.1:1/' } })), 5000);
  expect(failed).not.toBe('pending');
  expect(failed as () => void).toThrow(/browser open .*start step.*0\.3 s/);
  expect(Date.now() - at).toBeLessThan(3000);
  const problem = problems.find(entry => entry.event === 'browser.command-stalled');
  expect(problem?.level).toBe('warn');
  expect(problem?.message).toContain(threadId);
  expect(problem?.data).toMatchObject({ action: 'open', step: 'start' });
  // The chain moved on: the next command runs, and nothing blocks it any more.
  const next = await within(agent.call('browser.command', { threadId, action: { kind: 'profile-add', name: 'Work' } }), 2000);
  expect(next).toMatchObject({ value: { name: 'Work', created: true } });
  const after = (await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as { blocking?: unknown };
  expect(after.blocking).toBeUndefined();
}, 15_000);
