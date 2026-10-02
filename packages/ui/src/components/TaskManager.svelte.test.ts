import { afterEach, expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { RpcErrorCode, type AgentResourceSnapshot } from '@boite/contracts';
import { RpcFailure } from '../lib/client';
import { strings } from '../lib/strings';
import { bytes, percent } from '../lib/format';
import { test } from '../test/fake-client';
import TaskManager from './TaskManager.svelte';
import MobileSettings from './MobileSettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
const settle = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); flushSync(); } };
const element = (selector: string) => {
  const found = document.querySelector<HTMLElement>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="task-manager-agent"]')];
const click = async (element: HTMLElement) => { element.click(); await settle(); };
const visibility = () => vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
const setVisible = async (visible: ReturnType<typeof visibility>, state: 'visible' | 'hidden') => {
  visible.mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
};

test('available zero readings differ from missing measurements, with search and per-agent rates', async ({ store, client }) => {
  visibility();
  const snapshot = await client.call('resources.usage', {});
  expect(snapshot.agents.length).toBeGreaterThan(0);
  const initial = snapshot.agents[0]!;
  const known = { ...initial, title: 'Known agent', load: { processes: 1, cpuPercent: 0, memoryBytes: 8 * 1048576 }, loadAvailable: { cpu: true, memory: true }, network: { ...initial.network, coverage: 'partial' as const, source: 'linux-tcp-info' as const, readBytes: 8192, writeBytes: 16384, readBytesPerSecond: 4096, writeBytesPerSecond: 8192 } };
  const missing = { ...initial, threadId: 'unmeasured', title: 'Unmeasured agent', loadAvailable: { cpu: false, memory: false }, load: { processes: 1, cpuPercent: 0, memoryBytes: 0 } };
  const unflagged = { ...missing, threadId: 'unspecified', title: 'Flags missing', loadAvailable: undefined };
  const original = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'resources.usage' ? Promise.resolve({ ...snapshot, agents: [missing, unflagged, known] }) as ReturnType<typeof client.call> : original(method, params as never));
  mounted = mount(TaskManager, { target: document.body, props: { store } });
  await settle();
  expect(rows().map(row => row.dataset.threadId)).toEqual([known.threadId, unflagged.threadId, missing.threadId]);
  expect(rows()[0]!.querySelector('[data-testid="task-manager-cpu"]')!.textContent).toBe(percent(0));
  expect(rows()[0]!.querySelector('[data-testid="task-manager-memory"]')!.textContent).toBe(bytes(8 * 1048576));
  expect(rows()[1]!.querySelector('[data-testid="task-manager-cpu"]')!.textContent).toBe(strings.resources.unknown);
  expect(rows()[1]!.querySelector('[data-testid="task-manager-memory"]')!.textContent).toBe(strings.resources.unknown);
  expect(rows()[2]!.querySelector('[data-testid="task-manager-cpu"]')!.textContent).toBe(strings.resources.unknown);
  expect(rows()[0]!.querySelector('[data-testid="task-manager-network"]')!.textContent).toContain(bytes(4096));
  expect(rows()[0]!.querySelector('[data-testid="task-manager-disk"]')!.textContent).toContain(strings.resources.unknown);
  const search = element('[data-testid="task-manager-search"]') as HTMLInputElement;
  search.value = 'unmeasured'; search.dispatchEvent(new Event('input')); await settle();
  expect(rows().map(row => row.dataset.threadId)).toEqual([missing.threadId]);
  search.value = 'no such agent'; search.dispatchEvent(new Event('input')); await settle();
  expect(element('[data-testid="task-manager-empty"]').textContent).toBe(strings.taskManager.noMatches);
});

test('watching follows visibility, stops on close and resumes immediately when visible', async ({ store, client }) => {
  vi.useFakeTimers();
  const visible = visibility();
  const call = vi.spyOn(client, 'call');
  const watches = () => call.mock.calls.filter(([method]) => method === 'resources.usage').map(([, params]) => (params as { watch: boolean }).watch);
  mounted = mount(TaskManager, { target: document.body, props: { store } });
  await settle();
  expect(watches()).toEqual([true]);
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(watches()).toEqual([true, true]);
  await setVisible(visible, 'hidden');
  await vi.advanceTimersByTimeAsync(10000); await settle();
  expect(watches()).toEqual([true, true, false]);
  await setVisible(visible, 'visible');
  expect(watches()).toEqual([true, true, false, true]);
  await unmount(mounted); mounted = undefined;
  await vi.advanceTimersByTimeAsync(10000);
  expect(watches()).toEqual([true, true, false, true, false]);
});

test('a paired phone can reach the task manager and has no process-stop control', async ({ ready }) => {
  visibility();
  const { store, client } = await ready({ delayMs: 0, principal: 'session' });
  expect(store.owner).toBe(false);
  const open = vi.spyOn(store, 'open');
  const beforeOpen = vi.fn(() => expect(open).not.toHaveBeenCalled());
  mounted = mount(MobileSettings, { target: document.body, props: { store, onopenthread: beforeOpen } });
  await settle();
  await click(element('[data-testid="settings-tab-task-manager"]'));
  await vi.waitFor(() => expect(document.querySelector('[data-testid="task-manager-agent"]')).not.toBeNull());
  expect(element('[data-testid="task-manager"]').textContent).not.toContain(strings.taskManager.stop);
  await expect(client.call('resources.killTree', { threadId: rows()[0]!.dataset.threadId! })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  const threadId = rows()[0]!.dataset.threadId!;
  await click(element(`[data-thread-id="${threadId}"] .title`));
  expect(beforeOpen).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(threadId);
  expect(store.openThread?.id).toBe(threadId);
  expect(store.page).toBe('chat');
  store.showSettings('task-manager');
  await click(element('[data-testid="mobile-settings-back"]'));
  expect(document.querySelector('[data-testid="mobile-settings-home"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="task-manager"]')).toBeNull();
});

test('an older core explains the unavailable method without repeated automatic requests', async ({ store, client }) => {
  vi.useFakeTimers();
  const visible = visibility();
  const original = client.call.bind(client);
  let supported = false;
  const call = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'resources.usage' && !supported ? Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method resources.usage' })) : original(method, params));
  mounted = mount(TaskManager, { target: document.body, props: { store } });
  await settle();
  expect(element('[data-testid="task-manager-error"]').textContent).toContain(strings.taskManager.unsupported);
  await vi.advanceTimersByTimeAsync(10000); await settle();
  await setVisible(visible, 'hidden'); await setVisible(visible, 'visible');
  expect(call.mock.calls.filter(([method, params]) => method === 'resources.usage' && (params as { watch: boolean }).watch)).toHaveLength(1);
  supported = true;
  await click(element('[data-testid="task-manager-error"] button'));
  expect(rows().length).toBeGreaterThan(0);
  expect(document.querySelector('[data-testid="task-manager-error"]')).toBeNull();
});

test('stopping processes cannot be undone by an older pending snapshot', async ({ store, client }) => {
  vi.useFakeTimers(); visibility();
  const original = client.call.bind(client);
  const snapshot = await original('resources.usage', {});
  let deliver!: (snapshot: AgentResourceSnapshot) => void;
  let reads = 0;
  vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'resources.usage' && (params as { watch?: boolean }).watch && ++reads === 2 ? new Promise<AgentResourceSnapshot>(resolve => deliver = resolve) as ReturnType<typeof client.call> : original(method, params));
  mounted = mount(TaskManager, { target: document.body, props: { store } }); await settle();
  const threadId = snapshot.agents[0]!.threadId;
  await vi.advanceTimersByTimeAsync(2000); await settle();
  await click(element(`[data-thread-id="${threadId}"] .actions button`));
  await click(element(`[data-thread-id="${threadId}"] .actions button.danger`));
  expect(rows().map(row => row.dataset.threadId)).not.toContain(threadId);
  deliver(snapshot); await settle();
  expect(rows().map(row => row.dataset.threadId)).not.toContain(threadId);
  expect((await original('resources.list', {})).map(row => row.threadId)).not.toContain(threadId);
});

test('closing during a pending stop cannot renew the resource watch', async ({ store, client }) => {
  visibility();
  let finish!: () => void;
  const original = client.call.bind(client);
  const call = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'resources.killTree' ? new Promise<{ killed: number }>(resolve => finish = () => resolve({ killed: 1 })) as ReturnType<typeof client.call> : original(method, params));
  mounted = mount(TaskManager, { target: document.body, props: { store } }); await settle();
  const row = rows()[0]!;
  await click(row.querySelector<HTMLElement>('.actions button')!);
  await click(row.querySelector<HTMLElement>('.actions button.danger')!);
  expect(row.textContent).toContain(strings.taskManager.stopping);
  await unmount(mounted); mounted = undefined;
  const readsAtClose = call.mock.calls.filter(([method]) => method === 'resources.usage').length;
  finish(); await settle();
  expect(call.mock.calls.filter(([method]) => method === 'resources.usage')).toHaveLength(readsAtClose);
  expect(call.mock.calls.filter(([method]) => method === 'resources.usage').at(-1)).toEqual(['resources.usage', { watch: false }]);
});

test('a replacement machine rejects the previous machine snapshot even when IDs match', async ({ ready }) => {
  visibility();
  const a = await ready({ delayMs: 0, coreId: 'machine-a' });
  const b = await ready({ delayMs: 0, coreId: 'machine-b' });
  const older = await a.client.call('resources.usage', {});
  const newer = await b.client.call('resources.usage', {});
  expect(older.agents[0]!.threadId).toBe(newer.agents[0]!.threadId);
  vi.useFakeTimers();
  let deliver!: (snapshot: AgentResourceSnapshot) => void;
  let reads = 0;
  const original = a.client.call.bind(a.client);
  vi.spyOn(a.client, 'call').mockImplementation((method, params) => method === 'resources.usage' && (params as { watch: boolean }).watch && ++reads === 2 ? new Promise<AgentResourceSnapshot>(resolve => deliver = resolve) as ReturnType<typeof a.client.call> : original(method, params));
  const props = $state({ store: a.store });
  mounted = mount(TaskManager, { target: document.body, props }); await settle();
  await click(rows()[0]!.querySelector<HTMLElement>('.actions button')!);
  expect(element('.actions button.danger').textContent).toBe(strings.taskManager.stop);
  await vi.advanceTimersByTimeAsync(2000); await settle();
  props.store = b.store; flushSync(); await settle();
  expect(rows().length).toBe(newer.agents.length);
  expect(document.querySelector('.actions button.danger')).toBeNull();
  deliver({ ...older, agents: older.agents.map(row => ({ ...row, title: 'Stale machine A' })) }); await settle();
  expect(document.body.textContent).not.toContain('Stale machine A');
  expect(element('[data-testid="task-manager"]').textContent).toContain(newer.agents[0]!.title);
});

test('an old machine stop cannot clear a newer machine pending stop', async ({ ready }) => {
  visibility();
  const a = await ready({ delayMs: 0, coreId: 'machine-a' });
  const b = await ready({ delayMs: 0, coreId: 'machine-b' });
  const finishes: (() => void)[] = [];
  for (const { client } of [a, b]) {
    const original = client.call.bind(client);
    vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'resources.killTree' ? new Promise<{ killed: number }>(resolve => finishes.push(() => resolve({ killed: 1 }))) as ReturnType<typeof client.call> : original(method, params));
  }
  const props = $state({ store: a.store });
  mounted = mount(TaskManager, { target: document.body, props }); await settle();
  const stopFirst = async () => {
    await click(rows()[0]!.querySelector<HTMLElement>('.actions button')!);
    await click(element('.actions button.danger'));
  };
  await stopFirst();
  expect(element('.actions button').textContent).toBe(strings.taskManager.stopping);
  props.store = b.store; flushSync(); await settle();
  expect(element('.actions button').hasAttribute('disabled')).toBe(false);
  await stopFirst();
  finishes[0]!(); await settle();
  expect(element('.actions button').textContent).toBe(strings.taskManager.stopping);
  expect(element('.actions button').hasAttribute('disabled')).toBe(true);
  finishes[1]!(); await settle();
  expect(element('.actions button').hasAttribute('disabled')).toBe(false);
});
