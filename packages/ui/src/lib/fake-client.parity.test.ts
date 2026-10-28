import { afterEach, expect, test } from 'vitest';
import { RpcErrorCode, type RpcEventName } from '@boite/contracts';
import { FakeClient } from './fake-client';

/*
 * The core's rules the shared contract scenarios cannot reach from both
 * sides: a shell to close, a login to cancel, a second retitle racing the
 * first, a device that must not hear owner events. Each mirrors what the
 * core does, named beside the test.
 */

const clients: FakeClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function fake(options: ConstructorParameters<typeof FakeClient>[0] = {}): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0, ...options });
  clients.push(client);
  await client.connect();
  return client;
}

function heard(client: FakeClient, names: RpcEventName[]): string[] {
  const lines: string[] = [];
  for (const name of names) client.on(name, (payload) => lines.push(`${name} ${JSON.stringify(payload)}`));
  return lines;
}

async function code(call: Promise<unknown>): Promise<number | 'answered'> {
  try {
    await call;
    return 'answered';
  } catch (error) {
    return (error as { code: number }).code;
  }
}

test('a second retitle while the first is writing is refused, as threads/retitle.ts', async () => {
  const client = await fake();
  const [first, second] = await Promise.allSettled([
    client.call('threads.retitle', { threadId: 't-trace' }),
    client.call('threads.retitle', { threadId: 't-trace' }),
  ]);
  expect(first.status).toBe('fulfilled');
  expect(second.status === 'rejected' && (second.reason as { code: number }).code).toBe(RpcErrorCode.Refused);
  // Once it is written, the next ask goes through.
  expect(await code(client.call('threads.retitle', { threadId: 't-trace' }))).toBe('answered');
});

test('a first-turn title reaches the client while the answer is still running', async () => {
  const client = await fake({ delayMs: 100, chunkSize: 16 });
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
  const titled = new Promise<void>(resolve => client.on('thread.updated', summary => {
    if (summary.id === thread.id && summary.titleSource === 'agent') resolve();
  }));
  await client.call('turns.start', { threadId: thread.id, prompt: 'fix the scheduler in the core' });
  await titled;
  expect(await client.call('threads.get', { threadId: thread.id })).toMatchObject({
    title: 'Echo: fix the scheduler in the', status: 'running', titleState: { needsRefinement: false },
  });
  await client.call('turns.stop', { threadId: thread.id });
});

test('a same-text rename during regeneration is protected in the fake client too', async () => {
  const client = await fake();
  const before = await client.call('threads.get', { threadId: 't-trace' });
  const writing = client.call('threads.retitle', { threadId: before.id });
  await client.call('threads.update', { threadId: before.id, title: before.title });
  expect(await writing).toMatchObject({ title: before.title, titleSource: 'user', titleState: { needsRefinement: false } });
});

test('archiving a thread closes its shell, as threads.ts archive', async () => {
  const client = await fake();
  const shell = await client.call('terminals.open', { threadId: 't-trace', cols: 80, rows: 24 });
  const events = heard(client, ['terminal.exited']);
  await client.call('threads.archive', { threadId: 't-trace', archived: true });
  expect(events).toEqual([`terminal.exited ${JSON.stringify({ id: shell.id, exitCode: 0 })}`]);
  expect(await code(client.call('terminals.write', { id: shell.id, data: 'dir\r' }))).toBe(RpcErrorCode.NotFound);
});

test('removing a project closes the shells of its threads, as projects.ts remove', async () => {
  const client = await fake();
  const project = await client.call('projects.add', { path: 'C:\\Users\\you\\shells' });
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: 'a-echo' });
  const shell = await client.call('terminals.open', { threadId: thread.id, cols: 80, rows: 24 });
  const events = heard(client, ['terminal.exited']);
  await client.call('projects.remove', { projectId: project.id });
  expect(events).toEqual([`terminal.exited ${JSON.stringify({ id: shell.id, exitCode: 0 })}`]);
  expect(await code(client.call('terminals.write', { id: shell.id, data: 'dir\r' }))).toBe(RpcErrorCode.NotFound);
});

test('a cancelled login fails, closes its terminal without signing in, and is read again, as accounts.ts loginCancel', async () => {
  const client = await fake();
  const account = await client.call('accounts.add', { providerId: 'opencode', label: 'Work', useDefaultLocation: false });
  expect(account.status).toBe('unauthenticated');
  const terminal = await client.call('accounts.loginTerminal', { accountId: account.id, cols: 80, rows: 24 });
  // The core refuses a second sign-in while the terminal one is open.
  expect(await code(client.call('accounts.login', { accountId: account.id }))).toBe(RpcErrorCode.Refused);
  const events = heard(client, ['terminal.exited', 'accounts.updated']);
  await client.call('accounts.loginCancel', { accountId: account.id });
  expect(events).toEqual([`terminal.exited ${JSON.stringify({ id: terminal.id, exitCode: 1 })}`]);
  expect((await client.call('accounts.list', {})).find((entry) => entry.id === account.id)?.status).toBe('unauthenticated');

  // A login run by Boite ends as failed with its exit code, then the account is read again.
  const logins = heard(client, ['account.login']);
  await client.call('accounts.login', { accountId: account.id });
  await client.call('accounts.loginCancel', { accountId: account.id });
  const states = logins.map((line) => JSON.parse(line.slice('account.login '.length)) as { state: string; exitCode: number | null });
  expect(states.every((event, index) => (index === states.length - 1 ? event.state === 'failed' && event.exitCode === 1 : event.state === 'running'))).toBe(true);
  expect(events.at(-1)).toContain('"status":"unauthenticated"');
  expect(await client.call('accounts.logins', {})).toEqual([]);
});

test('a paired device hears only the device events, as access.ts mayReceiveEvent', async () => {
  const owner = await fake();
  const phone = await fake({ principal: 'session' });
  const ownerLog = heard(owner, ['core.log']);
  const phoneLog = heard(phone, ['core.log', 'thread.load']);
  owner.emitCoreLog('error', 'scheduler failed');
  phone.emitCoreLog('error', 'scheduler failed');
  phone.sampleLoad('t-trace');
  expect(ownerLog).toHaveLength(1);
  expect(phoneLog.map((line) => line.split(' ')[0])).toEqual(['thread.load']);
});

test('an agent reaches only its own methods on its own thread and hears only its events, as access.ts assertAllowed', async () => {
  const client = await fake();
  const before = await client.call('settings.get', {});
  client.becomes('agent', 't-trace');
  const log = heard(client, ['thread.load']);
  // The owner's methods, which the fake once let an agent call.
  await expect(client.call('settings.set', { muteAgents: !before.muteAgents })).rejects.toMatchObject({ code: RpcErrorCode.Refused, message: "settings.set is not one of the agent's methods" });
  await expect(client.call('projects.list', {})).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  // An agent method on another thread, or with no thread at all.
  await expect(client.call('todos.list', { threadId: 't-other' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, message: 'todos.list is for thread t-trace, not thread t-other' });
  await expect(client.call('git.status', {} as never)).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('todos.list', { threadId: 't-trace' })).resolves.toBeDefined();
  client.sampleLoad('t-trace');
  expect(log).toEqual([]);
  client.becomes('owner');
  expect((await client.call('settings.get', {})).muteAgents).toBe(before.muteAgents);
});

test('an agent hears its own thread and its project\'s board only, as server.ts broadcast', async () => {
  const { FakeContext } = await import('./fake-client/context');
  const { seed } = await import('./fake-client/seed');
  const ctx = new FakeContext({ delayMs: 0, principal: 'agent', agentThreadId: 't-trace' });
  seed(ctx);
  ctx.bus.setState('ready');
  const own = ctx.thread('t-trace');
  const foreign = [...ctx.threads.values()].find(thread => thread.projectId !== own.projectId)!;
  const lines: string[] = [];
  ctx.bus.on('thread.activity', payload => lines.push(`activity ${payload.threadId}`));
  ctx.bus.on('todos.updated', payload => lines.push(`todos ${payload.projectId}`));
  for (const thread of [own, foreign]) {
    ctx.bus.deliver('thread.activity', { threadId: thread.id } as never);
    ctx.bus.deliver('todos.updated', { projectId: thread.projectId!, todos: [] });
  }
  expect(lines).toEqual([`activity ${own.id}`, `todos ${own.projectId}`]);
});

test('team and subagent changes reach a socket only while it is subscribed to their thread, as server.ts broadcast', async () => {
  const { FakeContext } = await import('./fake-client/context');
  const { seed } = await import('./fake-client/seed');
  const ctx = new FakeContext({ delayMs: 0, principal: 'agent', agentThreadId: 't-trace' });
  seed(ctx);
  ctx.bus.setState('ready');
  const lines: string[] = [];
  for (const name of ['collaboration.changed', 'delegation.changed', 'workflows.changed', 'thread.activity'] as const) ctx.bus.on(name, () => lines.push(name));
  // Core-side listeners, such as `delegation.wait`, still hear every change.
  let observed = 0;
  ctx.bus.observe('delegation.changed', () => { observed += 1; });
  const round = () => {
    ctx.bus.deliver('collaboration.changed', { threadId: 't-trace' } as never);
    ctx.bus.deliver('delegation.changed', { threadId: 't-trace' });
    ctx.bus.deliver('workflows.changed', { threadId: 't-trace', runId: 'run' } as never);
    ctx.bus.deliver('thread.activity', { threadId: 't-trace' } as never);
    return lines.splice(0);
  };
  // An agent socket still gets its own thread's activity without a subscription.
  expect(round()).toEqual(['thread.activity']);
  ctx.bus.subscribed.add('t-trace');
  // Workflow changes are the owner's alone.
  expect(round()).toEqual(['collaboration.changed', 'delegation.changed', 'thread.activity']);
  ctx.bus.subscribed.delete('t-trace');
  expect(round()).toEqual(['thread.activity']);
  expect(observed).toBe(3);
});

test('settings.set refuses what is not a setting before applying any of it, as router.ts checkRpcParams', async () => {
  const client = await fake();
  const before = await client.call('settings.get', {});
  for (const [params, field] of [[null, 'params'], [{ unknownTypo: true, muteAgents: !before.muteAgents }, 'unknownTypo']] as const) {
    await expect(client.call('settings.set', params as never)).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field } });
  }
  expect((await client.call('settings.get', {})).muteAgents).toBe(before.muteAgents);
});


test('a bot on another provider account refuses a turn before journalling it, as threads.ts', async () => {
  const { FakeContext } = await import('./fake-client/context');
  const { seed } = await import('./fake-client/seed');
  const { threadMethods } = await import('./fake-client/threads');
  const ctx = new FakeContext({ delayMs: 0 });
  seed(ctx);
  const thread = ctx.thread('t-trace');
  const foreign = ctx.accounts.find(a => a.providerId !== thread.providerId && a.status === 'ok')!;
  Object.assign(thread, { accountId: foreign.id, agentSessionId: 'agt_session_foreign', status: 'idle' });
  const before = thread.turns.length;
  const methods = threadMethods(ctx);
  try {
    const refusal = await methods['turns.start']({ threadId: thread.id, prompt: 'Do not use another provider account' }).catch(error => error);
    expect(refusal).toMatchObject({ code: RpcErrorCode.Refused,
      message: `accountId: account ${foreign.id} belongs to provider ${foreign.providerId}; expected provider ${thread.providerId}`,
      data: { field: 'accountId', accountId: foreign.id, providerId: foreign.providerId, expected: thread.providerId } });
    expect(thread.turns).toHaveLength(before);
  } finally { await methods['turns.stop']({ threadId: thread.id }); }
});

test('a provider turned off refuses a turn and reports provider-disabled, as drivers/index.ts and threads/capabilities.ts', async () => {
  const client = await fake();
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
  const events = heard(client, ['providers.updated']);
  const { loaded } = await client.call('providers.setEnabled', { providerId: 'echo', enabled: false });
  expect(loaded.find(provider => provider.id === 'echo')?.enabled).toBe(false);
  expect(loaded.every(provider => typeof provider.enabled === 'boolean')).toBe(true);
  expect(events).toHaveLength(1);
  // Asking for what already stands tells nobody.
  await client.call('providers.setEnabled', { providerId: 'echo', enabled: false });
  expect(events).toHaveLength(1);

  const refusal = await client.call('turns.start', { threadId: thread.id, prompt: 'hello' }).catch(error => error as { code: number; message: string; data: unknown });
  expect(refusal).toMatchObject({
    code: RpcErrorCode.Unavailable,
    message: 'Echo is turned off on this machine. Turn it on in Settings > Providers to use it',
    data: { providerId: 'echo', disabled: true },
  });
  expect(await code(client.call('providers.probe', { providerId: 'echo', accountId: 'a-echo' }))).toBe(RpcErrorCode.Unavailable);
  expect((await client.call('threads.capabilities', { threadId: thread.id })).compaction.reason).toBe('provider-disabled');

  await client.call('providers.setEnabled', { providerId: 'echo', enabled: true });
  expect(events).toHaveLength(2);
  expect(await code(client.call('turns.start', { threadId: thread.id, prompt: 'hello' }))).toBe('answered');
  await client.call('turns.stop', { threadId: thread.id });
});

test('an experimental provider is off until its owner turns it on, and a paired device may not, as providers/loader.ts and access.ts', async () => {
  const client = await fake();
  const listed = (await client.call('providers.list', {})).loaded.find(provider => provider.id === 'opencode-v2');
  expect(listed).toMatchObject({ name: 'OpenCode 2', protocol: 'acp', experimental: true, enabled: false, available: true });
  expect(await code(client.call('providers.setEnabled', { providerId: 'nope', enabled: true }))).toBe(RpcErrorCode.NotFound);
  expect(await code(client.call('providers.setEnabled', { providerId: 'opencode-v2', enabled: 'yes' as unknown as boolean }))).toBe(RpcErrorCode.InvalidParams);
  const phone = await fake({ principal: 'session' });
  expect(await code(phone.call('providers.setEnabled', { providerId: 'opencode-v2', enabled: true }))).toBe(RpcErrorCode.Refused);
  const { loaded } = await client.call('providers.setEnabled', { providerId: 'opencode-v2', enabled: true });
  expect(loaded.find(provider => provider.id === 'opencode-v2')?.enabled).toBe(true);
});

test('an archived thread with no project reports archived before agent-session, as threads/capabilities.ts', async () => {
  const { FakeContext } = await import('./fake-client/context');
  const { seed } = await import('./fake-client/seed');
  const { capabilityMethods } = await import('./fake-client/capabilities');
  const ctx = new FakeContext({});
  seed(ctx);
  const thread = [...ctx.threads.values()][0]!;
  Object.assign(thread, { projectId: null, agentSessionId: undefined, archived: true });
  const capabilities = await capabilityMethods(ctx)['threads.capabilities']({ threadId: thread.id });
  expect(capabilities.steering.reason).toBe('archived');
});
