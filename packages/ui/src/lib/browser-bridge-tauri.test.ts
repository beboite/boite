import { afterEach, expect, test, vi } from 'vitest';
import { TauriBridge } from './browser-bridge-tauri';

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listen: vi.fn(async () => () => undefined)
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

afterEach(() => {
  invoke.mockReset();
  listen.mockClear();
});

test('fixed viewport fits after panel resize and clearing it restores the whole slot', async () => {
  invoke.mockResolvedValue({});
  const bridge = new TauriBridge();
  bridge.create('page', 'https://example.test');
  bridge.setBounds('page', { x: 10, y: 80, width: 480, height: 600 });
  await bridge.protocol('page', 'Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080 });
  expect(invoke).toHaveBeenLastCalledWith('browser_protocol', { id: 'page', method: 'Emulation.setDeviceMetricsOverride', params: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, scale: .25 } });
  bridge.setBounds('page', { x: 10, y: 80, width: 960, height: 600 });
  await bridge.protocol('page', 'Runtime.evaluate', { expression: 'innerWidth' });
  expect(invoke).toHaveBeenCalledWith('browser_set_bounds', { id: 'page', rect: { x: 10, y: 110, width: 960, height: 540 } });
  await bridge.protocol('page', 'Emulation.clearDeviceMetricsOverride', {});
  expect(invoke).toHaveBeenLastCalledWith('browser_set_bounds', { id: 'page', rect: { x: 10, y: 80, width: 960, height: 600 } });
  expect(bridge.viewport('page')).toBeNull();
});

test('a tab opens in its profile and deleting a profile asks the shell directly', async () => {
  invoke.mockResolvedValue(undefined);
  const bridge = new TauriBridge();
  bridge.create('work', 'https://example.test', 'p-0123456789ab');
  bridge.create('plain', 'https://example.test');
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(invoke).toHaveBeenNthCalledWith(1, 'browser_create', { id: 'work', url: 'https://example.test', profile: 'p-0123456789ab' });
  expect(invoke).toHaveBeenNthCalledWith(2, 'browser_create', { id: 'plain', url: 'https://example.test' });
  await bridge.deleteProfile('p-0123456789ab');
  expect(invoke).toHaveBeenLastCalledWith('browser_profile_delete', { profile: 'p-0123456789ab' });
  invoke.mockRejectedValueOnce('the profile is busy');
  await expect(bridge.deleteProfile('p-0123456789ab')).rejects.toBe('the profile is busy');
});

test('destroy and recreate of the same id wait for the earlier native commands', async () => {
  let finishCreate!: () => void;
  let finishDestroy!: () => void;
  const createGate = new Promise<void>((resolve) => { finishCreate = resolve; });
  const destroyGate = new Promise<void>((resolve) => { finishDestroy = resolve; });
  const commands: string[] = [];
  invoke.mockImplementation(async (command) => {
    expect(listen).toHaveBeenCalledTimes(1);
    commands.push(command);
    if (command === 'browser_create' && commands.length === 1) await createGate;
    if (command === 'browser_destroy') await destroyGate;
  });
  const bridge = new TauriBridge();
  bridge.create('same', 'https://example.invalid/first');
  await vi.waitFor(() => expect(commands).toEqual(['browser_create']));
  bridge.destroy('same');
  bridge.create('same', 'https://example.invalid/second');
  bridge.setBounds('same', { x: 1, y: 2, width: 300, height: 200 });
  await Promise.resolve();
  expect(commands).toEqual(['browser_create']);
  finishCreate();
  await vi.waitFor(() => expect(commands).toEqual(['browser_create', 'browser_destroy']));
  finishDestroy();
  await vi.waitFor(() => expect(commands).toEqual([
    'browser_create', 'browser_destroy', 'browser_create', 'browser_set_bounds'
  ]));
  expect(invoke).toHaveBeenNthCalledWith(3, 'browser_create', {
    id: 'same', url: 'https://example.invalid/second'
  });
});

test('a failed destroy reports its error and lets the same id be created again', async () => {
  invoke.mockImplementation(async (command) => {
    if (command === 'browser_destroy') throw new Error('native destroy refused');
  });
  const bridge = new TauriBridge();
  const events: unknown[] = [];
  bridge.on((event) => events.push(event));
  bridge.create('same', '');
  bridge.destroy('same');
  bridge.create('same', 'https://example.invalid/second');
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  expect(events).toEqual([{ type: 'destroyed', id: 'same' }, { type: 'failed', id: 'same', reason: 'native destroy refused' }]);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    'browser_create', 'browser_destroy', 'browser_create'
  ]);
});

test('native selection arms only a live surface and reports failure to its matching request', async () => {
  invoke.mockImplementation(async (command) => {
    if (command === 'browser_annotate') throw new Error('injection refused');
  });
  const bridge = new TauriBridge();
  const events: unknown[] = [];
  bridge.on(event => events.push(event));
  bridge.annotate('closed', 'ignored');
  bridge.create('active', 'https://example.test');
  bridge.annotate('active', 'request-a');
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(invoke).toHaveBeenNthCalledWith(2, 'browser_annotate', { id: 'active', requestId: 'request-a' });
  expect(events).toEqual([{ type: 'selection-failed', id: 'active', requestId: 'request-a', reason: 'injection refused' }]);
});

test('a profile\'s cookies are read through a blank view of that profile, made for it and destroyed after', async () => {
  invoke.mockImplementation(async (command) => command === 'browser_cookies' ? { cookies: [{ name: 'sid' }] } : null);
  const bridge = new TauriBridge();
  expect(await bridge.cookies('p-work')).toEqual([{ name: 'sid' }]);
  const calls = invoke.mock.calls.map(([command, args]) => [command, args?.profile, args?.url]);
  expect(calls[0]).toEqual(['browser_create', 'p-work', '']);
  expect(calls[1]![0]).toBe('browser_cookies');
  await vi.waitFor(() => expect(invoke.mock.calls.at(-1)![0]).toBe('browser_destroy'));
  // The same throwaway view for all three, and the default profile is named by leaving it out.
  expect(new Set(invoke.mock.calls.map(([, args]) => args?.id)).size).toBe(1);
  invoke.mockClear();
  await bridge.cookies('default');
  expect(invoke.mock.calls[0]![1]).not.toHaveProperty('profile');
  // A read the shell refuses still destroys its view.
  invoke.mockImplementation(async (command) => { if (command === 'browser_cookies') throw new Error('requires Windows WebView2'); return null; });
  await expect(bridge.cookies('p-work')).rejects.toThrow('Windows WebView2');
  await vi.waitFor(() => expect(invoke.mock.calls.at(-1)![0]).toBe('browser_destroy'));
});
