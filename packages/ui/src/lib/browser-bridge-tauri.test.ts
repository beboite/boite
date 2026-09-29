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
  expect(events).toEqual([{ type: 'failed', id: 'same', reason: 'native destroy refused' }]);
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
