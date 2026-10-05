import { afterEach, expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { RpcEvents, RpcParams, Settings } from '@boite/contracts';
import { browserProfiles } from './browser-profiles.svelte';
import { hostBrowser } from './browser-host';
import { watchBrowserHosts } from './browser-hosts.svelte';
import { writeExperiments } from './experiments';
import type { Store } from './store.svelte';
import { browserBridge } from './browser-bridge';
import { rightPanel } from './right-panel.svelte';
import { browserTools, DISCARDED_RECORDING_ERROR, runBrowserAction } from './browser-tools.svelte';

const { automateBrowser } = vi.hoisted(() => ({ automateBrowser: vi.fn(async () => ({})) }));
// The page answers at once: the open or navigation has its DOM.
vi.mock('./browser-automation', () => ({ automateBrowser, documentToken: vi.fn(async () => undefined), awaitDocument: vi.fn(async () => ({ state: null, loading: false })) }));
vi.mock('./browser-bridge', () => ({ browserBridge: { protocol: vi.fn(), on: vi.fn(), destroy: vi.fn() } }));
/** A recorder that records at once and keeps a file when stopped; browser-recording.test.ts covers the real one. */
const { recorders } = vi.hoisted(() => ({ recorders: [] as { recording: boolean; disposed: boolean; url: string | null }[] }));
vi.mock('./browser-recording', () => ({ BrowserRecorder: class {
  recording = false; disposed = false; url: string | null = null;
  constructor(_source: unknown, private changed: (active: boolean, result: unknown) => void) { recorders.push(this); }
  async start() { this.recording = true; this.changed(true, null); }
  async stop() {
    const result = { id: 'kept', mime: 'video/mp4', bytes: 4, durationMs: 1000, reason: 'stopped' };
    this.recording = false; this.url = 'blob:kept'; this.changed(false, result); return result;
  }
  dispose() { this.recording = false; this.disposed = true; }
} }));
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; writeExperiments([]); rightPanel.forget('remote-thread'); vi.restoreAllMocks(); automateBrowser.mockClear(); vi.mocked(browserBridge.protocol!).mockReset(); });

test('the desktop grants no browser access by default and stops dispatching as soon as consent is withdrawn', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
  let requested: (request: RpcEvents['browser.requested']) => void = () => {};
  const off = vi.fn();
  const client = { call: vi.fn(async (..._args: unknown[]) => ({})), on: vi.fn((name: string, callback: typeof requested) => { if (name !== 'browser.requested') return () => {}; requested = callback; return off; }) };
  const store = { client, owner: true, machineId: 'test', openThread: { id: 'thread' }, threadKey: (id: string) => id } as unknown as Store;
  hostBrowser(store, 'thread')();
  expect(client.on).not.toHaveBeenCalled();
  expect(client.call).not.toHaveBeenCalled();
  writeExperiments(['agent-browser-control']);
  stop = hostBrowser(store, 'thread');
  expect(client.call).toHaveBeenCalledWith('browser.host', { threadId: 'thread', enabled: true, allowAgentControl: true, remote: false, live: false });
  writeExperiments(['agent-browser-control', 'remote-browser']);
  expect(client.call).toHaveBeenLastCalledWith('browser.host', { threadId: 'thread', enabled: true, allowAgentControl: true, remote: true, live: false });
  writeExperiments(['agent-browser-control']);
  expect(client.call).toHaveBeenLastCalledWith('browser.host', { threadId: 'thread', enabled: true, allowAgentControl: true, remote: false, live: false });
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
  writeExperiments(['agent-browser-control', 'remote-browser']);
  const pro = { id: 'p-0123456789ab', name: 'Pro' };
  browserProfiles.source = { settings: { browserProfiles: [pro], browserDefaultProfile: pro.id } as Settings, saveSettings: async () => true };
  let requested: (request: RpcEvents['browser.requested']) => void = () => {};
  const completed = new Map<string, RpcParams<'browser.complete'>>();
  const client = {
    call: vi.fn(async (method: string, params: unknown) => {
      if (method === 'browser.complete') { const reply = params as RpcParams<'browser.complete'>; completed.set(reply.requestId, reply); }
      return {};
    }),
    on: vi.fn((name: string, callback: typeof requested) => { if (name === 'browser.requested') requested = callback; return () => {}; }),
  };
  const store = { client, owner: true, machineId: 'test', openThread: { id: 'remote-thread' }, threadKey: (id: string) => id } as unknown as Store;
  const panel = rightPanel.for('remote-thread');
  const create = vi.fn();
  Object.assign(browserBridge, { create, isReady: () => true, navigate: vi.fn() });
  try {
    // Hosted from an effect, as App does: opening a tab must not rerun it and release the host.
    stop = $effect.root(() => { $effect(() => hostBrowser(store, 'remote-thread')); });
    flushSync();
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
    flushSync();
    expect(client.call).not.toHaveBeenCalledWith('browser.host', { threadId: 'remote-thread', enabled: false });
    requested({ threadId: 'remote-thread', requestId: 'status', action: { kind: 'status' } });
    await vi.waitFor(() => expect((completed.get('status')?.result?.value as { tabs: { profile: string; profileName: string }[] }).tabs.map(tab => [tab.profile, tab.profileName]))
      .toEqual([[pro.id, 'Pro'], [pro.id, 'Pro'], ['private', browserProfiles.name('private')]]));
  } finally { browserProfiles.source = null; }
});

test('an agent can open and navigate its browser after the desktop selects another conversation', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
  writeExperiments(['agent-browser-control']);
  let requested: (request: RpcEvents['browser.requested']) => void = () => {};
  const client = { call: vi.fn(async (..._args: unknown[]) => ({})), on: vi.fn((name: string, callback: typeof requested) => { if (name === 'browser.requested') requested = callback; return () => {}; }) };
  const store = { client, owner: true, machineId: 'test', openThread: { id: 'remote-thread' }, threadKey: (id: string) => id } as unknown as Store;
  const create = vi.fn(), navigate = vi.fn();
  Object.assign(browserBridge, { create, navigate, isReady: () => true });
  stop = hostBrowser(store, 'remote-thread');
  store.openThread = { id: 'other-thread' } as Store['openThread'];
  requested({ threadId: 'remote-thread', requestId: 'background-open', action: { kind: 'open', url: 'https://example.test' } });
  await vi.waitFor(() => expect(client.call).toHaveBeenCalledWith('browser.complete', expect.objectContaining({ requestId: 'background-open', result: expect.objectContaining({ url: 'https://example.test' }) })));
  const id = rightPanel.for('remote-thread').active!.id;
  requested({ threadId: 'remote-thread', requestId: 'background-nav', tabId: id, action: { kind: 'navigate', url: 'https://example.test/next' } });
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(id, 'https://example.test/next'));
  expect(store.openThread?.id).toBe('other-thread');
  expect(create).toHaveBeenCalledWith(id, 'https://example.test', undefined);
});

test('hosting survives thread and machine switches, then releases on archive, disconnect and consent withdrawal', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
  writeExperiments(['agent-browser-control']);
  const makeStore = (machineId: string) => {
    const client = { call: vi.fn(async (..._args: unknown[]) => ({})), on: vi.fn(() => vi.fn()) };
    const state = $state({ connection: 'ready', openThread: { id: 'one', archived: false }, threads: [{ id: 'one', archived: false }, { id: 'two', archived: false }] });
    const store = { client, owner: true, machineId, threadKey: (id: string) => `${machineId}/${id}`,
      get connection() { return state.connection; }, get threads() { return state.threads; }, get openThread() { return state.openThread; } } as unknown as Store;
    return { store, state, client };
  };
  const first = makeStore('first'), second = makeStore('second');
  stop = watchBrowserHosts(() => [first.store, second.store]);
  flushSync();
  expect(first.client.call).toHaveBeenCalledWith('browser.host', expect.objectContaining({ threadId: 'one', enabled: true }));
  first.state.openThread = { id: 'two', archived: false }; flushSync();
  expect(first.client.call).toHaveBeenCalledWith('browser.host', expect.objectContaining({ threadId: 'two', enabled: true }));
  expect(first.client.call).not.toHaveBeenCalledWith('browser.host', { threadId: 'one', enabled: false });
  expect(second.client.call).not.toHaveBeenCalledWith('browser.host', { threadId: 'one', enabled: false });
  first.state.threads = first.state.threads.filter(thread => thread.id !== 'one'); flushSync();
  expect(first.client.call).toHaveBeenCalledWith('browser.host', { threadId: 'one', enabled: false });
  expect(second.client.call).not.toHaveBeenCalledWith('browser.host', { threadId: 'one', enabled: false });
  first.state.connection = 'disconnected'; flushSync();
  expect(first.client.call).toHaveBeenCalledWith('browser.host', { threadId: 'two', enabled: false });
  first.state.connection = 'ready'; flushSync();
  expect(first.client.call).toHaveBeenLastCalledWith('browser.host', expect.objectContaining({ threadId: 'two', enabled: true }));
  writeExperiments([]); flushSync();
  expect(first.client.call).toHaveBeenLastCalledWith('browser.host', { threadId: 'two', enabled: false });
  expect(second.client.call).toHaveBeenLastCalledWith('browser.host', { threadId: 'one', enabled: false });
});

test('a recording the agent leaves running is discarded when its turn ends; one started from the menu or stopped in time is kept', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
  writeExperiments(['agent-browser-control']);
  const handlers = new Map<string, (payload: unknown) => void>(), completed = new Map<string, RpcParams<'browser.complete'>>();
  const client = {
    call: vi.fn(async (method: string, params: unknown) => {
      if (method === 'browser.complete') { const reply = params as RpcParams<'browser.complete'>; completed.set(reply.requestId, reply); }
      return {};
    }),
    on: vi.fn((name: string, callback: (payload: unknown) => void) => { handlers.set(name, callback); return () => handlers.delete(name); }),
  };
  const store = { client, owner: true, machineId: 'test', openThread: { id: 'recording-thread' }, threadKey: (id: string) => id } as unknown as Store;
  Object.assign(browserBridge, { create: vi.fn(), navigate: vi.fn(), isReady: () => true });
  const panel = rightPanel.for('recording-thread');
  try {
    panel.open('browser', 'https://example.test/agent'); panel.open('browser', 'https://example.test/menu'); panel.open('browser', 'https://example.test/stopped');
    const [agentTab, menuTab, stoppedTab] = panel.surfaces.map(surface => surface.id) as [string, string, string];
    const host = hostBrowser(store, 'recording-thread'); stop = () => host();
    const agent = async (requestId: string, tabId: string, action: RpcEvents['browser.requested']['action']) => {
      handlers.get('browser.requested')!({ threadId: 'recording-thread', requestId, tabId, action });
      await vi.waitFor(() => expect(completed.has(requestId)).toBe(true));
      return completed.get(requestId)!;
    };
    recorders.length = 0;
    expect((await agent('start', agentTab, { kind: 'recording-start' })).error).toBeUndefined();
    await runBrowserAction(menuTab, { kind: 'recording-start' });
    expect((await agent('start-stopped', stoppedTab, { kind: 'recording-start' })).error).toBeUndefined();
    expect((await agent('stop-in-time', stoppedTab, { kind: 'recording-stop' })).result?.recording?.id).toBe('kept');
    const [agentRecorder, menuRecorder, stoppedRecorder] = recorders;
    expect(browserTools(agentTab)).toMatchObject({ recording: true, agent: true });
    expect(browserTools(menuTab)).toMatchObject({ recording: true, agent: false });
    // Another conversation's turn leaves this one's recording alone.
    handlers.get('browser.turnFinished')!({ threadId: 'other-thread' });
    expect(agentRecorder!.recording).toBe(true);
    handlers.get('browser.turnFinished')!({ threadId: 'recording-thread' });
    // Stopped and dropped: nothing to review or download.
    expect(agentRecorder!.disposed).toBe(true);
    expect(browserTools(agentTab)).toMatchObject({ recording: false, result: null, url: null, discarded: true });
    expect(menuRecorder!).toMatchObject({ recording: true, disposed: false });
    expect(stoppedRecorder!.disposed).toBe(false);
    expect(browserTools(stoppedTab)).toMatchObject({ result: { id: 'kept' }, url: 'blob:kept', discarded: false });
    // The agent that comes back for it hears why it is gone.
    expect((await agent('late-stop', agentTab, { kind: 'recording-stop' })).error).toBe(DISCARDED_RECORDING_ERROR);
    expect((await agent('late-read', agentTab, { kind: 'recording-read', recordingId: 'kept', offset: 0 })).error).toBe(DISCARDED_RECORDING_ERROR);
    // The menu's recording stops and is kept, and a new recording clears the notice.
    expect((await runBrowserAction(menuTab, { kind: 'recording-stop' })).recording?.id).toBe('kept');
    expect((await agent('again', agentTab, { kind: 'recording-start' })).error).toBeUndefined();
    expect(browserTools(agentTab)).toMatchObject({ recording: true, agent: true, discarded: false });
    // Archiving or removing the conversation ends the agent's turn too.
    host(true); stop = undefined;
    expect(recorders.at(-1)!.disposed).toBe(true);
    expect(browserTools(agentTab)).toMatchObject({ recording: false, discarded: true });
  } finally { rightPanel.forget('recording-thread'); }
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
    on: vi.fn((name: string, callback: typeof requested) => { if (name === 'browser.requested') requested = callback; return () => {}; }),
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
    on: vi.fn((name: string, callback: typeof requested) => { if (name === 'browser.requested') requested = callback; return () => {}; }),
  };
  const store = { client, owner: true, machineId: 'test', openThread: { id: 'remote-thread' }, threadKey: (id: string) => id } as unknown as Store;
  const panel = rightPanel.for('remote-thread'), surface = panel.open('browser', 'https://example.test');
  const page = { width: 1000, height: 700, title: 'Fixture', href: 'https://example.test/', origin: 1, dpr: 2 };
  const protocol = vi.mocked(browserBridge.protocol!);
  protocol.mockImplementation(async (_id, method) => method === 'Page.captureScreenshot' ? { data: '/9j/2Q==' } : { result: { value: page } });
  stop = hostBrowser(store, 'remote-thread');
  expect(client.call).toHaveBeenCalledWith('browser.host', { threadId: 'remote-thread', enabled: true, allowAgentControl: false, remote: true, live: true });
  requested({ threadId: 'remote-thread', requestId: 'agent', action: { kind: 'snapshot' } });
  await vi.waitFor(() => expect(completed.get('agent')?.error).toContain('agent browser control is off'));
  requested({ threadId: 'remote-thread', requestId: 'frame', action: { kind: 'remote-frame', maxWidth: 800, quality: 40 } });
  await vi.waitFor(() => expect(completed.get('frame')?.result?.frame?.url).toBe('https://example.test/'));
  const shot = protocol.mock.calls.find(call => call[1] === 'Page.captureScreenshot')![2];
  // 2000 pixels for an 800-pixel viewer: captured whole, shrunk on the PC (browser-remote-host.test.ts).
  expect(shot).toMatchObject({ format: 'jpeg', quality: 75 });
  expect(shot).not.toHaveProperty('clip');
  expect(panel.active?.id).toBe(surface.id);
  // A shut panel draws no view: viewers hear the tab is gone, and a frame asks for the panel.
  panel.hide();
  await vi.waitFor(() => expect(client.call).toHaveBeenLastCalledWith('browser.host', { threadId: 'remote-thread', enabled: true, allowAgentControl: false, remote: true, live: false }), { timeout: 2500 });
  requested({ threadId: 'remote-thread', requestId: 'shut', action: { kind: 'remote-frame' } });
  await vi.waitFor(() => expect(completed.get('shut')?.error).toContain('open a browser tab'));
  panel.activate(surface.id);
  await vi.waitFor(() => expect(client.call).toHaveBeenLastCalledWith('browser.host', { threadId: 'remote-thread', enabled: true, allowAgentControl: false, remote: true, live: true }), { timeout: 2500 });
  // Paired devices hear within a second that the conversation has no browser tab left.
  panel.close(surface.id);
  await vi.waitFor(() => expect(client.call).toHaveBeenLastCalledWith('browser.host', { threadId: 'remote-thread', enabled: true, allowAgentControl: false, remote: true, live: false }), { timeout: 2500 });
});
