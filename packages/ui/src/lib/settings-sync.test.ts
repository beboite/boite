import { expect, test, vi } from 'vitest';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure, type Client } from './client';
import { FakeClient } from './fake-client';
import { PORTABLE_SETTINGS, syncSettings, type SyncEnd } from './settings-sync';

async function machine(options: { uninstalled?: boolean } = {}): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0, ...options });
  await client.connect();
  return client;
}

async function end(client: Client): Promise<SyncEnd> {
  const [{ loaded }, accounts] = await Promise.all([client.call('providers.list', {}), client.call('accounts.list', {})]);
  return { client, providers: loaded, accounts };
}

test('the target takes the portable settings, the keybindings and the brain switches, and keeps what is its own', async () => {
  const from = await machine();
  const to = await machine();
  await from.call('settings.set', { maxConcurrentTurns: 7, muteAgents: false, focusGuard: false, listenOnLan: true, publicUrl: 'https://source.example' });
  await to.call('settings.set', { maxConcurrentTurns: 2, muteAgents: true, focusGuard: true, listenOnLan: false, publicUrl: null });
  await from.call('keybindings.set', { command: 'panel', chord: 'mod+shift+p' });
  await to.call('keybindings.set', { command: 'theme-light', chord: 'mod+alt+t' });
  await from.call('brain.configure', { path: 'D:/Source/brain', enabled: true, globalInstructions: false, boiteGuide: false });
  await to.call('brain.configure', { path: 'E:/Target/brain', enabled: true, globalInstructions: true, boiteGuide: true });

  const report = await syncSettings(await end(from), await end(to));

  const source = await from.call('settings.get', {});
  const target = await to.call('settings.get', {});
  for (const key of PORTABLE_SETTINGS) expect(target[key]).toEqual(source[key]);
  expect(report.changed).toBe(3);
  // The machine's network face stays its own.
  expect(target).toMatchObject({ listenOnLan: false, publicUrl: null });
  expect(report.settings).toEqual(target);
  // The whole file: the source's own entries, and nothing the target had alone.
  const sourceKeys = await from.call('keybindings.get', {});
  expect((await to.call('keybindings.get', {})).bindings).toEqual(sourceKeys.bindings);
  expect(report.keybindings.bindings).toEqual(sourceKeys.bindings);
  expect(report.brain).toBe('copied');
  expect((await to.call('brain.status', {})).config).toMatchObject({ path: 'E:/Target/brain', enabled: true, globalInstructions: false, boiteGuide: false });
});

test('a target with no brain is told so, and a login never crosses: its providers are listed instead', async () => {
  const from = await machine();
  const to = await machine({ uninstalled: true });
  await from.call('brain.configure', { path: 'D:/Source/brain', enabled: true });
  const target = await end(to);
  const configure = vi.spyOn(to, 'call');

  const report = await syncSettings(await end(from), target);

  expect(report.brain).toBe('absent');
  expect(configure.mock.calls.map(([method]) => method)).not.toContain('brain.configure');
  expect(configure.mock.calls.map(([method]) => method).filter((method) => method.startsWith('accounts.'))).toEqual([]);
  expect(report.providers.length).toBeGreaterThan(0);
  // One row per family: the two Antigravity programs are one provider to the user.
  const ids = report.providers.map((row) => row.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).not.toContain('antigravity-cli');
});

test('a core without a brain is skipped, not failed', async () => {
  const from = await machine();
  const to = await machine();
  await from.call('brain.configure', { path: 'D:/Source/brain', enabled: true });
  const call = to.call.bind(to) as Client['call'];
  const older: Client = Object.assign(Object.create(to) as Client, {
    call: ((method, params) => method === 'brain.status'
      ? Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'brain.status: unknown method' }))
      : call(method, params)) as Client['call']
  });

  const report = await syncSettings(await end(from), await end(older));

  expect(report.brain).toBe('none');
});
