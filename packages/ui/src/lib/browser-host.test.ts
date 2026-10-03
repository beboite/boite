import { afterEach, expect, test, vi } from 'vitest';
import type { RpcEvents, RpcParams, Settings } from '@boite/contracts';
import { browserProfiles } from './browser-profiles.svelte';
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

test('an agent lists the profiles and opens a tab in the one it names, the default one otherwise', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
  writeExperiments(['agent-browser-control']);
  const pro = { id: 'p-0123456789ab', name: 'Pro' };
  browserProfiles.source = { settings: { browserProfiles: [pro], browserDefaultProfile: pro.id } as Settings, saveSettings: async () => true };
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
  const panel = rightPanel.for('remote-thread');
  const create = vi.fn();
  Object.assign(browserBridge, { create, isReady: () => true, navigate: vi.fn() });
  try {
    stop = hostBrowser(store, 'remote-thread');
    requested({ threadId: 'remote-thread', requestId: 'list', action: { kind: 'profiles' } });
    await vi.waitFor(() => expect(completed.get('list')?.result?.value).toEqual({ default: pro.id, profiles: [
      { id: 'default', name: browserProfiles.name('default'), kept: true }, { ...pro, kept: true }, { id: 'private', name: browserProfiles.name('private'), kept: false }
    ] }));
    for (const [requestId, profile, expected] of [['named', 'pro', pro.id], ['unnamed', undefined, pro.id], ['private', 'private', 'private']] as const) {
      requested({ threadId: 'remote-thread', requestId, action: { kind: 'open', url: 'https://tripo.ai', ...(profile ? { profile } : {}) } });
      await vi.waitFor(() => expect(completed.get(requestId)?.result?.profile).toBe(expected));
      expect(create).toHaveBeenLastCalledWith(panel.active?.id, 'https://tripo.ai', expected);
    }
    requested({ threadId: 'remote-thread', requestId: 'unknown', action: { kind: 'open', url: 'https://tripo.ai', profile: 'Perso' } });
    await vi.waitFor(() => expect(completed.get('unknown')?.error).toContain('no browser profile is named Perso'));
    expect(panel.surfaces).toHaveLength(3);
    requested({ threadId: 'remote-thread', requestId: 'status', action: { kind: 'status' } });
    await vi.waitFor(() => expect((completed.get('status')?.result?.value as { tabs: { profile: string; profileName: string }[] }).tabs.map(tab => [tab.profile, tab.profileName]))
      .toEqual([[pro.id, 'Pro'], [pro.id, 'Pro'], ['private', browserProfiles.name('private')]]));
  } finally { browserProfiles.source = null; }
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
