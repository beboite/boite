import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { type RpcMethodName } from '@boite/contracts';
import { confirm } from '../lib/confirm.svelte';
import { store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import { mountOnFake, query, test, type, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('the default machine is followed outside settings, and a follower names it above its pages and stars what it keeps', async () => {
  await mountOnFake('/?fake=1&machines=1');
  await waitFor(() => workspace.machines.length === 2);
  const remote = workspace.machines.find(machine => machine.store !== store)!;
  await store.client!.call('brain.configure', { path: '/home/user/source-brain', enabled: false });
  await remote.store.client!.call('brain.configure', { path: '/home/user/target-brain', enabled: false });
  await remote.store.client!.call('settings.set', { warmProcessMinutes: 3, agentCpuCapPercent: 35 });
  await store.client!.call('settings.set', { asyncQuestions: false, warmProcessMinutes: 9, agentCpuCapPercent: 85 });
  store.showSettings('machines');
  // The page groups the connected machines, then offers a default machine for the group.
  await waitFor(() => remote.store.group?.cores.length === 2 && document.querySelector('[data-testid=group-home-pick]') !== null);
  const home = store.group!.self;
  query<HTMLButtonElement>('[data-testid=group-home-pick]').click();
  flushSync();
  query<HTMLElement>(`[data-testid=group-home-pick-menu] [data-value="${home}"]`).click();
  await waitFor(() => remote.store.settings?.asyncQuestions === false);
  expect(remote.store.group?.settingsHome).toBe(home);
  expect(document.querySelector('[data-testid=confirm-ok]')).toBeNull();
  expect(remote.store.settings).toMatchObject({ warmProcessMinutes: 3, agentCpuCapPercent: 35 });
  store.showChat();
  await store.client!.call('settings.set', { asyncQuestions: true });
  await store.client!.call('keybindings.set', { command: 'terminal', chord: 'Ctrl+Shift+J' });
  await waitFor(() => remote.store.settings?.asyncQuestions === true && remote.store.keybindings?.bindings.terminal === 'ctrl+shift+j');
  const brain = await store.client!.call('brain.status', {});
  await store.client!.call('brain.configure', { ...brain.config, boiteGuide: false });
  await waitFor(() => workspace.settingsSync.reports[remote.id]?.report.brain === 'copied');
  await vi.waitFor(async () => expect((await remote.store.client!.call('brain.status', {})).config).toMatchObject({ path: '/home/user/target-brain', boiteGuide: false }));
  // Missed changes catch up when the follower reconnects.
  remote.store.connection = 'closed';
  flushSync();
  await store.client!.call('settings.set', { asyncQuestions: false });
  remote.store.connection = 'ready';
  flushSync();
  await waitFor(() => remote.store.settings?.asyncQuestions === false);
  expect(remote.store.settings).toMatchObject({ warmProcessMinutes: 3, agentCpuCapPercent: 35 });

  // The follower's settings, picked above the page: the window stays on its own machine.
  store.showSettings('general');
  await waitFor(() => document.querySelector('[data-testid=settings-machine]') !== null);
  expect(document.querySelector('[data-testid=settings-is-home]')).not.toBeNull();
  query<HTMLButtonElement>('[data-testid=settings-machine]').click();
  flushSync();
  query<HTMLElement>(`[data-testid=settings-machine-menu] [data-value="${remote.id}"]`).click();
  await waitFor(() => document.querySelector('[data-testid=settings-follows]') !== null);
  expect(workspace.active).toBe(store);
  expect(document.querySelector('[data-testid=sync-mark]')).toBeNull();
  // A setting changed there stays there, starred, whatever the default machine does next.
  const short = store.settings?.shortAnswers ?? true;
  query<HTMLInputElement>('[data-testid=setting-short-answers]').click();
  await waitFor(() => remote.store.settings?.shortAnswers === !short && remote.store.settings?.syncOverrides?.includes('shortAnswers') === true);
  expect(store.settings?.shortAnswers ?? true).toBe(short);
  await waitFor(() => document.querySelector('[data-testid=sync-mark][data-key=shortAnswers]') !== null);
  await store.client!.call('settings.set', { shortAnswers: short, muteAgents: false });
  await waitFor(() => remote.store.settings?.muteAgents === false);
  expect(remote.store.settings?.shortAnswers).toBe(!short);
  // The star gives it back to the default machine.
  query<HTMLButtonElement>('[data-testid=sync-mark][data-key=shortAnswers]').click();
  await waitFor(() => remote.store.settings?.shortAnswers === short && document.querySelector('[data-testid=sync-mark]') === null);
  expect(remote.store.settings?.syncOverrides).toEqual([]);

  // No default machine any more: nothing follows.
  store.showSettings('machines');
  await waitFor(() => document.querySelector('[data-testid=group-home-pick]') !== null);
  query<HTMLButtonElement>('[data-testid=group-home-pick]').click();
  flushSync();
  query<HTMLElement>('[data-testid=group-home-pick-menu] [data-value=none]').click();
  await waitFor(() => remote.store.group?.settingsHome === undefined);
  await store.client!.call('settings.set', { asyncQuestions: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(remote.store.settings?.asyncQuestions).toBe(false);
});

test('background compaction turns on for the machine picked above it, not the window\'s', async () => {
  // Flipped from the desktop app, the switch only ever reached the PC's core, never the server running the thread.
  await mountOnFake('/?fake=1&machines=1');
  await waitFor(() => workspace.machines.length === 2);
  const remote = workspace.machines.find(machine => machine.store !== store)!;
  store.showSettings('experiments');
  await waitFor(() => document.querySelector('[data-testid=settings-machine]') !== null && document.querySelector('[data-testid=background-compaction-on]') !== null);
  // This device's switches come first; the bar names the machine of the cards below it.
  const page = query('[data-testid=experiments-page]');
  const bar = query('[data-testid=settings-machine-bar]');
  expect(page.contains(bar)).toBe(true);
  expect(bar.compareDocumentPosition(query('[data-testid=experiment-goal2]')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  query<HTMLButtonElement>('[data-testid=settings-machine]').click();
  flushSync();
  query<HTMLElement>(`[data-testid=settings-machine-menu] [data-value="${remote.id}"]`).click();
  await waitFor(() => query('[data-testid=settings-machine]').textContent?.includes(remote.label) === true);
  query<HTMLInputElement>('[data-testid=background-compaction-on]').click();
  await waitFor(() => remote.store.settings?.backgroundCompaction === true);
  expect(store.settings?.backgroundCompaction ?? false).toBe(false);
  expect(workspace.active).toBe(store);
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
