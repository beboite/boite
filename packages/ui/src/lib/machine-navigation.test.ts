import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Prose from '../components/Prose.svelte';
import CommandPalette from '../components/CommandPalette.svelte';
import DraftRow from '../components/DraftRow.svelte';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';
import { fakeCore } from './fake-client/coordination';
import { workspace } from './workspace.svelte';
import { setExperiment } from './experiments';
import { RpcFailure } from './client';
import { RpcErrorCode } from '@boite/contracts';
import { strings } from './strings';

let running: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (running) await unmount(running, { outro: false });
  running = undefined;
  workspace.close();
  setExperiment('resident-agents', false);
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

async function setup() {
  const ca = new FakeClient({ delayMs: 0, coreId: 'a'.repeat(64) });
  const cb = new FakeClient({ delayMs: 0, coreId: 'b'.repeat(64) });
  const a = new Store(), b = new Store();
  a.attach(ca); b.attach(cb);
  a.machineId = 'local'; b.machineId = 'remote';
  a.visible = true; b.visible = false;
  await Promise.all([a.connect(), b.connect()]);
  workspace.machines = [{ id: 'local', label: 'Local', store: a }, { id: 'remote', label: 'Remote', store: b }];
  workspace.active = a;
  await a.open('t-trace');
  return { a, b, ca, cb };
}

async function thread(client: FakeClient, store: Store, id: string, archived = false) {
  const ctx = fakeCore(client.core!.coreId!)!;
  ctx.threads.set(id, { ...structuredClone(ctx.thread('t-trace')), id, title: id,
    archived, turns: [], messages: [] });
  await store.reload();
}

function link(owner: Store, address: string) {
  running = mount(Prose, { target: document.body, props: { text: `[target](${address})`, store: owner, threadId: 't-trace' } });
  flushSync();
  const anchor = document.querySelector<HTMLAnchorElement>('a[data-thread-address]')!;
  expect(anchor).not.toBeNull();
  anchor.click();
}

async function palette(store: Store, target: Store, id: string) {
  running = mount(CommandPalette, { target: document.body, props: { store } });
  store.paletteOpen = true;
  flushSync();
  await tick();
  const row = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-palette-id]'))
    .find(row => row.dataset.paletteId === `thread:${target.threadKey(id)}`);
  expect(row).toBeDefined();
  row!.click();
  await vi.waitFor(() => {
    expect(workspace.active).toBe(target);
    expect(target.openThread?.id).toBe(id);
  });
}

const targetId = 'thr_archive12345678';
test.each(['', 'here/'])('rendered %sarchive links open on their owner despite an active remote collision', async prefix => {
  const { a, b, ca, cb } = await setup();
  await thread(ca, a, targetId, true);
  await thread(cb, b, targetId);
  expect(a.threads.some(row => row.id === targetId)).toBe(false);
  const remote = vi.spyOn(cb, 'call');
  link(a, prefix + targetId);
  await vi.waitFor(() => expect(a.openThread?.id).toBe(targetId));
  expect(workspace.active).toBe(a);
  expect(a.openThread?.archived).toBe(true);
  expect(a.error).toBeNull();
  expect(remote).not.toHaveBeenCalled();
});

test.each(['remote', 'b'.repeat(64)])('a rendered archive link explicitly naming %s selects that authenticated machine', async name => {
  const { a, b, cb } = await setup();
  await thread(cb, b, targetId, true);
  const source = vi.spyOn(a.client!, 'call');
  link(a, `${name}/${targetId}`);
  await vi.waitFor(() => expect(b.openThread?.id).toBe(targetId));
  expect(workspace.active).toBe(b);
  expect(source.mock.calls.filter(([method]) => method === 'threads.get')).toHaveLength(0);
});

test.each([{ name: 'remote', archived: false }, { name: 'b'.repeat(64), archived: true }])(
  'a disconnected source can open an explicit ready target ($name, archived=$archived)',
  async ({ name, archived }) => {
    const { a, b, ca, cb } = await setup();
    await thread(cb, b, targetId, archived);
    ca.drop();
    expect(a.connection).toBe('connecting');
    expect(a.openThread?.id).toBe('t-trace');
    const source = vi.spyOn(ca, 'call');
    link(a, `${name}/${targetId}`);
    await vi.waitFor(() => expect(b.openThread?.id).toBe(targetId));
    expect(workspace.active).toBe(b);
    expect(b.openThread?.archived).toBe(archived);
    expect(a.error).toBeNull();
    // Selecting B retires A's subscription; the offline client rejects that local cleanup before transport.
    expect(source.mock.calls.filter(([method]) => method !== 'threads.unsubscribe')).toHaveLength(0);
  }
);

test('a disconnected contextual owner does not probe or substitute a remote collision', async () => {
  const { a, b, ca, cb } = await setup();
  await thread(cb, b, targetId);
  ca.drop();
  const source = vi.spyOn(ca, 'call'), remote = vi.spyOn(cb, 'call');
  await workspace.openThreadLink(a, 't-trace', null, targetId);
  expect(workspace.active).toBe(a);
  expect(a.openThread?.id).toBe('t-trace');
  expect(a.error).toBeNull();
  expect(source).not.toHaveBeenCalled();
  expect(remote).not.toHaveBeenCalled();
});

test('an unconnected named machine never falls back to the only local holder', async () => {
  const { a, ca } = await setup();
  await thread(ca, a, targetId);
  link(a, `unconnected/${targetId}`);
  await vi.waitFor(() => expect(a.error).toBe(strings.agentMessages.threadMissing));
  expect(a.openThread?.id).toBe('t-trace');
});

test('a named owner with an absent id never opens another machine with that id', async () => {
  const { a, b, ca } = await setup();
  await thread(ca, a, targetId);
  const call = ca.call.bind(ca);
  vi.spyOn(ca, 'call').mockImplementation(async (method, params) => method === 'collaboration.directory'
    ? { agents: [{ coreId: ca.core!.coreId!, threadId: targetId, machine: 'Remote' }], unavailable: [] } as never
    : call(method, params));
  link(a, `remote/${targetId}`);
  await vi.waitFor(() => expect(a.error).toBe(strings.agentMessages.threadMissing));
  expect(workspace.active).toBe(a);
  expect(a.openThread?.id).toBe('t-trace');
  expect(b.openThread).toBeNull();
});

test('an active local link opens normally and a truly absent id remains refused', async () => {
  const { a, ca } = await setup();
  await thread(ca, a, targetId);
  link(a, targetId);
  await vi.waitFor(() => expect(a.openThread?.id).toBe(targetId));
  await workspace.openThreadLink(a, targetId, null, 'thr_missing12345678');
  expect(a.error).toBe(strings.agentMessages.threadMissing);
  expect(a.openThread?.id).toBe(targetId);
});

test('a refused local read does not open a coincident remote id', async () => {
  const { a, b, ca, cb } = await setup();
  await thread(cb, b, targetId);
  const call = ca.call.bind(ca);
  vi.spyOn(ca, 'call').mockImplementation(async (method, params) => {
    if (method === 'threads.get' && (params as { threadId?: string }).threadId === targetId)
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'synthetic scope refusal' });
    return call(method, params);
  });
  await workspace.openThreadLink(a, 't-trace', null, targetId);
  expect(workspace.active).toBe(a);
  expect(a.openThread?.id).toBe('t-trace');
  expect(a.error).toBe('synthetic scope refusal');
});

test.each(['thread', 'draft', 'machine'] as const)('a delayed archive resolution cannot replace newer %s navigation', async next => {
  const { a, b, ca } = await setup();
  await thread(ca, a, targetId, true);
  const call = ca.call.bind(ca);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reading = false;
  vi.spyOn(ca, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'threads.get' && (params as { threadId?: string }).threadId === targetId) { reading = true; await gate; }
    return result;
  });
  const opening = workspace.openThreadLink(a, 't-trace', null, targetId);
  try {
    await vi.waitFor(() => expect(reading).toBe(true));
    if (next === 'thread') await a.open('t-scheduler');
    else if (next === 'draft') a.startDraft(null, { fresh: true });
    else await workspace.select(b, 't-descriptors');
    release();
    await opening;
    expect(workspace.active).toBe(next === 'machine' ? b : a);
    expect(a.openThread?.id ?? null).toBe(next === 'thread' ? 't-scheduler' : next === 'draft' ? null : 't-trace');
    expect(a.error).toBeNull();
  } finally { release(); await opening; }
});

test.each(['current', 'thread', 'draft', 'machine', 'disconnection'] as const)(
  'a delayed local NotFound only selects a still-ready sole holder after %s navigation', async next => {
    const { a, b, ca, cb } = await setup();
    await thread(cb, b, targetId);
    const call = ca.call.bind(ca);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reading = false;
    vi.spyOn(ca, 'call').mockImplementation(async (method, params) => {
      if (method === 'threads.get' && (params as { threadId?: string }).threadId === targetId) {
        reading = true;
        await gate;
      }
      return call(method, params);
    });
    const opening = workspace.openThreadLink(a, undefined, null, targetId);
    try {
      await vi.waitFor(() => expect(reading).toBe(true));
      if (next === 'thread') await a.open('t-scheduler');
      else if (next === 'draft') {
        a.startDraft('p-boite', { fresh: true });
        a.editComposerText('draft', 'A newer draft');
        a.composerStates.draft!.attachments = [{ kind: 'file', name: 'notes.txt', mimeType: 'text/plain',
          data: btoa('draft attachment') }];
      } else if (next === 'machine') await workspace.select(b, 't-descriptors');
      else if (next === 'disconnection') cb.drop();
      const remote = vi.spyOn(cb, 'call');
      release();
      await opening;
      expect(workspace.active).toBe(next === 'current' || next === 'machine' ? b : a);
      expect(a.openThread?.id ?? null).toBe(next === 'thread' ? 't-scheduler' : next === 'draft' ? null : 't-trace');
      expect(b.openThread?.id ?? null).toBe(next === 'current' ? targetId : next === 'machine' ? 't-descriptors' : null);
      expect(a.error).toBe(next === 'disconnection' ? strings.agentMessages.threadMissing : null);
      if (next !== 'current') expect(remote).not.toHaveBeenCalled();
      if (next === 'draft') {
        expect(a.composerStates.draft?.text).toBe('A newer draft');
        expect(a.composerStates.draft?.attachments).toMatchObject([{ name: 'notes.txt', data: btoa('draft attachment') }]);
      }
    } finally { release(); await opening; }
  }
);

test.each(['agents', 'settings'] as const)('palette remote selection leaves source %s history untouched', async page => {
  setExperiment('resident-agents', true);
  const { a, b, ca } = await setup();
  const ctx = fakeCore(ca.core!.coreId!)!;
  const id = 'thr_agent123456789';
  ctx.threads.set(id, { ...structuredClone(ctx.thread('t-trace')), id,
    agentSessionId: 'synthetic-agent', projectId: null, messages: [], turns: [] });
  await a.reload();
  await a.open(id);
  if (page === 'agents') a.showAgents();
  else a.showSettings('accounts');
  const source = vi.spyOn(ca, 'call');
  await palette(a, b, 't-descriptors');
  expect(source.mock.calls.filter(([method]) => method === 'threads.get')).toHaveLength(0);
  expect(a.page).toBe(page);
  expect(a.openThread?.id).toBe(id);
});

test.each([{ remote: true, projectId: 'p-boite', agent: true }, { remote: true, projectId: null, agent: false }, { remote: false, projectId: 'p-boite', agent: false }])(
  'draft selection keeps its id, text, file and project ($projectId, remote=$remote) without opening an abandoned thread',
  async ({ remote, projectId, agent }) => {
    setExperiment('resident-agents', true);
    const { a, b, cb } = await setup();
    await b.open('t-descriptors');
    const oldId = agent ? 'thr_agent123456789' : 't-descriptors';
    if (agent) {
      const ctx = fakeCore(cb.core!.coreId!)!;
      ctx.threads.set(oldId, { ...structuredClone(ctx.thread('t-trace')), id: oldId,
        agentSessionId: 'synthetic-agent', projectId: null, messages: [], turns: [] });
      await b.reload();
    }
    b.startDraft(projectId, { fresh: true });
    const attachment = { kind: 'file' as const, name: 'notes.txt', mimeType: 'text/plain', data: btoa('draft attachment'), size: 16 };
    b.editComposerText('draft', 'Draft with a file');
    b.composerStates.draft!.attachments = [attachment];
    const id = b.draft!.id!;
    await b.open(oldId);
    if (!remote) await workspace.select(b);
    const entry = b.draftEntries.find(row => row.id === id)!;
    expect(entry).toBeDefined();
    const onopen = vi.fn();
    running = mount(DraftRow, { target: document.body, props: { owner: b, entry, onopen } });
    flushSync();
    const target = vi.spyOn(cb, 'call');
    document.querySelector<HTMLButtonElement>('[data-testid=draft-row]')!.click();
    await vi.waitFor(() => expect(onopen).toHaveBeenCalledOnce());
    expect(workspace.active).toBe(b);
    expect(b.openThread).toBeNull();
    expect(b.draft).toMatchObject({ id, projectId });
    expect(b.composerStates.draft?.text).toBe('Draft with a file');
    expect(b.composerStates.draft?.attachments).toEqual([attachment]);
    expect(target.mock.calls.filter(([method]) => method === 'threads.get')).toHaveLength(0);
    expect(a.openThread?.id).toBe('t-trace');
  }
);

test('ordinary machine selection still restores its previous thread', async () => {
  const { b, cb } = await setup();
  await b.open('t-descriptors');
  const target = vi.spyOn(cb, 'call');
  await workspace.select(b);
  expect(workspace.active).toBe(b);
  expect(b.openThread?.id).toBe('t-descriptors');
  expect(target.mock.calls.filter(([method]) => method === 'threads.get')).toHaveLength(1);
});

test('duplicate machine labels cannot select a different holder of the same id', async () => {
  const { a, b, ca, cb } = await setup();
  await thread(ca, a, targetId, true);
  await thread(cb, b, targetId);
  workspace.machines = workspace.machines.map(machine => ({ ...machine, label: 'Shared name' }));
  link(a, `shared-name/${targetId}`);
  await vi.waitFor(() => expect(a.error).toBe(strings.agentMessages.threadMissing));
  expect(workspace.active).toBe(a);
  expect(a.openThread?.id).toBe('t-trace');
});

test('an archive rendered by a background owner opens there, not on the active machine', async () => {
  const { a, b, ca, cb } = await setup();
  await thread(ca, a, targetId, true);
  await thread(cb, b, targetId);
  await workspace.select(b, 't-descriptors');
  link(a, targetId);
  await vi.waitFor(() => expect(a.openThread?.id).toBe(targetId));
  expect(workspace.active).toBe(a);
  expect(a.openThread?.archived).toBe(true);
});

test.each(['draft', 'disconnection'] as const)('a delayed coordination address is cancelled by source %s', async next => {
  const { a, b, ca, cb } = await setup();
  await thread(cb, b, targetId, true);
  const call = ca.call.bind(ca);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reading = false;
  vi.spyOn(ca, 'call').mockImplementation(async (method, params) => {
    if (method === 'collaboration.directory') {
      reading = true;
      await gate;
      return { agents: [{ coreId: cb.core!.coreId!, threadId: targetId, machine: 'Far PC' }], unavailable: [] } as never;
    }
    return call(method, params);
  });
  const opening = workspace.openThreadLink(a, 't-trace', 'far-pc', targetId);
  try {
    await vi.waitFor(() => expect(reading).toBe(true));
    if (next === 'draft') {
      a.startDraft('p-boite', { fresh: true });
      a.editComposerText('draft', 'A newer draft');
    } else ca.drop();
    release();
    await opening;
    expect(workspace.active).toBe(a);
    expect(a.openThread?.id ?? null).toBe(next === 'draft' ? null : 't-trace');
    if (next === 'draft') expect(a.composerStates.draft?.text).toBe('A newer draft');
    expect(a.error).toBeNull();
  } finally { release(); await opening; }
});

test('a local palette target exits settings without reloading the previous chat', async () => {
  setExperiment('resident-agents', true);
  const { a, ca } = await setup();
  const id = 'thr_agent123456789';
  const ctx = fakeCore(ca.core!.coreId!)!;
  ctx.threads.set(id, { ...structuredClone(ctx.thread('t-trace')), id,
    agentSessionId: 'synthetic-agent', projectId: null, messages: [], turns: [] });
  await a.reload();
  await a.open(id);
  a.showSettings('accounts');
  const source = vi.spyOn(ca, 'call');
  await palette(a, a, 't-descriptors');
  expect(a.page).toBe('chat');
  const gets = source.mock.calls.filter(([method]) => method === 'threads.get');
  expect(gets).toHaveLength(1);
  expect(gets[0]![1]).toMatchObject({ threadId: 't-descriptors' });
});
