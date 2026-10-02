import { afterEach, expect, test, vi } from 'vitest';
import type { RpcEvents } from '@boite/contracts';
import { hostBrowser } from './browser-host';
import { writeExperiments } from './experiments';
import type { Store } from './store.svelte';

const { automateBrowser } = vi.hoisted(() => ({ automateBrowser: vi.fn(async () => ({})) }));
vi.mock('./browser-automation', () => ({ automateBrowser }));
vi.mock('./browser-bridge', () => ({ browserBridge: { protocol: vi.fn(), on: vi.fn() } }));
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; writeExperiments([]); vi.restoreAllMocks(); automateBrowser.mockClear(); });

test('the desktop grants no browser access by default and stops dispatching as soon as consent is withdrawn', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
  let requested: (request: RpcEvents['browser.requested']) => void = () => {};
  const off = vi.fn();
  const client = { call: vi.fn(async (..._args: unknown[]) => ({})), on: vi.fn((_name: string, callback: typeof requested) => { requested = callback; return off; }) };
  const store = { client, owner: true, machineId: 'test', openThread: { id: 'thread' }, threadKey: (id: string) => id } as unknown as Store;
  hostBrowser(store, 'thread')();
  expect(client.on).not.toHaveBeenCalled();
  expect(client.call).not.toHaveBeenCalled();
  writeExperiments(['agent-browser-control']);
  stop = hostBrowser(store, 'thread');
  expect(client.call).toHaveBeenCalledWith('browser.host', { threadId: 'thread', enabled: true, allowAgentControl: true, remote: false });
  writeExperiments(['agent-browser-control', 'remote-browser']);
  expect(client.call).toHaveBeenLastCalledWith('browser.host', { threadId: 'thread', enabled: true, allowAgentControl: true, remote: true });
  writeExperiments(['agent-browser-control']);
  expect(client.call).toHaveBeenLastCalledWith('browser.host', { threadId: 'thread', enabled: true, allowAgentControl: true, remote: false });
  writeExperiments([]);
  requested({ threadId: 'thread', requestId: 'late', action: { kind: 'screenshot' } });
  await vi.waitFor(() => expect(client.call).toHaveBeenCalledWith('browser.complete', { requestId: 'late', error: 'the browser conversation is no longer open' }));
  expect(automateBrowser).not.toHaveBeenCalled();
  stop(); stop = undefined;
  expect(client.call).toHaveBeenCalledWith('browser.host', { threadId: 'thread', enabled: false });
  expect(off).toHaveBeenCalledOnce();
});
