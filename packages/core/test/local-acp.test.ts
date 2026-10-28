import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { RpcErrorCode, type RpcEvents } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { countProcesses, readScriptedLog } from './scripted-provider.ts';

/** The fake ACP agent, started the way an owner would type it: `bun <fixture>`. */
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/acp-agent.ts', import.meta.url));

let harness: TestCore;
let client: CoreClient;
let logFile = '';

beforeEach(async () => {
  // Only the descriptor's own environment may tell the agent where to log.
  delete process.env['ACP_FAKE_LOG'];
  harness = await startTestCore();
  client = await harness.connect();
  logFile = join(harness.dataDir, 'local-acp.log');
});

afterEach(async () => {
  await harness.stop();
});

async function refusal(call: Promise<unknown>): Promise<{ code: number; data: Record<string, unknown> }> {
  try {
    await call;
  } catch (error) {
    const { rpc } = error as { rpc: { code: number; data: Record<string, unknown> } };
    return { code: rpc.code, data: rpc.data };
  }
  throw new Error('the call was answered');
}

test('a local ACP command becomes a provider that runs a turn with its literal arguments and environment, and leaves again', async () => {
  const updates: RpcEvents['providers.updated'][] = [];
  client.on('providers.updated', (payload) => updates.push(payload));

  const added = await client.call('providers.addLocal', {
    name: '  Local Fake  ',
    command: 'bun',
    args: [FAKE_AGENT, 'two words', '$HOME', '--profile=acp'],
    env: { ACP_FAKE_LOG: logFile, ACP_FAKE_ARGV: '1' },
  });
  expect(added.providerId).toBe('local-fake');
  expect(added.rejected).toEqual([]);
  expect(added.loaded.find((entry) => entry.id === 'local-fake')).toMatchObject({
    name: 'Local Fake', protocol: 'acp', source: 'user', available: true, login: false, enabled: true,
  });
  expect(updates.at(-1)?.loaded.some((entry) => entry.id === 'local-fake')).toBe(true);
  const file = join(harness.dataDir, 'providers', 'local-fake.json');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ id: 'local-fake', protocol: 'acp', auth: { kind: 'none' } });
  // Its environment values are plain text: only the owner reads the file.
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

  // No login of its own: the default account is the agent's own configuration.
  const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'local-fake');
  expect(account).toMatchObject({ isolationDir: null, status: 'ok' });

  const project = await client.call('projects.add', { path: harness.dataDir, name: 'local' });
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'local-fake', accountId: account!.id, title: 'local' });
  const processes = countProcesses(client, thread.id);
  await client.call('threads.subscribe', { threadId: thread.id });
  const finished = client.next('turn.finished', (turn) => turn.threadId === thread.id, 20_000);
  await client.call('turns.start', { threadId: thread.id, prompt: 'hello' });
  expect((await finished).status).toBe('done');
  expect(readScriptedLog(logFile)).toContain(`argv ${JSON.stringify(['two words', '$HOME', '--profile=acp'])}`);

  const removed = await client.call('providers.removeLocal', { providerId: 'local-fake' });
  expect(removed.loaded.some((entry) => entry.id === 'local-fake')).toBe(false);
  expect(existsSync(file)).toBe(false);
  expect(updates.at(-1)?.loaded.some((entry) => entry.id === 'local-fake')).toBe(false);
  // The warm agent is released with it, and the account waits for the same id to load again.
  await waitFor(() => processes.started.length > 0 && processes.exited.length === processes.started.length);
  expect((await client.call('accounts.list', {})).some((entry) => entry.id === account!.id)).toBe(true);
});

test('a local ACP command is refused with its field before anything is written', async () => {
  const add = (patch: Record<string, unknown>) =>
    refusal(client.call('providers.addLocal', { name: 'Mine', command: 'bun', args: [], env: {}, ...patch }));

  expect(await add({ name: 'Echo' })).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'name', providerId: 'echo' } });
  expect(await add({ name: '   ' })).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'name' } });
  expect(await add({ command: join('relative', 'agent') })).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'command' } });
  expect(await add({ command: 'no-such-agent-anywhere' })).toMatchObject({
    code: RpcErrorCode.InvalidParams, data: { field: 'command', expected: 'a program this machine can start' },
  });
  expect(await add({ command: join(harness.dataDir, 'missing-agent') })).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'command' } });
  expect(await add({ args: ['ok', ''] })).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'args[1]' } });
  expect(await add({ env: { '1BAD': 'x' } })).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'env.1BAD' } });
  expect(await add({ env: { GOOD: '' } })).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'env.GOOD' } });
  expect(existsSync(join(harness.dataDir, 'providers'))).toBe(false);

  // A file written by hand under that id is never overwritten.
  mkdirSync(join(harness.dataDir, 'providers'), { recursive: true });
  writeFileSync(join(harness.dataDir, 'providers', 'mine.json'), '{ "not": "loaded" }', 'utf8');
  expect(await add({})).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'name', providerId: 'mine' } });
  expect(readFileSync(join(harness.dataDir, 'providers', 'mine.json'), 'utf8')).toBe('{ "not": "loaded" }');
});

test('removing a provider is refused for a shipped one, an unknown one and one with a turn running', async () => {
  expect(await refusal(client.call('providers.removeLocal', { providerId: 'echo' }))).toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'providerId' } });
  expect(await refusal(client.call('providers.removeLocal', { providerId: 'nope' }))).toMatchObject({ code: RpcErrorCode.NotFound });

  await client.call('providers.addLocal', { name: 'Slow', command: 'bun', args: [FAKE_AGENT], env: { ACP_FAKE_LOG: logFile } });
  const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'slow')!;
  const project = await client.call('projects.add', { path: harness.dataDir, name: 'local' });
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'slow', accountId: account.id, title: 'slow' });
  await client.call('turns.start', { threadId: thread.id, prompt: '[slow]' });
  await waitFor(() => readScriptedLog(logFile).includes('waiting for cancel'), 20_000);
  expect(await refusal(client.call('providers.removeLocal', { providerId: 'slow' }))).toMatchObject({ code: RpcErrorCode.Refused, data: { providerId: 'slow' } });
  expect(existsSync(join(harness.dataDir, 'providers', 'slow.json'))).toBe(true);
  await client.call('turns.stop', { threadId: thread.id });
  await waitFor(() => !['queued', 'running', 'waiting'].includes(harness.core.threads.get(thread.id).status));
  expect((await client.call('providers.removeLocal', { providerId: 'slow' })).loaded.some((entry) => entry.id === 'slow')).toBe(false);
});
