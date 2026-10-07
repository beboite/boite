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
  const phoneLog = heard(phone, ['core.log', 'thread.updated']);
  owner.emitCoreLog('error', 'scheduler failed');
  phone.emitCoreLog('error', 'scheduler failed');
  phone.sampleLoad('t-trace');
  expect(ownerLog).toHaveLength(1);
  expect(phoneLog.map((line) => line.split(' ')[0])).toEqual(['thread.updated']);
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
