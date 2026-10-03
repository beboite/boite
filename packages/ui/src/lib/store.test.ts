import { beforeEach, describe, expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import { PROTOCOL_VERSION, RpcErrorCode, type Thread, type ThreadStatus } from '@boite/contracts';
import { RpcFailure, WsClient, droppedFailure, type SocketLike } from './client';
import { FakeClient } from './fake-client';
import { setNotificationSender, type Toast } from './notify';
import * as endpoints from './endpoint';
import { Store } from './store.svelte';
import { LOCAL_RECOVERY_MS } from './store/connection.svelte';
import { resumeAnchor } from './thread-rows';
import { strings } from './strings';
import { compareThreads } from './thread-order';
import { confirm } from './confirm.svelte';
import { browserBridge } from './browser-bridge';
import { rightPanel } from './right-panel.svelte';
import { readStoredEndpoint, storeEndpoint } from './endpoint';

test('opening the drawer starts its shell before a view mounts and shares an in-flight start', async ({ store, client }) => {
  await store.open(store.threads[0]!.id);
  const threadId = store.openThread!.id;
  const call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'terminals.open') await gate;
    return result;
  });
  try {
    store.toggleTerminal();
    expect(spy.mock.calls.filter(([method]) => method === 'terminals.open')).toHaveLength(1);
    await client.call('terminals.write', { id: `terminal:${threadId}`, data: 'early-output' });
    const attaching = store.openTerminal(threadId, 100, 30);
    expect(spy.mock.calls.filter(([method]) => method === 'terminals.open')).toHaveLength(1);
    release();
    const state = await attaching;
    expect(state?.id).toBe(`terminal:${threadId}`);
    expect(state?.output.match(/early-output/g)).toHaveLength(1);
    // Closing still hides a drawer whose lazy display never mounted.
    await store.closeTerminal(`terminal:${threadId}`);
    expect(store.terminalShown(threadId)).toBe(false);
  } finally { release(); spy.mockRestore(); }
});

test('an older core keeps output arriving before the lazy terminal view attaches', async ({ store, client }) => {
  await store.open(store.threads[0]!.id);
  const threadId = store.openThread!.id;
  const call = client.call.bind(client);
  const stop = client.on('terminal.output', (event) => { Reflect.deleteProperty(event, 'sequence'); });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'terminals.open') {
      // Older cores return snapshots without an output sequence.
      Reflect.deleteProperty(result as object, 'sequence');
      await gate;
    }
    return result;
  });
  try {
    store.toggleTerminal();
    await client.call('terminals.write', { id: `terminal:${threadId}`, data: 'legacy-early-output' });
    const attaching = store.openTerminal(threadId, 100, 30);
    release();
    const state = await attaching;
    expect(state?.output.match(/legacy-early-output/g)).toHaveLength(1);
  } finally { release(); stop(); spy.mockRestore(); }
});

test('closing a thread shell invalidates a legacy refresh and delayed view attachment until reopening', async ({ store, client }) => {
  await store.open(store.threads[0]!.id);
  const threadId = store.openThread!.id;
  const call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'terminals.open') {
      Reflect.deleteProperty(result as object, 'sequence');
      await gate;
    }
    return result;
  });
  try {
    store.toggleTerminal();
    await client.call('terminals.write', { id: `terminal:${threadId}`, data: 'early-output' });
    const attaching = store.openTerminal(threadId, 100, 30);
    await store.closeTerminal(`terminal:${threadId}`);
    release();
    expect(await attaching).toBeNull();
    expect(await store.openTerminal(threadId, 100, 30)).toBeNull();
    expect(spy.mock.calls.filter(([method]) => method === 'terminals.open')).toHaveLength(1);
    expect(store.terminalShown(threadId)).toBe(false);
    // An explicit owner action can start a new shell after the previous one closed.
    store.toggleTerminal();
    expect((await store.openTerminal(threadId, 100, 30))?.id).toBe(`terminal:${threadId}`);
    expect(spy.mock.calls.filter(([method]) => method === 'terminals.open')).toHaveLength(2);
    expect(store.terminalShown(threadId)).toBe(true);
  } finally { release(); spy.mockRestore(); }
});

test('a rejected terminal keystroke reports the failure instead of leaving a silent prompt', async ({ store, client }) => {
  const call = vi.spyOn(client, 'call').mockRejectedValue(new RpcFailure({ code: RpcErrorCode.Unavailable, message: 'Remote terminal transport unavailable' }));
  try {
    store.writeTerminal('terminal:t-remote', 'pwd\r');
    await vi.waitFor(() => expect(store.error).toContain('Remote terminal transport unavailable'));
    store.error = null;
    call.mockRejectedValue(new RpcFailure({ code: RpcErrorCode.NotFound, message: 'no terminal is running' }));
    store.writeTerminal('terminal:t-remote', 'x');
    await Promise.resolve();
    expect(store.error).toBeNull();
  } finally { call.mockRestore(); }
});

test('changing a Store endpoint drops the previous machine composer and element callbacks', async ({ store, client }) => {
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

test('changing a Store endpoint drops the previous machine updates, todos, resources and trace', async ({ store, client }) => {
  const saved = Object.entries(localStorage);
  const connect = vi.spyOn(store, 'connect').mockResolvedValue();
  const open = vi.spyOn(store, 'openWhereLeft').mockResolvedValue();
  store.harnessUpdates = [{ providerId: 'claude', name: 'Claude', route: 'managed', current: '1.0.0', latest: '1.1.0', pending: false, skipped: null, state: 'idle', message: null, checkedAt: null }] as never;
  store.todos = { 'p-boite': [{ id: 'todo-1' }] } as never;
  store.resources = [{ threadId: 't-trace' }] as never;
  store.trace = [{ pid: 1 }] as never;
  try {
    await store.connectTo('https://second.test', 'fixture-token');
    expect(store.harnessUpdates).toEqual([]);
    expect(store.todos).toEqual({});
    expect(store.resources).toEqual([]);
    expect(store.trace).toEqual([]);
  } finally {
    connect.mockRestore(); open.mockRestore();
    store.client?.close(); store.detach(); client.close();
    localStorage.clear();
    for (const [key, value] of saved) localStorage.setItem(key, value);
  }
});

test('a core without agent updates shows none, not the last machine list', async ({ store, client }) => {
  store.harnessUpdates = [{ providerId: 'claude' }] as never;
  const real = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: never) => method === 'providers.updates'
    ? Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method providers.updates' }))
    : real(method as never, params)) as typeof client.call);
  await store.loadHarnessUpdates();
  expect(store.harnessUpdates).toEqual([]);
});

test('dropped folders use the local core when a remote machine is selected', async ({ store, client: remote }) => {
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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}


test.for(['reload', 'open'] as const)('a delayed %s request snapshot preserves resolved and newly asked cards', async (action, { store, client }) => {
  await store.open('t-scheduler');
  const call = client.call.bind(client);
  const gate = deferred();
  let held = 0;
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const value = await call(method, params);
    if (method === 'permissions.list' || method === 'questions.list') {
      held++;
      if (action === 'reload') await gate.promise;
    }
    // The scoped answers can finish before their subscription/get allows application.
    if (action === 'open' && method === 'threads.get') await gate.promise;
    return value;
  });
  const loading = action === 'reload' ? store.reload() : store.open('t-scheduler');
  try {
    await vi.waitFor(() => expect(held).toBeGreaterThanOrEqual(2));
    await client.call('permissions.answer', { requestId: 'req-seed-1', decision: 'deny' });
    await client.call('questions.skip', { threadId: 't-scheduler', questionId: 'qst-seed-1' });
    const fresh = await client.call('questions.ask', { threadId: 't-scheduler', text: 'A new question during the read', options: ['Continue'] });
    expect(store.pendingQuestions.map(row => row.id)).toEqual([fresh.questionId]);
    gate.resolve();
    await loading;
    expect(store.pendingPermissions).toEqual([]);
    expect(store.pendingQuestions.map(row => row.id)).toEqual([fresh.questionId]);
    expect((await call('questions.list', {})).map(row => row.id)).toEqual([fresh.questionId]);
  } finally { gate.resolve(); await loading; spy.mockRestore(); }
});

test('a delayed thread list cannot undo a newer pin event', async ({ store, client }) => {
  const call = client.call.bind(client);
  const gate = deferred();
  const pinned = store.threads.find(row => row.id === 't-trace')!;
  const removed = store.threads.find(row => row.id !== 't-trace')!.id;
  let held = false;
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const value = await call(method, params);
    if (method === 'threads.list') { held = true; await gate.promise; return [...value as typeof store.threads, { ...pinned, id: 'offline-list-row' }] as never; }
    return value;
  });
  const loading = store.reload();
  try {
    await vi.waitFor(() => expect(held).toBe(true));
    await client.call('threads.pin', { threadId: 't-trace', pinned: true });
    await client.call('threads.remove', { threadId: removed });
    expect(store.threads.find(row => row.id === 't-trace')?.pinned).toBe(true);
    gate.resolve();
    await loading;
    expect(store.threads.find(row => row.id === 't-trace')?.pinned).toBe(true);
    expect(store.threads.find(row => row.id === 't-trace')).toBe(pinned);
    expect(store.threads.some(row => row.id === removed)).toBe(false);
    expect(store.threads.some(row => row.id === 'offline-list-row')).toBe(true);
    expect((await call('threads.get', { threadId: 't-trace' })).pinned).toBe(true);
  } finally { gate.resolve(); await loading; spy.mockRestore(); }
});

test('a secondary login read cannot hold an accepted prompt behind reload', async ({ store, client }) => {
  await store.open('t-trace');
  const call = client.call.bind(client);
  const gate = deferred();
  let held = false;
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const value = await call(method, params);
    if (method === 'accounts.logins') { held = true; await gate.promise; }
    return value;
  });
  const loading = store.reload();
  let sending: Promise<boolean> | undefined;
  try {
    await vi.waitFor(() => expect(held).toBe(true));
    sending = store.send('An ordinary prompt', 't-trace');
    await vi.waitFor(() => expect(spy.mock.calls.some(([method]) => method === 'turns.start')).toBe(true), { timeout: 500 });
    expect(await sending).toBe(true);
  } finally { gate.resolve(); await loading; await sending; spy.mockRestore(); }
});

test.for(['all-first', 'thread-first'] as const)('the newer request scope wins overlapping %s reads while unrelated offline rows land', async (order, { store, client }) => {
  const call = client.call.bind(client), gate = deferred();
  const permissions = (await call('permissions.list', {})).map(row => ({ ...row, threadId: 't-scheduler' }));
  const questions = await call('questions.list', {});
  store.pendingPermissions = permissions;
  const offlinePermission = { ...permissions[0]!, id: 'offline-permission', threadId: 't-trace' };
  const offlineQuestion = { ...questions[0]!, id: 'offline-question', threadId: 't-trace' };
  let held = 0;
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method !== 'permissions.list' && method !== 'questions.list') return call(method, params);
    const global = !('threadId' in params);
    const older = global === (order === 'all-first');
    if (older) { held++; await gate.promise; }
    const rows = method === 'permissions.list' ? permissions : questions;
    const offline = method === 'permissions.list' ? offlinePermission : offlineQuestion;
    return (older ? [...rows, ...(global ? [offline] : [])] : global ? [offline] : []) as never;
  });
  const older = order === 'all-first' ? store.reload() : store.open('t-scheduler');
  try {
    await vi.waitFor(() => expect(held).toBe(2));
    await (order === 'all-first' ? store.open('t-scheduler') : store.reload());
    expect(store.pendingPermissions.some(row => row.id === 'req-seed-1')).toBe(false);
    gate.resolve(); await older;
    expect(store.pendingPermissions.map(row => row.id)).toEqual(['offline-permission']);
    expect(store.pendingQuestions.map(row => row.id)).toEqual(['offline-question']);
  } finally { gate.resolve(); await older; spy.mockRestore(); }
});

test.for(['answerQuestion', 'skipQuestion', 'answer'] as const)('a late %s completion or error belongs to the original client incarnation', async (action, { store, client }) => {
  const replacement = new FakeClient({ delayMs: 0, coreId: 'other-machine' });
  const call = client.call.bind(client);
  const method = action === 'answerQuestion' ? 'questions.answer' : action === 'skipQuestion' ? 'questions.skip' : 'permissions.answer';
  try {
    for (const reject of [false, true]) {
      const gate = deferred(), started = deferred();
      const spy = vi.spyOn(client, 'call').mockImplementation(async (requested, params) => {
        if (requested !== method) return call(requested, params);
        // Execute accepted backend work once before holding its acknowledgement.
        const value = reject ? undefined : await call(requested, params as never);
        started.resolve(); await gate.promise;
        if (reject) throw new Error('Failure from the original incarnation');
        return value;
      });
      // A fresh synthetic card shares IDs between distinct connected machines.
      await replacement.connect();
      const question = (await replacement.call('questions.list', {}))[0]!;
      store.pendingQuestions = [question];
      const permission = (await replacement.call('permissions.list', {}))[0]!;
      store.pendingPermissions = [permission];
      const pending = action === 'answerQuestion' ? store.answerQuestion('t-scheduler', 'qst-seed-1', ['short'])
        : action === 'skipQuestion' ? store.skipQuestion('t-scheduler', 'qst-seed-1') : store.answer('req-seed-1', 'deny');
      await started.promise;
      store.attach(replacement); await store.connect();
      store.attach(client); await store.connect();
      store.pendingQuestions = [question]; store.pendingPermissions = [permission]; store.error = null;
      gate.resolve(); await pending;
      expect(store.pendingQuestions.map(row => row.id)).toEqual(['qst-seed-1']);
      expect(store.pendingPermissions.map(row => row.id)).toEqual(['req-seed-1']);
      expect(store.error).toBeNull();
      expect(spy.mock.calls.filter(([requested]) => requested === method)).toHaveLength(1);
      spy.mockRestore();
    }
  } finally { store.detach(); client.close(); replacement.close(); }
});

test('real WsClient event frames overtake held snapshots and secondary metadata', async () => {
  const backend = new FakeClient({ delayMs: 0 });
  await backend.connect();
  let hold = false;
  const delayed: { method: string; reply: () => void }[] = [];
  const release = (method: string) => { const index = delayed.findIndex(row => row.method === method); delayed.splice(index, 1)[0]!.reply(); };
  const frames: string[] = [];
  const socket: SocketLike = {
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(raw) {
      const frame = JSON.parse(raw) as { id: number; method: Parameters<FakeClient['call']>[0]; params: never };
      frames.push(frame.method);
      void backend.call(frame.method, frame.params).then(result => {
        const reply = () => socket.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) });
        if ((hold && ['permissions.list', 'questions.list', 'settings.get', 'scheduler.get', 'keybindings.get'].includes(frame.method)) || frame.method === 'accounts.logins') delayed.push({ method: frame.method, reply });
        else reply();
      }, error => socket.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: RpcErrorCode.Internal, message: String(error) } }) }));
    },
    close() { socket.onclose?.({ code: 1000 }); }
  };
  const client = new WsClient({ url: 'http://fixture.invalid', token: 'synthetic', reconnect: false, socketFactory: () => {
    queueMicrotask(() => socket.onopen?.()); return socket;
  } });
  const store = new Store(); store.attach(client);
  const event = (method: string, params: unknown) => socket.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method, params }) });
  let loading: Promise<void> | undefined, reloaded = false;
  try {
    // Startup reaches its essential data while the very first login read is held.
    await store.connect();
    expect(delayed.map(row => row.method)).toEqual(['accounts.logins']);
    expect(store.projects.length).toBeGreaterThan(0);
    release('accounts.logins'); await store.reload();
    await store.open('t-scheduler');
    hold = true; loading = store.reload().then(() => { reloaded = true; });
    await vi.waitFor(() => expect(delayed).toHaveLength(6));
    const fresh = { ...store.pendingQuestions[0]!, id: 'wire-fresh-question', text: 'A question received before the old response' };
    event('permission.resolved', { requestId: 'req-seed-1' });
    event('question.answered', { questionId: 'qst-seed-1' });
    event('question.asked', fresh);
    const settings = { ...store.settings!, publicUrl: 'https://fresh.example' };
    const keybindings = { ...store.keybindings!, bindings: { ...store.keybindings!.bindings, terminal: 'ctrl+alt+t' } };
    const scheduler = { running: [{ turnId: 'wire-turn', threadId: 't-trace', startedAt: 1 }], queued: [] };
    event('settings.updated', settings); event('keybindings.updated', keybindings); event('scheduler.updated', scheduler);
    release('permissions.list'); release('questions.list'); release('settings.get');
    await vi.waitFor(() => expect(store.pendingQuestions.map(row => row.id)).toEqual(['wire-fresh-question']));
    expect(store.pendingPermissions).toEqual([]);
    expect(await store.send('Input before secondary metadata', 't-trace')).toBe(true);
    expect(frames.filter(method => method === 'turns.start')).toHaveLength(1);
    expect(reloaded).toBe(false);
    // Explicit reload still awaits secondary slices and preserves their newer events.
    release('accounts.logins'); release('scheduler.get'); release('keybindings.get'); await loading;
    expect(store.settings).toEqual(settings); expect(store.keybindings).toEqual(keybindings); expect(store.scheduler).toEqual(scheduler);
    expect(store.pendingQuestions.map(row => row.id)).toEqual(['wire-fresh-question']);
  } finally { for (const row of delayed) row.reply(); await loading; store.detach(); client.close(); backend.close(); }
});

test.for(['draft', 'settings', 'detach', 'suspend'])('a pending open respects a newer %s intent and retires its subscription', async (intent, { store, client }) => {
  await store.open('t-trace');
  const call = client.call.bind(client), started = deferred<void>(), released = deferred<void>();
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'threads.get' && (params as { threadId?: string }).threadId === 't-scheduler') { started.resolve(); await released.promise; }
    return result;
  });
  try {
    const opening = store.open('t-scheduler');
    await started.promise;
    expect(store.openThread?.id).toBe('t-scheduler');
    if (intent === 'draft') { store.startDraft('p-notes'); store.editComposerText('draft', 'New draft'); }
    else if (intent === 'settings') store.showSettings('general');
    else if (intent === 'detach') store.detach();
    else await store.suspend();
    const retained = store.openThread;
    const messages = JSON.parse(JSON.stringify(retained?.messages ?? []));
    released.resolve(); await opening;
    expect(store.openThread).toBe(retained);
    expect(store.openThread?.messages ?? []).toEqual(messages);
    if (intent === 'draft') { expect(store.draft?.projectId).toBe('p-notes'); expect(store.composerStates.draft?.text).toBe('New draft'); }
    if (intent === 'settings') expect(store.page).toBe('settings');
    expect(client.clientSubscriptions).toEqual(intent === 'settings' ? ['t-trace'] : []);
  } finally { released.resolve(); spy.mockRestore(); }
});

test('a replaced client cannot report an old open failure into a machine with colliding thread IDs', async ({ store, client }) => {
  const replacement = new FakeClient({ delayMs: 0, coreId: 'replacement' });
  const started = deferred<void>(), released = deferred<void>();
  const call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'threads.get') { started.resolve(); await released.promise; throw new Error('Old client failure'); }
    if (method === 'threads.pin') await released.promise;
    return result;
  });
  try {
    const opening = store.open('t-trace'); await started.promise;
    const pinning = store.pin('t-trace', true);
    store.attach(replacement); await store.connect(); await store.open('t-trace');
    released.resolve(); await Promise.all([opening, pinning]);
    expect(store.openThread?.id).toBe('t-trace'); expect(store.error).toBeNull();
    expect(store.openThread?.pinned).toBe(false); expect(store.threads.find(thread => thread.id === 't-trace')?.pinned).toBe(false);
    expect(client.clientSubscriptions).toEqual([]); expect(replacement.clientSubscriptions).toEqual(['t-trace']);
  } finally { released.resolve(); spy.mockRestore(); store.detach(); client.close(); replacement.close(); }
});

test.for(['submit', 'submitAndDraft'] as const)('an accepted draft creation through %s sends once on its original thread while a newer draft keeps its input', async (action, { store, client }) => {
  store.startDraft('p-boite'); store.editComposerText('draft', 'Sent from A');
  const started = deferred<void>(), released = deferred<void>(), call = client.call.bind(client);
  let createdId = '';
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'threads.create') { createdId = (result as { id: string }).id; started.resolve(); await released.promise; }
    return result;
  });
  try {
    const submitted = store[action]('Sent from A', { providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null, permissionMode: 'default' });
    await started.promise;
    store.startDraft('p-notes'); store.editComposerText('draft', 'Unsent B');
    const next = store.composerStates.draft!;
    next.attachments = [{ kind: 'file', mimeType: 'text/plain', name: 'B.txt', data: 'Qg==' }];
    next.queued = [{ text: 'B queue', attachments: [] }]; next.paused = true;
    released.resolve(); expect(await submitted).toBe(true);
    expect(store.draft?.projectId).toBe('p-notes'); expect(store.openThread).toBeNull();
    expect(store.composerStates.draft).toBe(next);
    expect(next).toMatchObject({ text: 'Unsent B', attachments: [{ name: 'B.txt' }], queued: [{ text: 'B queue' }], paused: true });
    expect(spy.mock.calls.filter(([method]) => method === 'threads.create')).toHaveLength(1);
    expect(spy.mock.calls.filter(([method]) => method === 'turns.start').map(([, params]) => (params as { threadId: string }).threadId)).toEqual([createdId]);
  } finally { released.resolve(); spy.mockRestore(); }
});

test.for(['return-to-thread', 'newer-read'])('trace ignores an older response after %s', async (change, { store, client }) => {
 await store.open('t-trace');
  const started = deferred<void>(), released = deferred<void>(), call = client.call.bind(client);
  let reads = 0;
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'trace.get' && ++reads === 1) { started.resolve(); await released.promise; return [{ ...(result as object[])[0], pid: 999999 }] as never; }
    return result;
  });
  try {
    const reading = store.refreshTrace(); await started.promise;
    if (change === 'return-to-thread') { await store.open('t-scheduler'); await store.open('t-trace'); }
    else await store.refreshTrace();
    const current = [...store.trace]; released.resolve(); await reading;
    expect(store.trace).toEqual(current); expect(store.trace.some(record => record.pid === 999999)).toBe(false);
  } finally { released.resolve(); spy.mockRestore(); }
});

test('an older page cannot release a newer thread paging guard or duplicate its cursor request', async () => {
  const client = new FakeClient({ delayMs: 0, long: true }), store = new Store(); store.attach(client); await store.connect();
  const second = await client.call('threads.fork', { threadId: 't-long', messageId: 'm-long-399' }); await store.open('t-long');
  const firstGate = deferred<void>(), secondGate = deferred<void>(), call = client.call.bind(client);
  const asked = new Set<string>();
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'messages.list') { const id = (params as { threadId: string }).threadId; asked.add(id); await (id === 't-long' ? firstGate.promise : secondGate.promise); }
    return result;
  });
  try {
    const first = store.loadOlder(); await vi.waitFor(() => expect(asked.has('t-long')).toBe(true));
    await store.open(second.id); const next = store.loadOlder(); await vi.waitFor(() => expect(asked.has(second.id)).toBe(true));
    firstGate.resolve(); expect(await first).toBe(0); expect(store.loadingOlder).toBe(true);
    expect(await store.loadOlder()).toBe(0);
    expect(spy.mock.calls.filter(([method, params]) => method === 'messages.list' && (params as { threadId: string }).threadId === second.id)).toHaveLength(1);
    secondGate.resolve(); expect(await next).toBe(120); expect(store.loadingOlder).toBe(false);
  } finally { firstGate.resolve(); secondGate.resolve(); spy.mockRestore(); store.detach(); client.close(); }
});

test.for(['missing', 'refused'])('optional startup timing cannot prevent connecting: %s', async (timing, { createStore }) => {
  const { client, store } = createStore({ delayMs: 0 });
  store.attach(client);
  const original = globalThis.performance;
  const mark = vi.fn(() => { throw new Error('timing is unavailable'); });
  vi.stubGlobal('performance', timing === 'missing' ? {} : { getEntriesByName: () => [], mark });
  try {
    await expect(store.connect()).resolves.toBeUndefined();
    expect(store.connection).toBe('ready');
    expect(store.projects.length).toBeGreaterThan(0);
    expect(store.threads.length).toBeGreaterThan(0);
    expect(store.error).toBeNull();
    if (timing === 'refused') expect(mark).toHaveBeenCalled();
  } finally { vi.stubGlobal('performance', original); }
});

test('delegation selection keeps one child subscription and ignores an overtaken A-B-A response', async ({ createStore }) => {
  const { client, store } = createStore({ delayMs: 0, delegationDemo: true });
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
});

test('recent-thread recovery does not open delegated children', async ({ createStore }) => {
  const { client, store } = createStore({ delayMs: 0, delegationDemo: true });
  store.attach(client);
  await store.connect();
  await store.openWhereLeft();
  expect(store.openThread?.parentThreadId).toBeFalsy();
});

test('a later navigation wins while the previous agent subscription is being released', async ({ createStore }) => {
  const { client, store } = createStore({ delayMs: 0, delegationDemo: true });
  store.attach(client);
  let release: (() => void) | undefined;
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
});

test('reloading the current conversation keeps the selected agent transcript subscribed', async ({ createStore }) => {
  const { client, store } = createStore({ delayMs: 0, delegationDemo: true });
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  await store.selectDelegatedAgent('t-team-running');
  const called = vi.spyOn(client, 'call');
  await store.reload();
  expect(store.openThread?.id).toBe('t-trace');
  expect(store.delegationSelectedAgentId).toBe('t-team-running');
  expect(store.delegationThread?.id).toBe('t-team-running');
  expect(called).not.toHaveBeenCalledWith('threads.unsubscribe', { threadId: 't-team-running' });
});

test('a reconnect catches up the agent transcript and the team statuses the gap missed', async ({ createStore }) => {
  const { client, store } = createStore({ delayMs: 0, delegationDemo: true });
  store.attach(client);
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
});

test('starting a draft cancels a pending child subscription even without an open subscription', async ({ createStore }) => {
  const { client, store } = createStore({ delayMs: 0, delegationDemo: true });
  store.attach(client);
  let release: (() => void) | undefined;
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
});

test.for([false, true])('the chat and agent panel receive complete streaming updates, shared snapshot: %s', async (shared, { store, client }) => {
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
      { type: 'thinking', text: 'thinking about: [tool] one streamed answer', startedAt: expect.any(Number), finishedAt: expect.any(Number) },
      { type: 'text', text: '[tool] one streamed answer' }
    ]);
    expect(parts.find(part => part.type === 'tool')).toMatchObject({ status: 'done' });
    expect(snapshot?.turns.at(-1)?.status).toBe('done');
  }
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

test('a streamed delta, message or turn finds the newest item without walking the whole timeline', async () => {
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
    const raw = JSON.parse(JSON.stringify(store.openThread)) as Thread;
    const last = raw.messages.at(-1)!;
    const turn = raw.turns.at(-1)!;
    // A long thread scrolled back: what streams is always its newest item.
    let reads = 0;
    const counted = <T,>(items: T[]): T[] => new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      }
    });
    const older = Array.from({ length: 2000 }, (_, index) => ({ ...last, id: `m-old-${index}`, parts: [{ type: 'text' as const, text: 'old' }] }));
    const olderTurns = Array.from({ length: 500 }, (_, index) => ({ ...turn, id: `turn-old-${index}` }));
    store.openThread = { ...raw, messages: counted([...older, last]), turns: counted([...olderTurns, turn]) };
    handlers.get('message.delta')!({ threadId: 't-trace', messageId: last.id, partIndex: 0, text: '!' } as never);
    handlers.get('message.started')!({ ...last, state: 'streaming' } as never);
    handlers.get('turn.started')!({ ...turn } as never);
    expect(reads).toBeLessThan(20);
    expect(store.openThread.messages).toHaveLength(2001);
    expect(store.openThread.messages.at(-1)!.state).toBe('streaming');
  } finally { store.detach(); client.close(); }
});

test('launching from a child refreshes its team and returns the sibling without another spawn', async ({ createStore }) => {
  const { client, store } = createStore({ delayMs: 0, delegationDemo: true });
  store.attach(client);
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
});

test('switching conversations clears the old team and refuses missing or mismatched child views', async ({ createStore }) => {
  const { client, store } = createStore({ delayMs: 0, delegationDemo: true });
  store.attach(client);
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
});

test('telemetry actions route through the owning client and retain deletion state', async ({ store, client }) => {
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

test('uninstalled setup starts without account-dependent demo state', async ({ createStore }) => {
  const { client, store } = createStore({ delayMs: 0, uninstalled: true });
  store.attach(client);
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
});

test('a drafts folder asked of a machine left since fails there, not on the new one', async ({ store, client }) => {
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

test('provider actions report RPC failures through their owning store', async ({ store, client }) => {
  vi.spyOn(client, 'call').mockRejectedValue(new Error('provider unavailable'));
  expect(await store.installProvider('claude')).toBe(false);
  expect(store.error).toContain('provider unavailable');
  store.error = null;
  expect(await store.reloadProviders()).toBe(false);
  expect(store.error).toContain('provider unavailable');
});

test('a refusal reaches the surface without its JSON-RPC code', async ({ store, client }) => {
  const refusal = new RpcFailure({ code: RpcErrorCode.Refused, message: 'This account is no longer available.' });
  vi.spyOn(client, 'call').mockRejectedValue(refusal);
  expect(await store.installProvider('claude')).toBe(false);
  // The code said nothing to the person reading the toast, and it used to
  // ride along as `(-32011)` on every refusal.
  expect(store.error).toBe('This account is no longer available.');
});

test('a failed turn notification names its thread and a later ordinary error clears the link', async ({ store, client }) => {
  const message = 'turn trn-cyber failed: This content was flagged for possible cybersecurity risk.';
  client.emitCoreLog('error', message, { threadId: 't-trace' });
  expect(store.error).toBe('Finish the trace tab');
  expect(store.errorThreadId).toBe('t-trace');
  store.error = null;
  expect(store.errorThreadId).toBeNull();
  client.emitCoreLog('error', message, { threadId: 't-trace' });
  client.emitCoreLog('error', 'The connection failed.');
  expect(store.error).toBe('The connection failed.');
  expect(store.errorThreadId).toBeNull();
});

test('one failed boot call leaves every other slice loaded', async ({ createStore }) => {
  const { client, store } = createStore({ delayMs: 0 });
  const real = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'providers.list') {
      return Promise.reject(new RpcFailure({ code: RpcErrorCode.Internal, message: 'providers are unreadable' }));
    }
    return real(method as never, params as never);
  }) as typeof client.call);
  store.attach(client);
  await store.connect();
  // `Promise.all` used to jump to the catch here, leaving threads, projects
  // and settings on their pre-reconnect values under a loaded-looking app.
  expect(store.threads.length).toBeGreaterThan(0);
  expect(store.projects.length).toBeGreaterThan(0);
  expect(store.error).toBe('providers are unreadable');
});

test.for(['same', 'selection', 'kind'])('a lost start response reuses its request id only for identical content and selection: %s', async (change, { store, client }) => {
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
});

test.for(['back', 'gone'])('a start the socket dropped is asked once more when the connection comes back: %s', async (outcome, { store, client }) => {
  const original = client.call.bind(client);
  const requests: string[] = [];
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const answer = await original(method, params);
    if (method !== 'turns.start') return answer;
    requests.push((params as { clientRequestId: string }).clientRequestId);
    if (requests.length > 1) return answer;
    // The core took the turn, and the socket went before its answer arrived.
    client.drop();
    setTimeout(() => { if (outcome === 'back') void client.restore(); else client.close(); }, 5);
    throw droppedFailure('connection closed');
  });
  const thread = store.threads.find(thread => thread.status === 'idle')!;
  await store.open(thread.id);
  const accepted = await store.send('Survive the reconnect', thread.id);
  if (outcome === 'gone') {
    // The machine did not come back: the prompt waits in the outbox under the
    // request id it already went out with, so the core can only take it once.
    expect(accepted).toBe(true);
    expect(requests).toHaveLength(1);
    expect(store.error).toBeNull();
    expect(store.composerStates[thread.id]?.queued).toMatchObject([{ text: 'Survive the reconnect', request: { id: requests[0] } }]);
    return;
  }
  expect(accepted).toBe(true);
  expect(store.error).toBeNull();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  await client.settled();
  const turns = await original('threads.get', { threadId: thread.id });
  expect(turns.messages.filter(message => message.role === 'user' && JSON.stringify(message.parts).includes('Survive the reconnect'))).toHaveLength(1);
});

test.for(['input', 'inputText', 'output', 'documents'])('reading cache excludes oversized tool %s', async (field, { store, client }) => {
  await store.open('t-bench');
  const large = 'x'.repeat(2 * 1024 * 1024 + 1);
  const part: any = { type: 'tool', toolId: 'large', name: 'read', input: {}, output: null, status: 'done' };
  part[field] = field === 'documents' ? [{ kind: 'markdown', text: large }] : field === 'input' ? { nested: { text: large } } : large;
  store.openThread!.messages.unshift({ id: 'cached-only', threadId: 't-bench', turnId: 'old', role: 'assistant', parts: [part], state: 'complete', createdAt: 0 });
  await store.open('t-scheduler');
  await store.open('t-bench');
  const cached = store.openThread!.messages.find(message => message.id === 'cached-only');
  if (field === 'output') expect(cached?.parts[0]).toMatchObject({ outputDeferred: true, output: large.slice(0, 1024) });
  else expect(cached).toBeUndefined();
});

test('sizing a timeline for the reading cache reads string lengths, never a JSON copy of each part', async ({ store, client }) => {
  await store.open('t-bench');
  let copies = 0;
  const big = 'x'.repeat(256 * 1024);
  const part = () => ({ type: 'text' as const, text: big, toJSON() { copies++; return { type: 'text', text: big }; } });
  store.openThread!.messages.unshift(...Array.from({ length: 50 }, (_, index) => ({ id: `big-${index}`, threadId: 't-bench', turnId: 'old', role: 'assistant' as const, parts: [part()], state: 'complete' as const, createdAt: 0 })));
  await store.open('t-scheduler');
  expect(copies).toBe(0);
  await store.open('t-bench');
  expect(store.openThread!.messages.some((message) => message.id === 'big-0')).toBe(false);
});

describe('Store', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('opens on the seeded core', async ({ store }) => {

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

  test('a draft with the worktree switch on sends the option once, and a project change keeps it', async ({ store, client }) => {
    store.startDraft('p-boite');
    expect(store.draft?.worktree).toBe(false);
    store.setDraftWorktree(true);
    store.setDraftProject('p-notes');
    expect(store.draft).toMatchObject({ projectId: 'p-notes', worktree: true });

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
    expect(store.openThread?.branch).toMatch(/^boite\/wt-[a-z0-9]{8}$/);
    expect(store.draft).toBeNull();

    // The next draft starts with the switch off: a worktree is a decision each time.
    store.startDraft('p-notes');
    expect(store.draft?.worktree).toBe(false);
  });

  test('opening a thread clears its unread badge', async ({ store }) => {

    await store.open('t-descriptors');

    expect(store.openThread?.id).toBe('t-descriptors');
    expect(store.openThread?.unread).toBe(false);
    expect(store.threads.find((t) => t.id === 't-descriptors')?.unread).toBe(false);
    expect(store.unreadCount).toBe(0);
  });

  test('a turn finishing on a thread that is not open sends a toast, the open one does not', async ({ ready }) => {
    const sent: Toast[] = [];
    setNotificationSender(async (toast) => {
      sent.push(toast);
    });
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      const { store, client } = await ready();
      await store.open('t-descriptors');

      // The thread is not on screen: its reply is read from the core, as the push quotes it.
      await client.call('turns.start', { threadId: 't-trace', prompt: '## Result\n\nThe trace tab is **finished**, see `trace.ts`.' });
      await client.settled();
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent).toEqual([{ title: 'Finish the trace tab', body: 'Result · The trace tab is finished, see trace.ts.', threadId: 't-trace', coreThreadId: 't-trace' }]);

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

  test('a pinned thread floats above the live ones of its project, and unpinning drops it back', async ({ store }) => {
    const project = store.threads.find((t) => t.id === 't-trace')?.projectId ?? '';
    const sorted = () => store.threadsOf(project).slice().sort(compareThreads).map((t) => t.id);
    const before = sorted();
    expect(before[0]).not.toBe('t-trace');

    await store.pin('t-trace', true);
    expect(store.threads.find((t) => t.id === 't-trace')?.pinned).toBe(true);
    expect(sorted()[0]).toBe('t-trace');

    await store.pin('t-trace', false);
    expect(sorted()).toEqual(before);
  });

  test('a prompt streams into one text part and the thread goes running then idle', async ({ store, client }) => {
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
      { type: 'thinking', text: 'thinking about: read the trace note', startedAt: expect.any(Number), finishedAt: expect.any(Number) },
      { type: 'text', text: 'read the trace note' }
    ]);
  });

  test('only the open thread streams, and the previous one is dropped', async ({ store, client }) => {
    await store.open('t-trace');
    await store.open('t-descriptors');

    const deltas: string[] = [];
    client.on('message.delta', (delta) => deltas.push(delta.threadId));

    await client.call('turns.start', { threadId: 't-trace', prompt: 'nobody is watching' });
    await client.settled();

    expect(deltas).toEqual([]);
    expect(store.threads.find((t) => t.id === 't-trace')?.unread).toBe(true);
  });

  test('a tool part and a permission part land in the open thread', async ({ store, client }) => {
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

  test('a project removed elsewhere drops it, its threads and the open thread', async ({ store, client }) => {
    await store.open('t-trace');
    expect(store.openThread?.projectId).toBe('p-boite');
    const gate = deferred(), started = deferred(), call = client.call.bind(client);
    const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
      const value = await call(method, params);
      if (method === 'projects.list') {
        started.resolve(); await gate.promise;
        // A folder state read before the project's newer update arrived.
        return (value as typeof store.projects).map(project => project.id === 'p-notes' ? { ...project, repository: false } : project) as never;
      }
      return value;
    });
    const refresh = store.refreshProjects();
    try {
      await started.promise;
      await client.call('projects.setWorktreeDefault', { projectId: 'p-notes', enabled: true });
      // Straight through the client, the way another connection's removal arrives.
      await client.call('projects.remove', { projectId: 'p-boite' });
      gate.resolve(); await refresh;
      expect(store.projects.map(p => p.id)).toEqual(['p-notes']);
      expect(store.projects[0]).toMatchObject({ repository: true, worktreeDefault: true });
      expect(store.threads.every(t => t.projectId !== 'p-boite')).toBe(true);
      const reopened = await waitFor(() => store.openThread ?? undefined);
      expect(reopened.projectId).toBe('p-notes');
    } finally { gate.resolve(); await refresh; spy.mockRestore(); }
  });

  test('cached models survive reload and remain visible during a forced refresh', async ({ ready }) => {
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
    const request = store.probeModels('opencode', 'a-opencode');
    expect(store.isProbing('opencode', 'a-opencode')).toBe(true);
    // A cached answer is an answer: the picker keeps it rather than reading again.
    expect(store.modelsPending('opencode', 'a-opencode')).toBe(false);
    expect(store.modelsOf('opencode', 'a-opencode')).toEqual(expected);
    const second = store.probeModels('opencode', 'a-opencode');
    expect(calls.mock.calls.filter(([method]) => method === 'providers.probe')).toHaveLength(1);
    release(); await Promise.all([request, second]);
    expect(calls).toHaveBeenCalledWith('providers.probe', { providerId: 'opencode', accountId: 'a-opencode', refresh: true });
  });

  test('opening a stale catalog refreshes its models without changing saved defaults', async ({ store, client }) => {
    const original = client.call.bind(client);
    let reads = 0;
    const calls = vi.spyOn(client, 'call').mockImplementation((method, params) => {
      if (method === 'providers.probe') return Promise.resolve({ models: [++reads === 1
        ? { id: 'vendor/old-model', name: 'Old model', legacy: true }
        : { id: 'vendor/new-model', name: 'New model' }], probedAt: Date.now() }) as never;
      return original(method, params);
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const defaults = { ...store.modelDefaults };
    await store.probeModels('opencode', 'a-opencode');
    await store.probeModels('opencode', 'a-opencode');
    expect(calls.mock.calls.filter(([method]) => method === 'providers.probe')).toHaveLength(1);
    expect(store.modelsOf('opencode', 'a-opencode')[0]?.legacy).toBe(true);
    clock.mockReturnValue(now + 5 * 60_000);
    await store.probeModels('opencode', 'a-opencode');
    expect(calls).toHaveBeenLastCalledWith('providers.probe', { providerId: 'opencode', accountId: 'a-opencode', refresh: true });
    expect(calls.mock.calls.filter(([method]) => method === 'providers.probe')).toHaveLength(2);
    expect(store.modelsOf('opencode', 'a-opencode')).toEqual([{ id: 'vendor/new-model', name: 'New model' }]);
    expect(store.modelDefaults).toEqual(defaults);
    clock.mockRestore();
  });

  test('failed probes wait for manual retry instead of looping', async ({ store, client }) => {
    const calls = vi.spyOn(client, 'call').mockRejectedValue(new Error('agent offline'));
    const models = store.modelsOf('opencode', 'a-opencode');
    await store.probeModels('opencode', 'a-opencode');
    await store.probeModels('opencode', 'a-opencode');
    expect(calls).toHaveBeenCalledTimes(1);
    expect(store.error).toBeNull();
    expect(store.modelsOf('opencode', 'a-opencode')).toEqual(models);
    expect(store.isProbing('opencode', 'a-opencode')).toBe(false);
    // Nothing answered, so the descriptor's list stands instead of a reading state forever.
    expect(store.modelsPending('opencode', 'a-opencode')).toBe(false);
    await store.probeModels('opencode', 'a-opencode', true);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(store.error).toBe('agent offline');
  });

  test('background model discovery skips signed-out accounts but a manual refresh can retry', async ({ store, client }) => {
    store.accounts = store.accounts.map(account => account.id === 'a-opencode' ? { ...account, status: 'unauthenticated' } : account);
    const calls = vi.spyOn(client, 'call').mockRejectedValue(new Error('sign in first'));
    await store.probeModels('opencode', 'a-opencode');
    expect(calls).not.toHaveBeenCalled();
    expect(store.error).toBeNull();
    await store.probeModels('opencode', 'a-opencode', true);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(store.error).toBe('sign in first');
  });

  test('a manual refresh joining background discovery reports its failure without spawning another probe', async ({ store, client }) => {
    let reject!: (error: Error) => void;
    const gate = new Promise<never>((_, fail) => { reject = fail; });
    const calls = vi.spyOn(client, 'call').mockReturnValue(gate);
    const background = store.probeModels('opencode', 'a-opencode');
    const manual = store.probeModels('opencode', 'a-opencode', true);
    expect(calls).toHaveBeenCalledTimes(1);
    reject(new Error('agent offline'));
    await Promise.all([background, manual]);
    expect(store.error).toBe('agent offline');
    expect(store.isProbing('opencode', 'a-opencode')).toBe(false);
  });

  test('a probe the core refused because the account changed meanwhile is no error, and runs again', async ({ store, client }) => {
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

  test('a probe elsewhere fills the models of that instance, the descriptor until then', async ({ store, client }) => {
    expect(store.modelsOf('opencode', 'a-opencode').map((m) => m.id)).toEqual(['default']);
    expect(store.probedModels).toEqual({});
    expect(store.modelsPending('opencode', 'a-opencode')).toBe(false);

    // Straight through the client: what a second shell's probe looks like here.
    // This store's own first probe is pending until either answer lands.
    const own = store.probeModels('opencode', 'a-opencode');
    expect(store.modelsPending('opencode', 'a-opencode')).toBe(true);
    await client.call('providers.probe', { providerId: 'opencode', accountId: 'a-opencode' });
    expect(store.modelsPending('opencode', 'a-opencode')).toBe(false);
    await own;

    expect(Object.keys(store.probedModels)).toEqual(['opencode::a-opencode']);
    const probed = store.modelsOf('opencode', 'a-opencode').map((m) => m.id);
    expect(probed.length).toBe(23);
    expect(probed.slice(0, 3)).toEqual(['default', 'anthropic/claude-sonnet-5', 'openai/gpt-5-codex']);
    // A provider that is not ACP keeps the descriptor's list either way.
    expect(store.modelsOf('echo', 'a-echo').map((m) => m.id)).toEqual(['echo-1']);
  });

  test('a long thread opens on its last page and loadOlder walks back in order', async ({ createStore }) => {
    const { client, store } = createStore({ delayMs: 0, long: true });
    store.attach(client);
    await store.connect();

    await store.open('t-long');

    // The first paint uses forty messages; history pages remain 120.
    expect(store.openThread?.messages).toHaveLength(40);
    expect(store.openThread?.messages.at(0)?.id).toBe('m-long-360');
    expect(store.openThread?.messages.at(-1)?.id).toBe('m-long-399');
    expect(store.messagesBefore).toBe('m-long-360');

    expect(await store.loadOlder()).toBe(120);
    expect(store.openThread?.messages).toHaveLength(160);
    expect(store.messagesBefore).toBe('m-long-240');

    expect(await store.loadOlder()).toBe(120);
    const messages = store.openThread?.messages ?? [];
    expect(messages).toHaveLength(280);
    expect(messages.at(0)?.id).toBe('m-long-120');
    expect(messages.at(-1)?.id).toBe('m-long-399');
    expect(store.messagesBefore).toBe('m-long-120');
    expect(store.loadingOlder).toBe(false);

    // In order, no gap, no duplicate.
    const numbers = messages.map((message) => Number(message.id.replace('m-long-', '')));
    expect(new Set(numbers).size).toBe(280);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers[0]).toBe(120);
  });

  test('loadOlder stops at the first message and does nothing without a cursor', async ({ createStore }) => {
    const { client, store } = createStore({ delayMs: 0, long: true });
    store.attach(client);
    await store.connect();
    await store.open('t-long');

    let rounds = 0;
    while (store.messagesBefore !== null) {
      await store.loadOlder();
      rounds += 1;
      if (rounds > 10) throw new Error('the cursor never reached the first message');
    }

    // 40 on open, then three ordinary pages of 120.
    expect(rounds).toBe(3);
    expect(store.openThread?.messages).toHaveLength(400);
    expect(store.openThread?.messages.at(0)?.id).toBe('m-long-0');
    expect(await store.loadOlder()).toBe(0);
  });

  test('a short thread opens whole, with no cursor to walk', async ({ store }) => {
    await store.open('t-trace');

    expect(store.messagesBefore).toBeNull();
    expect(await store.loadOlder()).toBe(0);
  });

  test('settings changed elsewhere replace the ones the UI holds', async ({ store, client }) => {
    expect(store.settings?.warmProcessMinutes).not.toBe(9);

    await client.call('settings.set', { warmProcessMinutes: 9 });

    expect(store.settings?.warmProcessMinutes).toBe(9);
  });

  test('the newest open wins, and the socket is left holding that thread alone', async ({ store, client }) => {
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

  test('a refused subscribe leaves the thread that was open subscribed', async ({ store, client }) => {
    await store.open('t-trace');

    // Archived elsewhere between the render and the click: the core refuses it.
    await store.open('t-gone');

    expect(store.error).toMatch(/no such thread/i);
    expect(store.openThread?.id).toBe('t-trace');
    expect(client.coreSubscribers).toEqual(['t-trace']);
    expect(client.clientSubscriptions).toEqual(['t-trace']);
  });

  test('a reconnect catches up the open thread first and keeps every sidebar row it can', async ({ store, client }) => {
    await store.open('t-scheduler');
    const rows = new Map(store.threads.map((row) => [row.id, row]));
    client.drop();
    // A load sample of the gap, which reached nobody.
    client.sampleLoad('t-bench', 3);
    const called = vi.spyOn(client, 'call');
    await client.restore();
    await waitFor(() => (store.threads.find((row) => row.id === 't-bench')?.load?.processes === 3 ? true : undefined));
    await store.reload();
    for (const row of store.threads) expect(row).toBe(rows.get(row.id));
    const methods = called.mock.calls.map(([method]) => method);
    expect(methods.indexOf('threads.get')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('threads.get')).toBeLessThan(methods.indexOf('threads.list'));
  });

  test('a list answer that lands after the open thread was read does not mark it unread again', async ({ store, client }) => {
    await store.open('t-scheduler');
    const real = client.call.bind(client);
    let listed: (() => void) | null = null;
    vi.spyOn(client, 'call').mockImplementation(((method: string, params: never) => {
      const answer = real(method as never, params);
      if (method !== 'threads.list') return answer;
      // Read by the core before the open thread's markRead, answered after it.
      return answer.then((threads) => new Promise((resolve) => {
        listed = () => resolve((threads as { id: string }[]).map((row) => (row.id === 't-scheduler' ? { ...row, unread: true } : row)) as never);
      }));
    }) as typeof client.call);
    client.drop();
    await client.restore();
    await waitFor(() => listed ?? undefined);
    listed!();
    await store.reload();
    expect(store.threads.find((row) => row.id === 't-scheduler')?.unread).toBe(false);
  });

  test('a request the core settled while the socket was down leaves the card', async ({ store, client }) => {
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

  test('a public address pasted from the address bar saves without an error', async ({ store }) => {
    await store.saveSettings({ publicUrl: 'https://boite.example.com/' });
    expect(store.error).toBeNull();
    expect(store.settings?.publicUrl).toBe('https://boite.example.com');
  });

  test('archiving a thread lets go of its panel, browser views, composer and terminal', async ({ store, client }) => {
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
    } finally { destroy.mockRestore(); }
  });

  test('a thread archived from another client drops its panel here too', async ({ store, client }) => {
    const [shown, other] = store.threads.filter((t) => t.status === 'idle' && !t.parentThreadId);
    await store.open(shown!.id);
    rightPanel.for(store.threadKey(other!.id)).open('trace');
    store.editComposerText(other!.id, 'draft');
    await client.call('threads.archive', { threadId: other!.id, archived: true });
    await waitFor(() => (rightPanel.threads[store.threadKey(other!.id)] === undefined ? true : undefined));
    expect(store.composerStates[other!.id]).toBeUndefined();
  });

  test.for(['manual', 'pr-merged'] as const)('the open archived thread releases reading state and preserves automatic archive input: %s', async (reason, { store, client }) => {
    const destroy = vi.spyOn(browserBridge, 'destroy');
    try {
      const [shown, next] = store.threads.filter((t) => t.status === 'idle' && !t.parentThreadId);
      await store.open(shown!.id);
      const key = store.threadKey(shown!.id);
      const view = store.panel.open('browser');
      const file = store.panel.openFile('src/index.ts');
      store.panel.keepDraft(file.id, 'unsaved edit');
      store.editComposerText(shown!.id, 'unsent prompt');
      await client.call('threads.archive', { threadId: shown!.id, archived: true });
      await waitFor(() => (store.openThread?.archived ? true : undefined));

      client.drop();
      await client.restore();
      await store.reload();
      expect(store.openThread?.id).toBe(shown!.id);
      expect(rightPanel.threads[key]?.surfaces.map((surface) => surface.id)).toEqual([view.id, file.id]);
      expect(store.panel.draft(file.id)).toBe('unsaved edit');
      expect(destroy).not.toHaveBeenCalled();

      // The reason can first arrive on reconnect after an offline automatic archive.
      if (reason === 'pr-merged') store.openThread!.archiveReason = { type: 'pr-merged' } as never;
      await store.open(next!.id);
      if (reason === 'pr-merged') {
        expect(rightPanel.threads[key]).toBeDefined();
        expect(rightPanel.drafts.get(key)?.get(file.id)).toBe('unsaved edit');
        expect(store.composerStates[shown!.id]).toMatchObject({ text: 'unsent prompt', paused: true });
        expect(destroy).not.toHaveBeenCalled();
      } else {
        expect(rightPanel.threads[key]).toBeUndefined();
        expect(rightPanel.drafts.has(key)).toBe(false);
        expect(store.composerStates[shown!.id]).toBeUndefined();
        expect(destroy.mock.calls.map(([id]) => id)).toEqual([view.id]);
      }
    } finally { destroy.mockRestore(); }
  });

  test('a draft started over an open thread archived elsewhere lets its panel go', async ({ store, client }) => {
    const shown = store.threads.find((t) => t.status === 'idle' && !t.parentThreadId)!;
    await store.open(shown.id);
    store.panel.open('trace');
    await client.call('threads.archive', { threadId: shown.id, archived: true });
    await waitFor(() => (store.openThread?.archived ? true : undefined));
    expect(rightPanel.threads[store.threadKey(shown.id)]).toBeDefined();
    store.startDraft();
    expect(rightPanel.threads[store.threadKey(shown.id)]).toBeUndefined();
  });

  test('a reload drops the layouts of threads its core no longer lists, and only its own', async ({ store, client }) => {
    try {
      store.machineId = 'http://a.test';
      const live = store.threads[0]!.id;
      rightPanel.for(store.threadKey(live)).open('trace');
      rightPanel.for(store.threadKey('t-archived-long-ago')).open('trace');
      const editing = store.threadKey('t-offline-autoarchived');
      rightPanel.for(editing).open('files');
      rightPanel.for(editing).keepDraft('file:/project/unsaved.txt', 'Unsent editor changes');
      rightPanel.for(JSON.stringify(['http://b.test', 't-archived-long-ago'])).open('trace');
      await store.reload();
      expect(rightPanel.threads[store.threadKey(live)]).toBeDefined();
      expect(rightPanel.threads[store.threadKey('t-archived-long-ago')]).toBeUndefined();
      expect(rightPanel.threads[editing]).toBeDefined();
      expect(rightPanel.for(editing).draft('file:/project/unsaved.txt')).toBe('Unsent editor changes');
      expect(rightPanel.threads[JSON.stringify(['http://b.test', 't-archived-long-ago'])]).toBeDefined();
    } finally {
      rightPanel.forget(store.threadKey('t-offline-autoarchived'));
      rightPanel.forget(JSON.stringify(['http://b.test', 't-archived-long-ago']));

    }
  });

  test('an answer sent while the socket is down says so and can be sent again', async ({ store, client }) => {
    await store.open('t-scheduler');
    client.drop();
    expect(await store.answerQuestion('t-scheduler', 'qst-seed-1', ['short'])).toBe(false);
    expect(store.pendingQuestions.map((q) => q.id)).toEqual(['qst-seed-1']);
    expect(store.error).toBeTruthy();

    await client.restore();
    expect(await store.answerQuestion('t-scheduler', 'qst-seed-1', ['short'])).toBe(true);
    expect(store.pendingQuestions).toEqual([]);
  });

  test('a thread removed elsewhere lets its subscription go before the next one is taken', async ({ store, client }) => {
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

  test('opening the thread already held asks only for what is past its last message, and keeps the rest', async ({ store, client }) => {
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

  test('a boot loads the core once, not twice', async ({ createStore }) => {
    const { client, store } = createStore({ delayMs: 0 });
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

test('account lifecycle reload preserves the running login snapshot', async ({ store, client }) => {
  await client.call('accounts.login', { accountId: 'a-claude-side' });
  await waitFor(() => store.logins['a-claude-side']?.url ?? undefined);
  const before = { ...store.logins['a-claude-side'] };
  await store.reload();
  expect(store.logins['a-claude-side']).toEqual(before);
});

test('account lifecycle refuses removal of an account referenced by an archived thread', async ({ client }) => {
  await client.call('threads.archive', { threadId: 't-trace', archived: true });
  await expect(client.call('accounts.remove', { accountId: 'a-echo' })).rejects.toThrow(/thread/i);
  expect((await client.call('accounts.list', {})).some((a) => a.id === 'a-echo')).toBe(true);
});

test('account lifecycle cancellation removes the login and permits retry', async ({ store, client }) => {
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

test('account lifecycle fake rejects unsupported login and enforces provider isolation', async ({ client }) => {
  await expect(client.call('accounts.login', { accountId: 'a-echo' })).rejects.toThrow(/login is not available/i);
  const account = await client.call('accounts.add', {
    providerId: 'antigravity', label: 'isolated only', useDefaultLocation: true
  });
  expect(account.isolationDir).toBeTruthy();
});

test('account lifecycle newer cancellation beats a stale reload snapshot', async ({ store, client }) => {
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

test('closing a pairing link discards a pending replacement from the same core', async ({ store, client }) => {
  await store.mintPairing();
  const call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'pairing.grant') await gate;
    return result;
  });
  try {
    const pending = store.mintPairing();
    store.closePairing();
    release();
    await pending;
    expect(store.pairing).toBeNull();
  } finally { release(); spy.mockRestore(); }
});

test('replacing a machine endpoint clears its previous pairing link before connecting', async ({ store, client }) => {
  await store.mintPairing();
  expect(store.pairing).not.toBeNull();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const connect = vi.spyOn(store, 'connect').mockReturnValue(gate);
  let connecting: Promise<void> | undefined;
  try {
    connecting = store.connectEndpoint({ url: 'https://replacement.test', token: 'fixture-token', paired: true });
    expect(store.pairing).toBeNull();
    release();
    await connecting;
    expect(store.pairing).toBeNull();
  } finally {
    release();
    await connecting;
    connect.mockRestore();
    store.client?.close(); store.detach(); client.close();
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
