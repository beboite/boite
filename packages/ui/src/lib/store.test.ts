import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PROTOCOL_VERSION, RpcErrorCode, type ThreadStatus } from '@boite/contracts';
import { RpcFailure } from './client';
import { FakeClient } from './fake-client';
import { setNotificationSender, type Toast } from './notify';
import * as endpoints from './endpoint';
import { LOCAL_RECOVERY_MS, resumeAnchor, Store } from './store.svelte';
import { strings } from './strings';
import { confirm } from './confirm.svelte';
import { browserBridge } from './browser-bridge';
import { rightPanel } from './right-panel.svelte';
import { readStoredEndpoint, storeEndpoint } from './endpoint';

test('changing a Store endpoint drops the previous machine composer and element callbacks', async () => {
  const { store, client } = await ready();
  const saved = Object.entries(localStorage);
  const connect = vi.spyOn(store, 'connect').mockResolvedValue();
  const open = vi.spyOn(store, 'openWhereLeft').mockResolvedValue();
  const insert = vi.fn();
  const reference = { id: 'save', url: 'https://first.test', selector: '#save', text: 'Save', bounds: { x: 0, y: 0, width: 30, height: 20 } };
  store.editComposerText('same', 'First machine');
  store.addPreviewReference('same', reference);
  store.registerComposerInsertion('same', insert);
  try {
    await store.connectTo('https://second.test', 'fixture-token');
    expect(store.composerStates).toEqual({});
    store.addPreviewReference('same', { ...reference, url: 'https://second.test' });
    expect(insert).not.toHaveBeenCalled();
    expect(store.composerStates.same?.text).toBe('@Save');
  } finally {
    connect.mockRestore(); open.mockRestore();
    store.client?.close(); store.detach(); client.close();
    localStorage.clear();
    for (const [key, value] of saved) localStorage.setItem(key, value);
  }
});

test('dropped folders use the local core when a remote machine is selected', async () => {
  const { store, client: remote } = await ready();
  const local = new FakeClient({ delayMs: 0 });
  const remoteCall = vi.spyOn(remote, 'call');
  const localCall = vi.spyOn(local, 'call');
  window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
  store.localCore = false;
  const switchLocal = vi.spyOn(store, 'useLocalCore').mockImplementation(async () => {
    store.attach(local);
    store.localCore = true;
    await store.connect();
  });
  try {
    await store.addProjects(['D:\\work\\dropped folder']);
    expect(switchLocal).toHaveBeenCalledOnce();
    expect(remoteCall.mock.calls.filter(([method]) => method === 'projects.add')).toHaveLength(0);
    expect(localCall).toHaveBeenCalledWith('projects.add', { path: 'D:\\work\\dropped folder' });
    expect(store.openProject?.path).toBe('D:\\work\\dropped folder');
  } finally {
    delete window.__TAURI_INTERNALS__;
    store.detach(); remote.close(); local.close();
  }
});

test('a machine switched under a slow boot loads the new one instead of joining the old load', async () => {
  const slow = new FakeClient({ delayMs: 20 });
  const fresh = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(slow);
  await store.connect();
  try {
    const first = store.reload();
    store.attach(fresh);
    const asked = vi.spyOn(fresh, 'call');
    // The load in flight belongs to the machine that started it, and its
    // results are dropped on landing. Handing the same promise to the new
    // machine meant the new machine was never asked for anything at all.
    await Promise.all([store.connect(), first]);
    expect(asked.mock.calls.map(([method]) => method)).toContain('projects.list');
    expect(store.error).toBe(null);
  } finally {
    store.detach(); slow.close(); fresh.close();
  }
});

async function ready(): Promise<{ store: Store; client: FakeClient }> {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  return { store, client };
}

test('delegation selection keeps one child subscription and ignores an overtaken A-B-A response', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  const real = client.call.bind(client);
  let releaseFirstA: (() => void) | null = null;
  let heldFirstA = true;
  const asked = vi.spyOn(client, 'call').mockImplementation(((method: string, params: { threadId?: string }) => {
    if (method === 'threads.subscribe' && params.threadId === 't-team-running' && heldFirstA) {
      heldFirstA = false;
      return new Promise(resolve => { releaseFirstA = () => { void real(method as never, params as never).then(resolve); }; });
    }
    return real(method as never, params as never);
  }) as typeof client.call);
  store.attach(client);
  try {
    await store.connect();
    await store.open('t-trace');
    await store.loadDelegation('t-trace');
    const first = store.selectDelegatedAgent('t-team-running');
    await vi.waitFor(() => expect(releaseFirstA).not.toBeNull());
    await store.selectDelegatedAgent('t-team-done');
    await store.selectDelegatedAgent('t-team-running');
    releaseFirstA!();
    await first;
    expect(store.delegationSelectedAgentId).toBe('t-team-running');
    expect(store.delegationThread?.id).toBe('t-team-running');
    const unsubscribed = asked.mock.calls.filter(([method, params]) => method === 'threads.unsubscribe' && (params as { threadId?: string }).threadId === 't-team-running');
    expect(unsubscribed).toHaveLength(0);
  } finally { store.detach(); client.close(); }
});

test('recent-thread recovery does not open delegated children', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  try {
    await store.connect();
    await store.openWhereLeft();
    expect(store.openThread?.parentThreadId).toBeFalsy();
  } finally { store.detach(); client.close(); }
});

test('a later navigation wins while the previous agent subscription is being released', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  let release: (() => void) | undefined;
  try {
    await store.connect();
    await store.open('t-trace');
    await store.selectDelegatedAgent('t-team-running');
    const real = client.call.bind(client);
    vi.spyOn(client, 'call').mockImplementation(((method: string, params: { threadId?: string }) => {
      if (method === 'threads.unsubscribe' && params.threadId === 't-team-running') {
        return new Promise(resolve => { release = () => { void real(method as never, params as never).then(resolve); }; });
      }
      return real(method as never, params as never);
    }) as typeof client.call);
    const older = store.open('t-descriptors');
    await vi.waitFor(() => expect(release).toBeDefined());
    await store.open('t-trace');
    release!();
    await older;
    expect(store.openThread?.id).toBe('t-trace');
  } finally { store.detach(); client.close(); }
});

test('reloading the current conversation keeps the selected agent transcript subscribed', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  try {
    await store.connect();
    await store.open('t-trace');
    await store.selectDelegatedAgent('t-team-running');
    const called = vi.spyOn(client, 'call');
    await store.reload();
    expect(store.openThread?.id).toBe('t-trace');
    expect(store.delegationSelectedAgentId).toBe('t-team-running');
    expect(store.delegationThread?.id).toBe('t-team-running');
    expect(called).not.toHaveBeenCalledWith('threads.unsubscribe', { threadId: 't-team-running' });
  } finally { store.detach(); client.close(); }
});

test('a reconnect catches up the agent transcript and the team statuses the gap missed', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  try {
    await store.connect();
    await store.open('t-trace');
    await store.loadDelegation('t-trace');
    await store.selectDelegatedAgent('t-team-running');
    const answer = store.delegationThread!.messages.at(-1)!;
    const full = (answer.parts[0] as { text: string }).text;
    // What the gap loses: the end of a streamed reply and a status change.
    answer.parts = [{ type: 'text', text: 'I found the' }];
    store.delegation!.agents.find((agent) => agent.thread.id === 't-team-running')!.thread.status = 'idle';
    const called = vi.spyOn(client, 'call');
    client.drop();
    await client.restore();
    await waitFor(() => (store.delegation?.agents.find((agent) => agent.thread.id === 't-team-running')?.thread.status === 'running' ? true : undefined));
    await waitFor(() => ((store.delegationThread?.messages.at(-1)?.parts[0] as { text?: string } | undefined)?.text === full ? true : undefined));
    expect(store.delegationSelectedAgentId).toBe('t-team-running');
    expect(store.delegationThread?.messages.map((message) => message.id)).toEqual(['m-t-team-running-1', 'm-t-team-running-2']);
    expect(called).toHaveBeenCalledWith('threads.get', { threadId: 't-team-running', after: 'm-t-team-running-1' });
  } finally { store.detach(); client.close(); }
});

test('starting a draft cancels a pending child subscription even without an open subscription', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  let release: (() => void) | undefined;
  try {
    await store.connect();
    store.startDraft('p-boite');
    const real = client.call.bind(client);
    const called = vi.spyOn(client, 'call').mockImplementation(((method: string, params: { threadId?: string }) => {
      if (method === 'threads.subscribe' && params.threadId === 't-team-running') {
        return new Promise(resolve => { release = () => { void real(method as never, params as never).then(resolve); }; });
      }
      return real(method as never, params as never);
    }) as typeof client.call);
    const selecting = store.selectDelegatedAgent('t-team-running');
    await vi.waitFor(() => expect(release).toBeDefined());
    store.startDraft('p-boite');
    release!();
    await selecting;
    expect(store.delegationSelectedAgentId).toBeNull();
    expect(store.delegationThread).toBeNull();
    expect(called).toHaveBeenCalledWith('threads.unsubscribe', { threadId: 't-team-running' });
  } finally { store.detach(); client.close(); }
});

test.each([false, true])('the chat and agent panel receive complete streaming updates, shared snapshot: %s', async (shared) => {
  const { store, client } = await ready();
  try {
    await store.open('t-trace');
    await store.selectDelegatedAgent('t-trace');
    if (shared) store.delegationThread = store.openThread;
    else client.on('message.started', () => {
      // A separate threads.get snapshot can land between the start and first delta.
      store.delegationThread = JSON.parse(JSON.stringify(store.openThread));
    });
    await store.send('[tool] one streamed answer');
    await client.settled();
    for (const snapshot of [store.openThread, store.delegationThread]) {
      expect(snapshot?.messages.at(-1)?.state).toBe('complete');
      const parts = snapshot?.messages.at(-1)?.parts ?? [];
      expect(parts.filter(part => part.type !== 'tool')).toEqual([
        { type: 'thinking', text: 'thinking about: [tool] one streamed answer' },
        { type: 'text', text: '[tool] one streamed answer' }
      ]);
      expect(parts.find(part => part.type === 'tool')).toMatchObject({ status: 'done' });
      expect(snapshot?.turns.at(-1)?.status).toBe('done');
    }
  } finally { store.detach(); client.close(); }
});

test('a replacement part followed by a delta is appended once in each independent snapshot', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const handlers = new Map<string, (payload: never) => void>();
  const on = client.on.bind(client);
  vi.spyOn(client, 'on').mockImplementation(((event: string, handler: (payload: never) => void) => {
    handlers.set(event, handler);
    return on(event as never, handler);
  }) as typeof client.on);
  const store = new Store();
  store.attach(client);
  try {
    await store.connect();
    await store.open('t-trace');
    await store.selectDelegatedAgent('t-trace');
    const messageId = store.openThread!.messages.at(-1)!.id;
    const target = { threadId: 't-trace', messageId, partIndex: 0 };
    handlers.get('message.part')!({ ...target, part: { type: 'text', text: 'hello' } } as never);
    handlers.get('message.delta')!({ ...target, text: ' world' } as never);
    for (const snapshot of [store.openThread, store.delegationThread]) {
      expect(snapshot!.messages.at(-1)!.parts[0]).toEqual({ type: 'text', text: 'hello world' });
    }
  } finally { store.detach(); client.close(); }
});

test('launching from a child refreshes its team and returns the sibling without another spawn', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  try {
    await store.connect();
    await store.open('t-team-done');
    await store.loadDelegation();
    const profile = store.delegation!.config.profiles[0]!;
    const agent = await store.spawnDelegatedAgent(profile.id, 'Review the error path');
    expect(agent).not.toBeNull();
    expect(agent?.thread.parentThreadId).toBe('t-trace');
    expect(store.openThread?.id).toBe('t-team-done');
    expect(store.delegation?.agents).toHaveLength(3);
    expect(store.delegation?.agents.some(entry => entry.thread.id === agent?.thread.id)).toBe(true);
    const call = client.call.bind(client);
    vi.spyOn(client, 'call').mockImplementation((async (method, params) => {
      if (method === 'delegation.configure') throw new Error('Configuration refused');
      return call(method, params);
    }) as typeof client.call);
    await store.configureDelegation(store.delegation!.config);
    expect(store.delegationError).toBe('Configuration refused');
  } finally { store.detach(); client.close(); }
});

test('switching conversations clears the old team and refuses missing or mismatched child views', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  try {
    await store.connect();
    await store.open('t-trace');
    await store.loadDelegation();
    const previous = store.delegation!;
    await store.open('t-bench');
    expect(store.delegation).toBeNull();
    const called = vi.spyOn(client, 'call');
    store.delegation = previous;
    await store.configureDelegation(previous.config);
    expect(await store.spawnDelegatedAgent('reviewer', 'Do not launch on the old team')).toBeNull();
    expect(await store.messageDelegatedAgent('t-team-running', 'Do not steer the old team')).toBe(false);
    await store.stopDelegatedAgent();
    expect(called.mock.calls.filter(([method]) => ['delegation.configure', 'delegation.spawn', 'delegation.send', 'delegation.stop'].includes(method))).toEqual([]);
    await store.open('t-team-done');
    store.delegation = null;
    called.mockClear();
    await store.configureDelegation(previous.config);
    expect(await store.spawnDelegatedAgent('reviewer', 'Wait for this child team')).toBeNull();
    expect(called.mock.calls).toEqual([]);
  } finally { store.detach(); client.close(); }
});

test('telemetry actions route through the owning client and retain deletion state', async () => {
  const { store, client } = await ready();
  const other = new FakeClient({ delayMs: 0 });
  try {
    expect(await store.telemetryState()).toMatchObject({ mode: 'basic', pendingDeletion: false });
    await store.configureTelemetry('enhanced');
    expect(await store.exportTelemetry()).toEqual({ events: [], truncated: false });
    expect(await store.configureTelemetry('off')).toMatchObject({ mode: 'off', pendingDeletion: true });
    expect(await store.configureTelemetry('enhanced')).toMatchObject({ mode: 'enhanced', pendingDeletion: true });
    expect(await store.retryTelemetryDeletion()).toMatchObject({ pendingDeletion: false });
    await store.configureTelemetry('enhanced');
    store.attach(other);
    await store.connect();
    expect(await store.telemetryState()).toMatchObject({ mode: 'basic' });
    expect(await client.call('telemetry.state', {})).toMatchObject({ mode: 'enhanced' });
  } finally { store.detach(); client.close(); other.close(); }
});

test('uninstalled setup starts without account-dependent demo state', async () => {
  const client = new FakeClient({ delayMs: 0, uninstalled: true });
  const store = new Store();
  store.attach(client);
  try {
    await store.connect();
    await store.openWhereLeft();
    expect(store.accounts).toEqual([]);
    expect(store.threads).toEqual([]);
    expect(store.openThread).toBeNull();
    expect(await client.call('scheduler.get', {})).toMatchObject({ running: [], queued: [] });
    // No folder yet: the app lands on a draft in the drafts, which nothing has made.
    expect(store.projects).toEqual([]);
    expect(store.draft).toEqual({ projectId: null, worktree: false });
    expect((await client.call('sessions.list', {})).length).toBeGreaterThan(0);
  } finally { store.detach(); client.close(); }
});

test('a drafts folder asked of a machine left since fails there, not on the new one', async () => {
  const { store, client } = await ready();
  const other = new FakeClient({ delayMs: 0 });
  const real = client.call.bind(client);
  let reject: (error: Error) => void = () => {};
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'projects.drafts') return new Promise((_, no) => { reject = no; });
    return real(method as never, params as never);
  }) as typeof client.call);
  try {
    store.draft = { projectId: null, worktree: false };
    const sent = store.submit('Sort my photos', { providerId: 'echo', accountId: 'a-echo', permissionMode: 'default', model: 'echo-1', effort: null });
    await vi.waitFor(() => expect(client.call).toHaveBeenCalledWith('projects.drafts', {}));
    store.attach(other);
    await store.connect();
    // Closing the old socket rejects its call: that is not the new machine's error.
    reject(new Error('client closed'));
    expect(await sent).toBe(false);
    expect(store.error).toBeNull();
  } finally { store.detach(); client.close(); other.close(); }
});

test('provider actions report RPC failures through their owning store', async () => {
  const { store, client } = await ready();
  vi.spyOn(client, 'call').mockRejectedValue(new Error('provider unavailable'));
  try {
    expect(await store.installProvider('claude')).toBe(false);
    expect(store.error).toContain('provider unavailable');
    store.error = null;
    expect(await store.reloadProviders()).toBe(false);
    expect(store.error).toContain('provider unavailable');
  } finally { store.detach(); client.close(); }
});

test('a refusal reaches the surface without its JSON-RPC code', async () => {
  const { store, client } = await ready();
  const refusal = new RpcFailure({ code: RpcErrorCode.Refused, message: 'This account is no longer available.' });
  vi.spyOn(client, 'call').mockRejectedValue(refusal);
  try {
    expect(await store.installProvider('claude')).toBe(false);
    // The code said nothing to the person reading the toast, and it used to
    // ride along as `(-32011)` on every refusal.
    expect(store.error).toBe('This account is no longer available.');
  } finally { store.detach(); client.close(); }
});

test('one failed boot call leaves every other slice loaded', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  const real = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'providers.list') {
      return Promise.reject(new RpcFailure({ code: RpcErrorCode.Internal, message: 'providers are unreadable' }));
    }
    return real(method as never, params as never);
  }) as typeof client.call);
  store.attach(client);
  try {
    await store.connect();
    // `Promise.all` used to jump to the catch here, leaving threads, projects
    // and settings on their pre-reconnect values under a loaded-looking app.
    expect(store.threads.length).toBeGreaterThan(0);
    expect(store.projects.length).toBeGreaterThan(0);
    expect(store.error).toBe('providers are unreadable');
  } finally { store.detach(); client.close(); }
});

test.each(['same', 'selection', 'kind'])('a lost start response reuses its request id only for identical content and selection: %s', async (change) => {
  const { store, client } = await ready();
  const original = client.call.bind(client);
  const requests: string[] = [];
  let loseResponse = true;
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === 'turns.start') {
      requests.push((params as { clientRequestId: string }).clientRequestId);
      if (loseResponse) { loseResponse = false; throw new Error('connection lost'); }
    }
    return result;
  });
  try {
    const thread = store.threads.find(thread => thread.status === 'idle')!;
    await store.open(thread.id);
    const attachments = change === 'kind' ? [{ kind: 'image' as const, mimeType: 'image/png' as const, data: 'YWJj', name: 'test.png' }] : [];
    expect(await store.send('Retry this prompt', thread.id, attachments)).toBe(false);
    if (change === 'kind') await client.settled();
    if (change === 'selection') {
      await client.settled();
      expect(await store.update(thread.id, { effort: 'low' })).toBe(true);
    }
    expect(await store.send('Retry this prompt', thread.id, change === 'kind' ? attachments.map(a => ({ ...a, kind: 'file' as const })) : attachments)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBeTruthy();
    expect(requests[1] === requests[0]).toBe(change === 'same');
  } finally { store.detach(); client.close(); }
});

test.each(['input', 'inputText', 'output', 'documents'])('reading cache excludes oversized tool %s', async (field) => {
  const { store, client } = await ready();
  try {
    await store.open('t-bench');
    const large = 'x'.repeat(2 * 1024 * 1024 + 1);
    const part: any = { type: 'tool', toolId: 'large', name: 'read', input: {}, output: null, status: 'done' };
    part[field] = field === 'documents' ? [{ kind: 'markdown', text: large }] : field === 'input' ? { nested: { text: large } } : large;
    store.openThread!.messages.unshift({ id: 'cached-only', threadId: 't-bench', turnId: 'old', role: 'assistant', parts: [part], state: 'complete', createdAt: 0 });
    await store.open('t-scheduler');
    await store.open('t-bench');
    expect(store.openThread!.messages.some(message => message.id === 'cached-only')).toBe(false);
  } finally { store.detach(); client.close(); }
});

describe('Store', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('opens on the seeded core', async () => {
    const { store } = await ready();

    expect(store.connection).toBe('ready');
    expect(store.core?.version).toBe('2.0.0-beta.1');
    expect(store.projects.map((p) => p.id)).toEqual(['p-boite', 'p-notes']);
    expect(store.threads).toHaveLength(4);
    // Two seeded threads wait: one on a permission, one on a question.
    expect(store.threads.map((t) => t.status).sort()).toEqual([
      'idle',
      'idle',
      'waiting',
      'waiting'
    ]);
    expect(store.pendingPermissions.map((p) => p.id)).toEqual(['req-seed-1']);
    expect(store.pendingQuestions.map((q) => q.id)).toEqual(['qst-seed-1']);
    expect(store.unreadCount).toBe(1);
  });

  test('a draft with the worktree switch on sends the option once, and a project change keeps it', async () => {
    const { store, client } = await ready();
    store.startDraft('p-boite');
    expect(store.draft?.worktree).toBe(false);
    store.setDraftWorktree(true);
    store.setDraftProject('p-notes');
    expect(store.draft).toEqual({ projectId: 'p-notes', worktree: true });

    const spy = vi.spyOn(client, 'call');
    await store.submit('Fix the login', {
      providerId: 'echo',
      accountId: 'a-echo',
      permissionMode: 'default',
      model: 'echo-1',
      effort: null
    });
    const create = spy.mock.calls.find(([method]) => method === 'threads.create');
    expect(create?.[1]).toMatchObject({ projectId: 'p-notes', title: 'Fix the login', worktree: {} });
    expect(store.openThread?.branch).toBe('boite/fix-the-login');
    expect(store.draft).toBeNull();

    // The next draft starts with the switch off: a worktree is a decision each time.
    store.startDraft('p-notes');
    expect(store.draft?.worktree).toBe(false);
  });

  test('opening a thread clears its unread badge', async () => {
    const { store } = await ready();

    await store.open('t-descriptors');

    expect(store.openThread?.id).toBe('t-descriptors');
    expect(store.openThread?.unread).toBe(false);
    expect(store.threads.find((t) => t.id === 't-descriptors')?.unread).toBe(false);
    expect(store.unreadCount).toBe(0);
  });

  test('a turn finishing on a thread that is not open sends a toast, the open one does not', async () => {
    const sent: Toast[] = [];
    setNotificationSender(async (toast) => {
      sent.push(toast);
    });
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      const { store, client } = await ready();
      await store.open('t-descriptors');

      await client.call('turns.start', { threadId: 't-trace', prompt: 'quietly' });
      await client.settled();
      expect(sent).toEqual([{ title: 'Finish the trace tab', body: 'Done', threadId: 't-trace', coreThreadId: 't-trace' }]);

      await store.send('in front of me');
      await client.settled();
      expect(sent).toHaveLength(1);

      // The switch off: a background turn says nothing.
      await store.setNotifications(false);
      await client.call('turns.start', { threadId: 't-trace', prompt: 'silence' });
      await client.settled();
      expect(sent).toHaveLength(1);
    } finally {
      focused.mockRestore();
      setNotificationSender(null);
    }
  });

  test('a pinned thread floats above the live ones of its project, and unpinning drops it back', async () => {
    const { store } = await ready();
    const project = store.threads.find((t) => t.id === 't-trace')?.projectId ?? '';
    const before = store.sortedThreadsOf(project).map((t) => t.id);
    expect(before[0]).not.toBe('t-trace');

    await store.pin('t-trace', true);
    expect(store.threads.find((t) => t.id === 't-trace')?.pinned).toBe(true);
    expect(store.sortedThreadsOf(project)[0]?.id).toBe('t-trace');

    await store.pin('t-trace', false);
    expect(store.sortedThreadsOf(project).map((t) => t.id)).toEqual(before);
  });

  test('a prompt streams into one text part and the thread goes running then idle', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');

    const seen: ThreadStatus[] = [];
    client.on('thread.updated', (summary) => {
      if (summary.id === 't-trace') seen.push(summary.status);
    });

    const before = store.openThread?.messages.length ?? 0;
    await store.send('read the trace note');
    await client.settled();

    expect(seen).toContain('running');
    expect(seen.at(-1)).toBe('idle');
    expect(store.openThread?.status).toBe('idle');

    const messages = store.openThread?.messages ?? [];
    expect(messages).toHaveLength(before + 2);

    const assistant = messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.state).toBe('complete');
    // The fake reasons before it answers, like a provider that streams thinking.
    expect(assistant?.parts).toEqual([
      { type: 'thinking', text: 'thinking about: read the trace note' },
      { type: 'text', text: 'read the trace note' }
    ]);
  });

  test('only the open thread streams, and the previous one is dropped', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');
    await store.open('t-descriptors');

    const deltas: string[] = [];
    client.on('message.delta', (delta) => deltas.push(delta.threadId));

    await client.call('turns.start', { threadId: 't-trace', prompt: 'nobody is watching' });
    await client.settled();

    expect(deltas).toEqual([]);
    expect(store.threads.find((t) => t.id === 't-trace')?.unread).toBe(true);
  });

  test('a tool part and a permission part land in the open thread', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');

    void store.send('[tool] and [permission] please');
    await Promise.resolve();

    // The seeded core already waits on one elsewhere, so pick this thread's.
    const pending = await waitFor(() => store.pendingPermissions.find((p) => p.threadId === 't-trace'));
    expect(pending.toolName).toBe('Write');

    await store.answer(pending.id, 'allow');
    await client.settled();

    const parts = store.openThread?.messages.at(-1)?.parts ?? [];
    expect(parts.map((p) => p.type)).toEqual(['thinking', 'text', 'permission', 'tool']);
    const permission = parts[2];
    expect(permission?.type === 'permission' && permission.decision).toBe('allow');
    const tool = parts[3];
    expect(tool?.type === 'tool' && tool.status).toBe('done');
  });

  test('a project removed elsewhere drops it, its threads and the open thread', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');
    expect(store.openThread?.projectId).toBe('p-boite');

    // Straight through the client, the way another connection's removal arrives.
    await client.call('projects.remove', { projectId: 'p-boite' });

    expect(store.projects.map((p) => p.id)).toEqual(['p-notes']);
    expect(store.threads.every((t) => t.projectId !== 'p-boite')).toBe(true);
    const reopened = await waitFor(() => store.openThread ?? undefined);
    expect(reopened.projectId).toBe('p-notes');
  });

  test('cached models survive reload and remain visible during a forced refresh', async () => {
    const first = await ready();
    await first.store.probeModels('opencode', 'a-opencode');
    const expected = first.store.modelsOf('opencode', 'a-opencode');
    first.store.detach();
    const { store, client } = await ready();
    expect(store.modelsOf('opencode', 'a-opencode')).toEqual(expected);
    const original = client.call.bind(client);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
      if (method === 'providers.probe') await gate;
      return original(method, params);
    });
    const request = store.probeModels('opencode', 'a-opencode', true);
    expect(store.isProbing('opencode', 'a-opencode')).toBe(true);
    expect(store.modelsOf('opencode', 'a-opencode')).toEqual(expected);
    const second = store.probeModels('opencode', 'a-opencode', true);
    expect(calls.mock.calls.filter(([method]) => method === 'providers.probe')).toHaveLength(1);
    release(); await Promise.all([request, second]);
    expect(calls).toHaveBeenCalledWith('providers.probe', { providerId: 'opencode', accountId: 'a-opencode', refresh: true });
  });

  test('failed probes wait for manual retry instead of looping', async () => {
    const { store, client } = await ready();
    const calls = vi.spyOn(client, 'call').mockRejectedValue(new Error('agent offline'));
    await store.probeModels('opencode', 'a-opencode');
    await store.probeModels('opencode', 'a-opencode');
    expect(calls).toHaveBeenCalledTimes(1);
    await store.probeModels('opencode', 'a-opencode', true);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  test('a probe the core refused because the account changed meanwhile is no error, and runs again', async () => {
    const { store, client } = await ready();
    const original = client.call.bind(client);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
      if (method !== 'providers.probe') return original(method, params);
      await gate;
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the provider or account changed during discovery; refresh models' });
    });
    const request = store.probeModels('opencode', 'a-opencode');
    // A check that finds the same status is silent, as on the core; a login
    // changed under the account is announced and is what outdates the probe.
    await original('accounts.check', { accountId: 'a-opencode' });
    client.announceLogin('a-opencode');
    release(); await request;
    expect(store.error).toBeNull();
    calls.mockRestore();
    await store.probeModels('opencode', 'a-opencode');
    expect(Object.keys(store.probedModels)).toEqual(['opencode::a-opencode']);
  });

  test('a probe elsewhere fills the models of that instance, the descriptor until then', async () => {
    const { store, client } = await ready();
    expect(store.modelsOf('opencode', 'a-opencode').map((m) => m.id)).toEqual(['default']);
    expect(store.probedModels).toEqual({});

    // Straight through the client: what a second shell's probe looks like here.
    await client.call('providers.probe', { providerId: 'opencode', accountId: 'a-opencode' });

    expect(Object.keys(store.probedModels)).toEqual(['opencode::a-opencode']);
    const probed = store.modelsOf('opencode', 'a-opencode').map((m) => m.id);
    expect(probed.length).toBe(23);
    expect(probed.slice(0, 3)).toEqual(['default', 'anthropic/claude-sonnet-5', 'openai/gpt-5-codex']);
    // A provider that is not ACP keeps the descriptor's list either way.
    expect(store.modelsOf('echo', 'a-echo').map((m) => m.id)).toEqual(['echo-1']);
  });

  test('a long thread opens on its last page and loadOlder walks back in order', async () => {
    const client = new FakeClient({ delayMs: 0, long: true });
    const store = new Store();
    store.attach(client);
    await store.connect();

    await store.open('t-long');

    // The last page, not the four hundred messages.
    expect(store.openThread?.messages).toHaveLength(120);
    expect(store.openThread?.messages.at(0)?.id).toBe('m-long-280');
    expect(store.openThread?.messages.at(-1)?.id).toBe('m-long-399');
    expect(store.messagesBefore).toBe('m-long-280');

    expect(await store.loadOlder()).toBe(120);
    expect(store.openThread?.messages).toHaveLength(240);
    expect(store.messagesBefore).toBe('m-long-160');

    expect(await store.loadOlder()).toBe(120);
    const messages = store.openThread?.messages ?? [];
    expect(messages).toHaveLength(360);
    expect(messages.at(0)?.id).toBe('m-long-40');
    expect(messages.at(-1)?.id).toBe('m-long-399');
    expect(store.messagesBefore).toBe('m-long-40');
    expect(store.loadingOlder).toBe(false);

    // In order, no gap, no duplicate.
    const numbers = messages.map((message) => Number(message.id.replace('m-long-', '')));
    expect(new Set(numbers).size).toBe(360);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers[0]).toBe(40);
  });

  test('loadOlder stops at the first message and does nothing without a cursor', async () => {
    const client = new FakeClient({ delayMs: 0, long: true });
    const store = new Store();
    store.attach(client);
    await store.connect();
    await store.open('t-long');

    let rounds = 0;
    while (store.messagesBefore !== null) {
      await store.loadOlder();
      rounds += 1;
      if (rounds > 10) throw new Error('the cursor never reached the first message');
    }

    // 120 on open, then 120, 120 and the last 40.
    expect(rounds).toBe(3);
    expect(store.openThread?.messages).toHaveLength(400);
    expect(store.openThread?.messages.at(0)?.id).toBe('m-long-0');
    expect(await store.loadOlder()).toBe(0);
  });

  test('a short thread opens whole, with no cursor to walk', async () => {
    const { store } = await ready();
    await store.open('t-trace');

    expect(store.messagesBefore).toBeNull();
    expect(await store.loadOlder()).toBe(0);
  });

  test('settings changed elsewhere replace the ones the UI holds', async () => {
    const { store, client } = await ready();
    expect(store.settings?.maxConcurrentTurns).not.toBe(9);

    await client.call('settings.set', { maxConcurrentTurns: 9 });

    expect(store.settings?.maxConcurrentTurns).toBe(9);
  });

  test('the newest open wins, and the socket is left holding that thread alone', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');

    // Two clicks inside one round trip. The second is the one the user made.
    await Promise.all([store.open('t-bench'), store.open('t-scheduler')]);

    expect(store.openThread?.id).toBe('t-scheduler');
    // Nobody is looking at the trace, so opening reads none and drops the last thread's.
    expect(store.trace).toEqual([]);
    await store.refreshTrace();
    expect(store.trace).toEqual(await client.call('trace.get', { threadId: 't-scheduler' }));
    expect(client.coreSubscribers).toEqual(['t-scheduler']);
    expect(client.clientSubscriptions).toEqual(['t-scheduler']);
  });

  test('a refused subscribe leaves the thread that was open subscribed', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');

    // Archived elsewhere between the render and the click: the core refuses it.
    await store.open('t-gone');

    expect(store.error).toMatch(/no such thread/i);
    expect(store.openThread?.id).toBe('t-trace');
    expect(client.coreSubscribers).toEqual(['t-trace']);
    expect(client.clientSubscriptions).toEqual(['t-trace']);
  });

  test('a request the core settled while the socket was down leaves the card', async () => {
    const { store, client } = await ready();
    await store.open('t-scheduler');
    expect(store.pendingQuestions.map((q) => q.id)).toEqual(['qst-seed-1']);
    expect(store.pendingPermissions.map((p) => p.id)).toEqual(['req-seed-1']);

    // The core's recovery ends both turns into a socket nobody is holding.
    client.drop();
    client.clearRequestsOf('t-scheduler');
    client.clearRequestsOf('t-bench');
    await client.restore();
    await waitFor(() => (store.pendingQuestions.length === 0 ? true : undefined));

    expect(store.pendingQuestions).toEqual([]);
    expect(store.pendingPermissions).toEqual([]);
  });

  test('a public address pasted from the address bar saves without an error', async () => {
    const { store } = await ready();
    await store.saveSettings({ publicUrl: 'https://boite.example.com/' });
    expect(store.error).toBeNull();
    expect(store.settings?.publicUrl).toBe('https://boite.example.com');
  });

  test('archiving a thread lets go of its panel, browser views, composer and terminal', async () => {
    const { store, client } = await ready();
    const destroy = vi.spyOn(browserBridge, 'destroy');
    try {
      const thread = store.threads.find((t) => t.status === 'idle' && !t.parentThreadId)!;
      await store.open(thread.id);
      const view = store.panel.open('browser');
      store.editComposerText(thread.id, 'half a prompt');
      store.toggleTerminal();
      expect(store.terminalShown(thread.id)).toBe(true);

      await store.archive(thread.id);

      expect(destroy.mock.calls.map(([id]) => id)).toEqual([view.id]);
      expect(rightPanel.threads[store.threadKey(thread.id)]).toBeUndefined();
      expect(store.composerStates[thread.id]).toBeUndefined();
      expect(store.terminalShown(thread.id)).toBe(false);
    } finally { destroy.mockRestore(); store.detach(); client.close(); }
  });

  test('a thread archived from another client drops its panel here too', async () => {
    const { store, client } = await ready();
    try {
      const [shown, other] = store.threads.filter((t) => t.status === 'idle' && !t.parentThreadId);
      await store.open(shown!.id);
      rightPanel.for(store.threadKey(other!.id)).open('trace');
      store.editComposerText(other!.id, 'draft');
      await client.call('threads.archive', { threadId: other!.id, archived: true });
      await waitFor(() => (rightPanel.threads[store.threadKey(other!.id)] === undefined ? true : undefined));
      expect(store.composerStates[other!.id]).toBeUndefined();
    } finally { store.detach(); client.close(); }
  });

  test('a reload drops the layouts of threads its core no longer lists, and only its own', async () => {
    const { store, client } = await ready();
    try {
      store.machineId = 'http://a.test';
      const live = store.threads[0]!.id;
      rightPanel.for(store.threadKey(live)).open('trace');
      rightPanel.for(store.threadKey('t-archived-long-ago')).open('trace');
      rightPanel.for(JSON.stringify(['http://b.test', 't-archived-long-ago'])).open('trace');
      await store.reload();
      expect(rightPanel.threads[store.threadKey(live)]).toBeDefined();
      expect(rightPanel.threads[store.threadKey('t-archived-long-ago')]).toBeUndefined();
      expect(rightPanel.threads[JSON.stringify(['http://b.test', 't-archived-long-ago'])]).toBeDefined();
    } finally {
      rightPanel.forget(JSON.stringify(['http://b.test', 't-archived-long-ago']));
      store.detach(); client.close();
    }
  });

  test('an answer sent while the socket is down says so and can be sent again', async () => {
    const { store, client } = await ready();
    await store.open('t-scheduler');
    client.drop();
    expect(await store.answerQuestion('t-scheduler', 'qst-seed-1', ['short'])).toBe(false);
    expect(store.pendingQuestions.map((q) => q.id)).toEqual(['qst-seed-1']);
    expect(store.error).toBeTruthy();

    await client.restore();
    expect(await store.answerQuestion('t-scheduler', 'qst-seed-1', ['short'])).toBe(true);
    expect(store.pendingQuestions).toEqual([]);
  });

  test('a thread removed elsewhere lets its subscription go before the next one is taken', async () => {
    const { store, client } = await ready();
    await store.open('t-descriptors');
    const spy = vi.spyOn(client, 'call');

    await client.call('projects.remove', { projectId: 'p-notes' });
    await waitFor(() => store.openThread?.id);

    const strip = spy.mock.calls
      .filter(([method]) => method === 'threads.subscribe' || method === 'threads.unsubscribe')
      .map(([method, params]) => `${method} ${(params as { threadId: string }).threadId}`);
    // The handler that saw the thread leave is what releases it: the next
    // thread is never subscribed while the socket still holds a dead one.
    expect(strip[0]).toBe('threads.unsubscribe t-descriptors');
    expect(store.openThread?.projectId).toBe('p-boite');
    expect(client.clientSubscriptions).toEqual([store.openThread?.id]);
    spy.mockRestore();
  });

  test('opening the thread already held asks only for what is past its last message, and keeps the rest', async () => {
    const { store, client } = await ready();
    await store.open('t-scheduler');
    const before = store.openThread!.messages.map((message) => message.id);
    expect(before.length).toBeGreaterThan(1);
    const spy = vi.spyOn(client, 'call');

    // What a reconnect does: the same thread again.
    await store.open('t-scheduler', false);

    const asked = spy.mock.calls.find(([method]) => method === 'threads.get')?.[1] as { after?: string };
    expect(asked.after).toBe(resumeAnchor(store.openThread!) ?? undefined);
    expect(before).toContain(asked.after);
    expect(store.openThread!.messages.map((message) => message.id)).toEqual(before);
    expect(store.openThread!.messagesFrom).toBeUndefined();
    expect(spy.mock.calls.some(([method]) => method === 'trace.get')).toBe(false);
    spy.mockRestore();
  });

  test('the resume anchor is the oldest message still moving, else the last one', () => {
    const message = (id: string, turnId: string, state: 'done' | 'streaming') => ({ id, turnId, state }) as never;
    const turn = (id: string, finishedAt: number | null) => ({ id, finishedAt }) as never;
    expect(resumeAnchor({ messages: [], turns: [] } as never)).toBeNull();
    expect(resumeAnchor({ messages: [message('m1', 'a', 'done'), message('m2', 'a', 'done')], turns: [turn('a', 1)] } as never)).toBe('m2');
    expect(resumeAnchor({
      messages: [message('m1', 'a', 'done'), message('m2', 'b', 'done'), message('m3', 'b', 'streaming')],
      turns: [turn('a', 1), turn('b', null)],
    } as never)).toBe('m2');
  });

  test('a boot loads the core once, not twice', async () => {
    const client = new FakeClient({ delayMs: 0 });
    const store = new Store();
    const spy = vi.spyOn(client, 'call');
    store.attach(client);

    await store.connect();

    // `connect()` and the `ready` state handler both ask: one load goes out.
    expect(spy.mock.calls.filter(([method]) => method === 'projects.list')).toHaveLength(1);
    expect(spy.mock.calls.filter(([method]) => method === 'keybindings.get')).toHaveLength(1);
    expect(store.projects).toHaveLength(2);
    spy.mockRestore();
  });
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition never became true');
}

test('account lifecycle reload preserves the running login snapshot', async () => {
  const { store, client } = await ready();
  await client.call('accounts.login', { accountId: 'a-claude-side' });
  await waitFor(() => store.logins['a-claude-side']?.url ?? undefined);
  const before = { ...store.logins['a-claude-side'] };
  await store.reload();
  expect(store.logins['a-claude-side']).toEqual(before);
});

test('account lifecycle refuses removal of an account referenced by an archived thread', async () => {
  const { client } = await ready();
  await client.call('threads.archive', { threadId: 't-trace', archived: true });
  await expect(client.call('accounts.remove', { accountId: 'a-echo' })).rejects.toThrow(/thread/i);
  expect((await client.call('accounts.list', {})).some((a) => a.id === 'a-echo')).toBe(true);
});

test('account lifecycle cancellation removes the login and permits retry', async () => {
  const { store, client } = await ready();
  await store.loginAccount('a-claude-side');
  await waitFor(() => store.logins['a-claude-side']?.url ?? undefined);
  expect(await client.call('accounts.logins', {})).toHaveLength(1);
  await store.cancelLogin('a-claude-side');
  expect(store.logins['a-claude-side']).toBeUndefined();
  expect(await client.call('accounts.logins', {})).toEqual([]);
  await store.loginAccount('a-claude-side');
  expect(store.logins['a-claude-side']?.state).toBe('running');
  await store.removeAccount('a-claude-side');
  expect(store.accounts.some((a) => a.id === 'a-claude-side')).toBe(false);
  expect(await client.call('accounts.logins', {})).toEqual([]);
});

test('account lifecycle fake rejects unsupported login and enforces provider isolation', async () => {
  const { client } = await ready();
  await expect(client.call('accounts.login', { accountId: 'a-echo' })).rejects.toThrow(/login is not available/i);
  const account = await client.call('accounts.add', {
    providerId: 'antigravity', label: 'isolated only', useDefaultLocation: true
  });
  expect(account.isolationDir).toBeTruthy();
});

test('account lifecycle newer cancellation beats a stale reload snapshot', async () => {
  const { store, client } = await ready();
  await store.loginAccount('a-claude-side');
  await waitFor(() => store.logins['a-claude-side']?.url ?? undefined);
  const call = client.call.bind(client);
  let release!: () => void;
  let snapshotRead = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'accounts.logins') {
      snapshotRead = true;
      await gate;
    }
    return result;
  });
  try {
    const reload = store.reload();
    await waitFor(() => snapshotRead ? true : undefined);
    await store.cancelLogin('a-claude-side');
    release();
    await reload;
    expect(store.logins['a-claude-side']).toBeUndefined();
  } finally {
    release();
    spy.mockRestore();
  }
});

test('connecting a second account moves the composer to that account, not the first signed in', async () => {
  const store = new Store();
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
  store.accounts = store.accounts.map((a) => (a.id === 'a-claude-side' ? { ...a, status: 'ok' } : a));
  expect(store.useProvider('claude', 'a-claude-side')).toBe(true);
  expect(store.prefs.accountId).toBe('a-claude-side');
  // Unnamed, or named but not signed in: the first signed-in account.
  store.accounts = store.accounts.map((a) => (a.id === 'a-claude-side' ? { ...a, status: 'unauthenticated' } : a));
  expect(store.useProvider('claude', 'a-claude-side')).toBe(true);
  expect(store.prefs.accountId).toBe('a-claude-main');
});

test('a machine on a slow link keeps its connection when the lists take longer than the handshake deadline', async () => {
  vi.useFakeTimers();
  const sockets: SlowLinkSocket[] = [];
  class SlowLinkSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event?: { code?: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    closedByClient = false;
    constructor() {
      sockets.push(this);
      setTimeout(() => this.onopen?.(), 10);
    }
    send(raw: string): void {
      const frame = JSON.parse(raw) as { id: number; method: string };
      const answer = (delay: number, body: Record<string, unknown>) =>
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...body }) }), delay);
      if (frame.method === 'hello') answer(40, { result: { core: { protocolVersion: PROTOCOL_VERSION }, principal: 'owner' } });
      // A thousand threads on a weak cellular link.
      else if (frame.method === 'threads.list') answer(13_000, { result: [] });
      else answer(40, { error: { code: RpcErrorCode.NotFound, message: `${frame.method} is not in this fixture` } });
    }
    close(): void {
      this.closedByClient = true;
      this.onclose?.({ code: 1000 });
    }
  }
  vi.stubGlobal('WebSocket', SlowLinkSocket);
  const store = new Store();
  try {
    const connecting = store.connectEndpoint({ url: 'https://far.example', token: 'key', paired: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.connection).toBe('ready');
    await vi.advanceTimersByTimeAsync(13_000);
    await connecting;
    expect(store.connection).toBe('ready');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closedByClient).toBe(false);
    expect(store.error).not.toBe(strings.machines.timeout);
    expect(store.error).not.toBe('client closed');
  } finally {
    store.client?.close();
    store.detach();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test('a link in the address becomes the stored core only after a hello, and an unknown core is asked about first', async () => {
  vi.useFakeTimers();
  const opened: string[] = [];
  let answers = false;
  class LinkSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event?: { code?: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      opened.push(url);
      setTimeout(() => this.onopen?.(), 10);
    }
    send(raw: string): void {
      const frame = JSON.parse(raw) as { id: number; method: string };
      const answer = (body: Record<string, unknown>) =>
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...body }) }), 10);
      if (frame.method === 'hello') {
        // A core that never says hello back, or one that does.
        if (answers) answer({ result: { core: { protocolVersion: PROTOCOL_VERSION }, principal: 'owner' } });
      } else answer({ error: { code: RpcErrorCode.NotFound, message: `${frame.method} is not in this fixture` } });
    }
    close(): void {
      this.onclose?.({ code: 1000 });
    }
  }
  vi.stubGlobal('WebSocket', LinkSocket);
  const paired = { url: 'https://my-core.example', token: 'session-key', paired: true };
  const stores: Store[] = [];
  const boot = (path: string): Promise<void> => {
    window.history.replaceState(null, '', path);
    const store = new Store();
    stores.push(store);
    return store.boot();
  };
  try {
    localStorage.clear();
    storeEndpoint(paired);

    // A token link on this origin whose core stays silent: the paired core stays stored.
    const silent = boot('/?token=fresh');
    await vi.advanceTimersByTimeAsync(11_000);
    await silent;
    expect(readStoredEndpoint()).toEqual(paired);
    stores.at(-1)?.client?.close();

    // A core link to a stranger: asked about, refused, and the paired core is what opens.
    opened.length = 0;
    const refused = boot('/?core=https://other.example');
    await vi.advanceTimersByTimeAsync(0);
    expect(confirm.current?.title).toBe(strings.machines.linkTitle.replace('{host}', 'other.example'));
    confirm.answer(false);
    await vi.advanceTimersByTimeAsync(11_000);
    await refused;
    expect(opened[0]).toContain('my-core.example');
    expect(opened.some((url) => url.includes('other.example'))).toBe(false);
    expect(readStoredEndpoint()).toEqual(paired);
    stores.at(-1)?.client?.close();

    // The same token link once its core answers: stored then, with the key it carried.
    answers = true;
    const answered = boot('/?token=fresh');
    await vi.advanceTimersByTimeAsync(1_000);
    await answered;
    expect(stores.at(-1)?.connection).toBe('ready');
    expect(readStoredEndpoint()).toEqual({ url: window.location.origin, token: 'fresh' });
  } finally {
    for (const store of stores) {
      store.client?.close();
      store.detach();
    }
    window.history.replaceState(null, '', '/');
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

describe('the shell core lost under a local store', () => {
  async function localStore() {
    const client = new FakeClient({ delayMs: 0 });
    const store = new Store();
    store.attach(client);
    await store.connect();
    store.localCore = true;
    store.endpointUrl = 'http://127.0.0.1:41000';
    window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
    return { store, client };
  }

  test('a core unreachable for a while is asked of the shell again, and the store follows it to its new address', async () => {
    vi.useFakeTimers();
    const { store, client } = await localStore();
    const fromTauri = vi.spyOn(endpoints, 'fromTauri').mockResolvedValue({ url: 'http://127.0.0.1:42000', token: 'next', local: true });
    const connect = vi.spyOn(store, 'connect').mockResolvedValue();
    const open = vi.spyOn(store, 'openWhereLeft').mockResolvedValue();
    try {
      client.drop();
      await vi.advanceTimersByTimeAsync(LOCAL_RECOVERY_MS - 100);
      expect(fromTauri).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(fromTauri).toHaveBeenCalledOnce();
      expect(store.endpointUrl).toBe('http://127.0.0.1:42000');
      expect(store.localCore).toBe(true);
    } finally {
      vi.useRealTimers();
      fromTauri.mockRestore(); connect.mockRestore(); open.mockRestore();
      delete window.__TAURI_INTERNALS__;
      store.client?.close(); store.detach(); client.close();
    }
  });

  test('a core stopped on purpose stays stopped, and a refresh asks the shell for it again', async () => {
    vi.useFakeTimers();
    const { store, client } = await localStore();
    const fromTauri = vi.spyOn(endpoints, 'fromTauri').mockResolvedValue(null);
    const refused = vi.spyOn(endpoints, 'shellEndpointError').mockReturnValue('the core exited (exit code: 3) before it was ready');
    try {
      client.close();
      await vi.advanceTimersByTimeAsync(LOCAL_RECOVERY_MS * 2);
      expect(fromTauri).not.toHaveBeenCalled();
      await store.connect();
      expect(fromTauri).toHaveBeenCalledOnce();
      expect(store.error).toContain('exit code: 3');
    } finally {
      vi.useRealTimers();
      fromTauri.mockRestore(); refused.mockRestore();
      delete window.__TAURI_INTERNALS__;
      store.detach(); client.close();
    }
  });
});
