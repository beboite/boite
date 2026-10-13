import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { type RpcMethodName } from '@boite/contracts';
import { confirm } from '../lib/confirm.svelte';
import { store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import { mountOnFake, query, test, type, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('automatic settings sync follows the chosen source outside settings and stops when unchecked', async () => {
  await mountOnFake('/?fake=1&machines=1');
  await waitFor(() => workspace.machines.length === 2);
  const remote = workspace.machines.find(machine => machine.store !== store)!;
  await store.client!.call('brain.configure', { path: '/home/user/source-brain', enabled: false });
  await remote.store.client!.call('brain.configure', { path: '/home/user/target-brain', enabled: false });
  await remote.store.client!.call('settings.set', { warmProcessMinutes: 3, agentCpuCapPercent: 35 });
  await store.client!.call('settings.set', { asyncQuestions: false, warmProcessMinutes: 9, agentCpuCapPercent: 85 });
  store.showSettings('machines');
  await waitFor(() => document.querySelector('[data-testid=group-sync]') !== null);
  const checkbox = query<HTMLInputElement>('[data-testid=group-sync]');
  expect(checkbox.type).toBe('checkbox');
  checkbox.click();
  await waitFor(() => remote.store.settings?.asyncQuestions === false);
  expect(document.querySelector('[data-testid=confirm-ok]')).toBeNull();
  expect(document.querySelector('[data-testid=machines-page]')).not.toBeNull();
  expect(document.querySelector('[data-testid=machine-settings]')).toBeNull();
  expect(remote.store.settings).toMatchObject({ warmProcessMinutes: 3, agentCpuCapPercent: 35 });
  store.showChat();
  await store.client!.call('settings.set', { asyncQuestions: true });
  await store.client!.call('keybindings.set', { command: 'terminal', chord: 'Ctrl+Shift+J' });
  await waitFor(() => remote.store.settings?.asyncQuestions === true && remote.store.keybindings?.bindings.terminal === 'ctrl+shift+j');
  const brain = await store.client!.call('brain.status', {});
  await store.client!.call('brain.configure', { ...brain.config, boiteGuide: false });
  await waitFor(() => workspace.settingsSync.reports[remote.id]?.report.brain === 'copied');
  await vi.waitFor(async () => expect((await remote.store.client!.call('brain.status', {})).config).toMatchObject({ path: '/home/user/target-brain', boiteGuide: false }));
  // Missed changes catch up when the destination reconnects.
  remote.store.connection = 'closed';
  flushSync();
  await store.client!.call('settings.set', { asyncQuestions: false });
  remote.store.connection = 'ready';
  flushSync();
  await waitFor(() => remote.store.settings?.asyncQuestions === false);
  expect(remote.store.settings).toMatchObject({ warmProcessMinutes: 3, agentCpuCapPercent: 35 });
  // Switching the visible host does not reverse the saved source.
  await workspace.select(remote.store);
  await store.client!.call('settings.set', { asyncQuestions: true });
  await waitFor(() => remote.store.settings?.asyncQuestions === true);
  await workspace.select(store);
  store.showSettings('machines');
  await waitFor(() => document.querySelector('[data-testid=group-sync]') !== null);
  query<HTMLInputElement>('[data-testid=group-sync]').click();
  await store.client!.call('settings.set', { asyncQuestions: false });
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(remote.store.settings?.asyncQuestions).toBe(true);
});

test('machines coexist and disconnecting a remote leaves the primary connected', async () => {
  await mountOnFake('/?fake=1&machines=1');
  await waitFor(() => workspace.machines.length === 2);
  store.showSettings('machines');
  await waitFor(() => document.querySelectorAll('[data-testid=machine-card]').length === 2);
  expect(Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid=machine-rename]')).map(input => input.value)).toContain('Builder');
  query<HTMLButtonElement>('[data-testid=machine-remove]').click();
  // Forgetting a machine asks first; the answer is the in-app dialog's.
  await waitFor(() => document.querySelector('[data-testid=confirm-ok]') !== null);
  query<HTMLButtonElement>('[data-testid=confirm-ok]').click();
  await waitFor(() => document.querySelectorAll('[data-testid=machine-card]').length === 1);
  expect(store.connection).toBe('ready');
  expect(workspace.active).toBe(store);
});

test('a machine filter whose machine goes away lists the remaining machine again', async () => {
  await mountOnFake('/?fake=1&machines=1');
  await waitFor(() => workspace.machines.length === 2);
  const threads = () => document.querySelectorAll('[data-thread-id]').length;
  await waitFor(() => threads() > 0 && document.querySelector('[data-testid=machine-status]') !== null);
  const everything = threads();
  const remote = workspace.machines.find((machine) => machine.store !== store)!;
  query<HTMLButtonElement>('[data-testid=machine-status]').click();
  await waitFor(() => document.querySelector(`[data-testid=machine-status-menu] [data-value="${remote.id}"]`) !== null);
  query<HTMLButtonElement>(`[data-testid=machine-status-menu] [data-value="${remote.id}"]`).click();
  await waitFor(() => threads() < everything);
  workspace.machines = workspace.machines.filter((machine) => machine !== remote);
  flushSync();
  // One machine draws no machine button, so a filter left on the gone one could never be cleared.
  expect(document.querySelector('[data-testid=machine-status]')).toBeNull();
  expect(threads()).toBeGreaterThan(0);
});

test('an older core names the host that needs goals support and keeps the unsent prompt', async ({ app: _app }) => {
  await waitFor(() => store.openThread !== null);
  store.core!.hostname = 'Older host';
  const client = store.client!;
  const call = client.call.bind(client);
  const { RpcFailure } = await import('../lib/client');
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method === 'threads.activity.set') return Promise.reject(new RpcFailure({code:-32601,message:'unknown method threads.activity.set'}));
    return call<RpcMethodName>(method, params);
  });
  try {
    const field = query<HTMLTextAreaElement>('[data-testid=composer-input]');
    field.value = '/goal Verify two tasks';
    field.dispatchEvent(new Event('input', {bubbles:true}));
    await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
    query<HTMLButtonElement>('[data-testid=composer-send]').click();
    await waitFor(() => store.error !== null);
    expect(store.error).toContain(store.core!.hostname);
    expect(store.error).toContain('Update Boite');
    expect(field.value).toBe('/goal Verify two tasks');
    expect(spy.mock.calls.some(([method]) => method === 'turns.start')).toBe(false);
  } finally { spy.mockRestore(); }
});

test('sending waits for reconnect history to finish loading', async ({ app: _app }) => {
  await waitFor(() => store.openThread !== null);
  const client = store.client!;
  const call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method === 'threads.get') return gate.then(() => call<RpcMethodName>(method, params));
    return call<RpcMethodName>(method, params);
  });
  try {
    const loading = store.reload();
    await waitFor(() => spy.mock.calls.some(([method]) => method === 'threads.get'));
    const sending = store.send('after reconnect');
    await Promise.resolve();
    expect(spy.mock.calls.some(([method]) => method === 'turns.start')).toBe(false);
    release();
    await loading;
    expect(await sending).toBe(true);
  } finally { release(); spy.mockRestore(); }
});
