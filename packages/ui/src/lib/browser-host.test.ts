import { afterEach, expect, test, vi } from 'vitest';
import type { RpcEvents, RpcParams } from '@boite/contracts';
import { hostBrowser } from './browser-host';
import { writeExperiments } from './experiments';
import type { Store } from './store.svelte';
import { browserBridge } from './browser-bridge';
import { rightPanel } from './right-panel.svelte';

const { automateBrowser } = vi.hoisted(() => ({ automateBrowser: vi.fn(async () => ({})) }));
vi.mock('./browser-automation', () => ({ automateBrowser }));
vi.mock('./browser-bridge', () => ({ browserBridge: { protocol: vi.fn(), on: vi.fn(), destroy: vi.fn() } }));
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; writeExperiments([]); rightPanel.forget('remote-thread'); vi.restoreAllMocks(); automateBrowser.mockClear(); vi.mocked(browserBridge.protocol!).mockReset(); });

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

test('remote keys waiting for page validation cannot cross a consent or active-tab change', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
  writeExperiments(['agent-browser-control', 'remote-browser']);
  let requested: (request: RpcEvents['browser.requested']) => void = () => {};
  const completed = new Map<string, RpcParams<'browser.complete'>>();
  const client = {
    call: vi.fn(async (method: string, params: unknown) => {
      if (method === 'browser.complete') { const reply = params as RpcParams<'browser.complete'>; completed.set(reply.requestId, reply); }
      return {};
    }),
    on: vi.fn((_name: string, callback: typeof requested) => { requested = callback; return () => {}; }),
  };
  const store = { client, owner: true, machineId: 'test', openThread: { id: 'remote-thread' }, threadKey: (id: string) => id } as unknown as Store;
  const panel = rightPanel.for('remote-thread'), surface = panel.open('browser', 'https://example.test');
  const page = { width: 800, height: 600, title: 'Fixture', href: 'https://example.test', origin: 1 };
  const protocol = vi.mocked(browserBridge.protocol!);
  protocol.mockImplementation(async (_id, method) => method === 'Page.captureScreenshot' ? { data: '/9j/2Q==' } : { result: { value: page } });
  stop = hostBrowser(store, 'remote-thread');
  requested({ threadId: 'remote-thread', requestId: 'frame', action: { kind: 'remote-frame' } });
  await vi.waitFor(() => expect(completed.get('frame')?.result?.frame?.id).toBeTruthy());
  const frameId = completed.get('frame')!.result!.frame!.id;
  for (const change of ['sharing', 'agent-control', 're-enable', 'tab', 'expired'] as const) {
    writeExperiments(['agent-browser-control', 'remote-browser']); panel.activate(surface.id);
    protocol.mockClear();
    let finish!: (reply: unknown) => void;
    protocol.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    requested({ threadId: 'remote-thread', requestId: change, tabId: surface.id, action: { kind: 'remote-input', frameId, input: { kind: 'key', key: 'Enter' } } });
    await vi.waitFor(() => expect(protocol).toHaveBeenCalledOnce());
    const now = Date.now();
    if (change === 'expired') vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
    else if (change === 'tab') panel.open('browser', 'https://other.test');
    else if (change === 'agent-control') writeExperiments(['remote-browser']);
    else {
      writeExperiments(['agent-browser-control']);
      if (change === 're-enable') writeExperiments(['agent-browser-control', 'remote-browser']);
    }
    finish({ result: { value: page } });
    await vi.waitFor(() => expect(completed.get(change)?.error).toContain('changed'));
    expect(protocol.mock.calls.map(call => call[1])).toEqual(['Runtime.evaluate']);
    if (change === 'expired') vi.mocked(Date.now).mockRestore();
  }
  writeExperiments(['agent-browser-control', 'remote-browser']); panel.activate(surface.id); protocol.mockClear();
  requested({ threadId: 'remote-thread', requestId: 'allowed', tabId: surface.id, action: { kind: 'remote-input', frameId, input: { kind: 'key', key: 'Enter' } } });
  await vi.waitFor(() => expect(completed.get('allowed')?.result?.value).toEqual({ ok: true }));
  expect(protocol.mock.calls.map(call => call[1])).toEqual(['Runtime.evaluate', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
});

test('sharing alone hosts the browser for viewers but not for the agent, and scales frames to the viewer', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
  writeExperiments(['remote-browser']);
  let requested: (request: RpcEvents['browser.requested']) => void = () => {};
  const completed = new Map<string, RpcParams<'browser.complete'>>();
  const client = {
    call: vi.fn(async (method: string, params: unknown) => {
      if (method === 'browser.complete') { const reply = params as RpcParams<'browser.complete'>; completed.set(reply.requestId, reply); }
      return {};
    }),
    on: vi.fn((_name: string, callback: typeof requested) => { requested = callback; return () => {}; }),
  };
  const store = { client, owner: true, machineId: 'test', openThread: { id: 'remote-thread' }, threadKey: (id: string) => id } as unknown as Store;
  const panel = rightPanel.for('remote-thread'), surface = panel.open('browser', 'https://example.test');
  const page = { width: 1000, height: 700, title: 'Fixture', href: 'https://example.test/', origin: 1, dpr: 2, left: 0, top: 350 };
  const protocol = vi.mocked(browserBridge.protocol!);
  protocol.mockImplementation(async (_id, method) => method === 'Page.captureScreenshot' ? { data: '/9j/2Q==' } : { result: { value: page } });
  stop = hostBrowser(store, 'remote-thread');
  expect(client.call).toHaveBeenCalledWith('browser.host', { threadId: 'remote-thread', enabled: true, allowAgentControl: false, remote: true });
  requested({ threadId: 'remote-thread', requestId: 'agent', action: { kind: 'snapshot' } });
  await vi.waitFor(() => expect(completed.get('agent')?.error).toContain('agent browser control is off'));
  requested({ threadId: 'remote-thread', requestId: 'frame', action: { kind: 'remote-frame', maxWidth: 800, quality: 40 } });
  await vi.waitFor(() => expect(completed.get('frame')?.result?.frame?.url).toBe('https://example.test/'));
  const shot = protocol.mock.calls.find(call => call[1] === 'Page.captureScreenshot')![2];
  expect(shot).toMatchObject({ quality: 40, clip: { x: 0, y: 350, width: 1000, height: 700, scale: 0.4 } });
  expect(panel.active?.id).toBe(surface.id);
});
